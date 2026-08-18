import { beforeEach, describe, expect, it } from 'vitest';

import type { CrmContext } from '../auth/context';
import { createCustomerService, type CaseOwnerRow, type CustomerRepository } from './service';

const baseUser: CrmContext = {
  email: 'sales@automationsystems.org',
  name: 'Sales User',
  role: 'L2',
  allowedTags: ['Punjab'],
  active: true
};

type CustomerRow = Awaited<ReturnType<CustomerRepository['listCustomers']>>[number];
type ContactRow = Awaited<ReturnType<CustomerRepository['listContactsByCustomer']>>[number];
type HandlerRow = Awaited<ReturnType<CustomerRepository['listHandlers']>>[number];
type UserRow = Awaited<ReturnType<CustomerRepository['listUsers']>>[number];

class FakeCustomerRepository implements CustomerRepository {
  customers: CustomerRow[] = [];
  contacts: ContactRow[] = [];
  handlers: HandlerRow[] = [];
  users: UserRow[] = [];
  casesByCustomerId = new Map<string, number>();
  quotesByCustomerId = new Map<string, number>();
  cases: Awaited<ReturnType<CustomerRepository['listCasesByCustomer']>> = [];
  quotes: Awaited<ReturnType<CustomerRepository['listQuotesByCustomer']>> = [];
  lockedNames: string[] = [];
  caseOwnerRows: CaseOwnerRow[] = [];
  caseWrites: Array<{ caseId: string; extraOwners: string[] }> = [];
  settings: Record<string, string> = {};
  recycleBin: CustomerRow[] = [];
  logs: Array<{ action: string; entity: string; customerId: string; details: string; who: string }> = [];
  nextCustomer = 1;
  nextContact = 1;

  async withTransaction<T>(fn: () => Promise<T>): Promise<T> {
    return fn();
  }

  async lockCustomerName(name: string): Promise<void> {
    this.lockedNames.push(name.trim().toLowerCase().replace(/\s+/g, ' '));
  }

  async nextCustomerId(): Promise<string> {
    return `CUST-${String(this.nextCustomer++).padStart(4, '0')}`;
  }

  async nextContactId(): Promise<string> {
    return `CT-${String(this.nextContact++).padStart(4, '0')}`;
  }

  async listCustomers(): Promise<CustomerRow[]> {
    return this.customers;
  }

  async getCustomer(id: string): Promise<CustomerRow | null> {
    return this.customers.find((customer) => customer.id === id) ?? null;
  }

  async findCustomerByName(name: string): Promise<CustomerRow | null> {
    const key = name.trim().toLowerCase();
    return this.customers.find((customer) => customer.name.trim().toLowerCase() === key) ?? null;
  }

  async createCustomer(customer: CustomerRow): Promise<void> {
    this.customers.push(customer);
  }

  async updateCustomer(id: string, fields: Partial<CustomerRow>): Promise<void> {
    const customer = await this.getCustomer(id);
    if (!customer) throw new Error('missing test customer');
    Object.assign(customer, fields);
  }

  async deleteCustomer(id: string): Promise<void> {
    this.customers = this.customers.filter((customer) => customer.id !== id);
    this.contacts = this.contacts.filter((contact) => contact.customerId !== id);
    this.handlers = this.handlers.filter((handler) => handler.customerId !== id);
  }

  async moveCustomerToRecycleBin(customer: CustomerRow, deletedBy: string): Promise<void> {
    this.recycleBin.push({ ...customer, status: 'Archived', deletedBy, deletedAt: 'now' });
  }

  async listContactsByCustomer(customerId: string): Promise<ContactRow[]> {
    return this.contacts.filter((contact) => contact.customerId === customerId);
  }

  async listCasesByCustomer(customerId: string): Promise<Awaited<ReturnType<CustomerRepository['listCasesByCustomer']>>> {
    return this.cases.filter((row) => row.customerId === customerId);
  }

  async listQuotesByCustomer(customerId: string): Promise<Awaited<ReturnType<CustomerRepository['listQuotesByCustomer']>>> {
    return this.quotes.filter((row) => row.customerId === customerId);
  }

  async countContactsByCustomer(): Promise<Record<string, number>> {
    return this.contacts.reduce<Record<string, number>>((counts, contact) => {
      counts[contact.customerId] = (counts[contact.customerId] ?? 0) + 1;
      return counts;
    }, {});
  }

  async getContact(contactId: string): Promise<ContactRow | null> {
    return this.contacts.find((contact) => contact.id === contactId) ?? null;
  }

  async createContact(contact: ContactRow): Promise<void> {
    this.contacts.push(contact);
  }

  async updateContact(contactId: string, fields: Partial<ContactRow>): Promise<void> {
    const contact = await this.getContact(contactId);
    if (!contact) throw new Error('missing test contact');
    Object.assign(contact, fields);
  }

  async deleteContact(contactId: string): Promise<void> {
    this.contacts = this.contacts.filter((contact) => contact.id !== contactId);
  }

  async listHandlers(): Promise<HandlerRow[]> {
    return this.handlers;
  }

  async addHandler(handler: HandlerRow): Promise<void> {
    this.handlers.push(handler);
  }

  async removeHandler(customerId: string, email: string): Promise<void> {
    this.handlers = this.handlers.filter(
      (handler) => !(handler.customerId === customerId && handler.email === email)
    );
  }

  async removeDirectHandlers(customerId: string): Promise<void> {
    this.handlers = this.handlers.filter(
      (handler) => !(handler.customerId === customerId && handler.email === 'direct')
    );
  }

  async listCaseOwnerRows(customerId: string): Promise<CaseOwnerRow[]> {
    return this.caseOwnerRows.filter((row) => row.customerId === customerId);
  }

  async setCaseExtraOwners(caseId: string, extraOwners: string[]): Promise<void> {
    const row = this.caseOwnerRows.find((item) => item.id === caseId);
    if (!row) throw new Error('missing test case');
    row.extraOwners = extraOwners;
    this.caseWrites.push({ caseId, extraOwners });
  }

  async getSetting(key: string): Promise<string | null> {
    return this.settings[key] ?? null;
  }

  async listUsers(): Promise<UserRow[]> {
    return this.users;
  }

  async hasCases(customerId: string): Promise<boolean> {
    return (this.casesByCustomerId.get(customerId) ?? 0) > 0;
  }

  async hasQuotations(customerId: string): Promise<boolean> {
    return (this.quotesByCustomerId.get(customerId) ?? 0) > 0;
  }

  async logActivity(entry: {
    action: string;
    entity: string;
    customerId: string;
    details: string;
    who: string;
  }): Promise<void> {
    this.logs.push(entry);
  }
}

function customer(overrides: Partial<CustomerRow> = {}): CustomerRow {
  return {
    id: 'CUST-0001',
    name: 'Alpha Panels',
    tags: ['Punjab'],
    type: 'OEM',
    priority: 'High',
    area: 'Ludhiana',
    address: '',
    gstin: '',
    website: '',
    notes: '',
    sei: [],
    remarks: '',
    status: 'Active',
    createdBy: 'sales@automationsystems.org',
    createdAt: '2026-07-29T00:00:00.000Z',
    updatedAt: '2026-07-29T00:00:00.000Z',
    ...overrides
  };
}

function user(overrides: Partial<UserRow> = {}): UserRow {
  return {
    email: 'target@automationsystems.org',
    name: 'Target User',
    role: 'L2',
    allowedTags: ['Punjab'],
    active: true,
    ...overrides
  };
}

function makeService(repo = new FakeCustomerRepository()) {
  repo.users = [
    user({ email: 'sales@automationsystems.org', name: 'Sales User' }),
    user({ email: 'manager@automationsystems.org', name: 'Manager User', role: 'L3' }),
    user({ email: 'backend@automationsystems.org', name: 'Backend User', role: 'L5' }),
    user()
  ];

  return { repo, service: createCustomerService(repo) };
}

describe('customer service search and grids', () => {
  it('caps customer search at 80 visible results and hides unauthorized customers', async () => {
    const { repo, service } = makeService();
    repo.customers = Array.from({ length: 90 }, (_, index) =>
      customer({
        id: `CUST-${String(index + 1).padStart(4, '0')}`,
        name: `Punjab Account ${String(index + 1).padStart(3, '0')}`
      })
    );
    repo.customers.push(customer({ id: 'CUST-9999', name: 'NCR Account', tags: ['NCR'] }));

    const results = await service.searchCustomers(baseUser, 'account');

    expect(results).toHaveLength(80);
    expect(results.every((item) => item.name.startsWith('Punjab Account'))).toBe(true);
  });

  it('returns name-only search results without area for L2 tag matches', async () => {
    const { repo, service } = makeService();
    repo.customers = [customer()];

    const [result] = await service.searchCustomers(baseUser, 'alpha');

    expect(result).toMatchObject({ id: 'CUST-0001', access: 'NAME' });
    expect(result).not.toHaveProperty('area');
  });

  it('caps my customer grid at 400 handled active customers with metadata', async () => {
    const { repo, service } = makeService();
    repo.customers = Array.from({ length: 405 }, (_, index) =>
      customer({
        id: `CUST-${String(index + 1).padStart(4, '0')}`,
        name: `Handled ${String(index + 1).padStart(3, '0')}`
      })
    );
    repo.handlers = repo.customers.map((row) => ({
      customerId: row.id,
      email: baseUser.email,
      assignedBy: baseUser.email,
      assignedAt: 'now'
    }));

    const result = await service.myCustomers(baseUser);

    expect(result.scope).toBe('mine');
    expect(result.total).toBe(405);
    expect(result.customers).toHaveLength(400);
    expect(result.canEditPriority).toBe(true);
    expect(result.canEditClass).toBe(false);
  });
});

describe('customer service mutations', () => {
  it('returns full customer detail with contacts, cases, and quotation summaries', async () => {
    const { repo, service } = makeService();
    repo.customers = [customer()];
    repo.handlers = [{ customerId: 'CUST-0001', email: baseUser.email, assignedBy: baseUser.email, assignedAt: 'now' }];
    repo.contacts = [{ id: 'CT-0001', customerId: 'CUST-0001', name: 'Buyer', designation: '', phone: '', email: '', notes: '' }];
    repo.cases = [
      {
        id: 'CASE-2026-0001',
        customerId: 'CUST-0001',
        title: 'Panel upgrade',
        stage: 'Opportunity',
        priority: '',
        outcome: '',
        orderValue: '',
        quotedValue: 1180,
        owners: [baseUser.email],
        assignee: baseUser.email,
        updatedAt: '2026-07-29T00:00:00.000Z'
      }
    ];
    repo.quotes = [
      {
        quoteNo: 'QTN-2026-0001',
        rev: 0,
        caseId: 'CASE-2026-0001',
        customerId: 'CUST-0001',
        title: 'Panel quotation',
        source: 'Generated',
        status: 'Draft',
        total: 1180,
        currency: 'INR',
        fileName: '',
        doc: '/api/download/quote/QTN-2026-0001/0?format=html',
        pdf: '/api/download/quote/QTN-2026-0001/0?format=html',
        createdAt: '2026-07-29T00:00:00.000Z'
      }
    ];

    const result = await service.getCustomer(baseUser, 'CUST-0001');

    expect(result).toMatchObject({
      access: 'FULL',
      contacts: [expect.objectContaining({ id: 'CT-0001' })],
      cases: [expect.objectContaining({ id: 'CASE-2026-0001', quotedValue: 1180 })],
      quotes: [expect.objectContaining({ quoteNo: 'QTN-2026-0001', total: 1180 })]
    });
  });

  it('carries each case priority into the customer detail payload', async () => {
    const { repo, service } = makeService();
    repo.customers = [customer()];
    repo.handlers = [{ customerId: 'CUST-0001', email: baseUser.email, assignedBy: baseUser.email, assignedAt: 'now' }];
    repo.contacts = [];
    repo.cases = [
      {
        id: 'CASE-2026-0001',
        customerId: 'CUST-0001',
        title: 'Panel fault',
        stage: 'Lead',
        priority: 'High',
        outcome: '',
        orderValue: '',
        quotedValue: '',
        owners: [baseUser.email],
        assignee: baseUser.email,
        updatedAt: '2026-07-01T00:00:00.000Z'
      }
    ];

    const detail = await service.getCustomer(baseUser, 'CUST-0001');
    if (detail.access !== 'FULL') throw new Error('expected FULL access');

    expect(detail.cases[0].priority).toBe('High');
  });

  it('P7: requires at least one location on create and refuses to empty it on update', async () => {
    const { repo, service } = makeService();

    await expect(service.createCustomer(baseUser, { name: 'No Location Co' })).rejects.toThrow(
      'at least one location'
    );
    await expect(service.createCustomer(baseUser, { name: 'Bad Location Co', tags: ['Nowhere'] })).rejects.toThrow(
      'at least one location'
    );
    await expect(service.createCustomer(baseUser, { name: 'Good Co', tags: ['Punjab'] })).resolves.toEqual({
      id: 'CUST-0001'
    });
    expect(await repo.getCustomer('CUST-0001')).toMatchObject({ tags: ['Punjab'] });

    const l3: CrmContext = { ...baseUser, role: 'L3', email: 'manager@automationsystems.org' };
    repo.handlers.push({ customerId: 'CUST-0001', email: l3.email, assignedBy: l3.email, assignedAt: 'now' });

    await expect(service.updateCustomer(l3, 'CUST-0001', { tags: [] })).rejects.toThrow('at least one location');
    await expect(service.updateCustomer(l3, 'CUST-0001', { tags: ['Nowhere'] })).rejects.toThrow(
      'at least one location'
    );
    expect(await repo.getCustomer('CUST-0001')).toMatchObject({ tags: ['Punjab'] });

    await service.updateCustomer(l3, 'CUST-0001', { tags: ['NCR'] });
    expect(await repo.getCustomer('CUST-0001')).toMatchObject({ tags: ['NCR'] });
  });

  it('P7: TO BE FILLED survives a save round-trip but is never offered as a choice', async () => {
    const { repo, service } = makeService();
    repo.customers = [customer({ tags: ['TO BE FILLED'] })];
    const l3: CrmContext = { ...baseUser, role: 'L3', email: 'manager@automationsystems.org' };
    repo.handlers = [{ customerId: 'CUST-0001', email: l3.email, assignedBy: l3.email, assignedAt: 'now' }];

    // A backfilled row can be edited without silently losing its location.
    await service.updateCustomer(l3, 'CUST-0001', { area: 'Mohali' });
    expect(await repo.getCustomer('CUST-0001')).toMatchObject({ tags: ['TO BE FILLED'], area: 'Mohali' });
    await service.updateCustomer(l3, 'CUST-0001', { tags: ['TO BE FILLED'] });
    expect(await repo.getCustomer('CUST-0001')).toMatchObject({ tags: ['TO BE FILLED'] });

    // ...but the picker never offers it.
    const grid = await service.myCustomers(l3);
    expect(grid.tags).toEqual(['Punjab', 'Chandigarh', 'NCR', 'Geo', 'Other']);
    expect(grid.tags).not.toContain('TO BE FILLED');
  });

  it('P8: saves zero, one or many SEI values from the live settings list and rejects unknown names', async () => {
    const { repo, service } = makeService();
    // SEI_NAMES is read LIVE from public.settings, not from the hardcoded DEFAULT_SETTINGS.
    repo.settings.SEI_NAMES = 'Ravi Kumar | Sunil Mehta | Anita Rao';

    // Zero values is valid - SEI stays optional.
    const none = await service.createCustomer(baseUser, { name: 'No SEI Co', tags: ['Punjab'] });
    expect(await repo.getCustomer(none.id)).toMatchObject({ sei: [] });

    const one = await service.createCustomer(baseUser, { name: 'One SEI Co', tags: ['Punjab'], sei: ['Ravi Kumar'] });
    expect(await repo.getCustomer(one.id)).toMatchObject({ sei: ['Ravi Kumar'] });

    const many = await service.createCustomer(baseUser, {
      name: 'Many SEI Co',
      tags: ['Punjab'],
      sei: ['Ravi Kumar', 'Anita Rao']
    });
    expect(await repo.getCustomer(many.id)).toMatchObject({ sei: ['Ravi Kumar', 'Anita Rao'] });

    await expect(
      service.createCustomer(baseUser, { name: 'Bad SEI Co', tags: ['Punjab'], sei: ['Nobody At All'] })
    ).rejects.toThrow('Nobody At All');

    // Editing an existing customer follows the same live list.
    repo.handlers.push({ customerId: one.id, email: baseUser.email, assignedBy: baseUser.email, assignedAt: 'now' });
    await service.updateCustomer(baseUser, one.id, { sei: ['Sunil Mehta'] });
    expect(await repo.getCustomer(one.id)).toMatchObject({ sei: ['Sunil Mehta'] });
    await expect(service.updateCustomer(baseUser, one.id, { sei: ['Ghost'] })).rejects.toThrow('Ghost');
    await service.updateCustomer(baseUser, one.id, { sei: [] });
    expect(await repo.getCustomer(one.id)).toMatchObject({ sei: [] });
  });

  it('P8: publishes the live SEI name list to clients alongside the other pick lists', async () => {
    const { repo, service } = makeService();
    repo.settings.SEI_NAMES = 'Ravi Kumar | Anita Rao';
    repo.customers = [customer()];
    repo.handlers = [{ customerId: 'CUST-0001', email: baseUser.email, assignedBy: baseUser.email, assignedAt: 'now' }];

    expect((await service.myCustomers(baseUser)).seiNames).toEqual(['Ravi Kumar', 'Anita Rao']);

    // Ships empty until an L6 populates it.
    repo.settings.SEI_NAMES = '';
    expect((await service.myCustomers(baseUser)).seiNames).toEqual([]);
  });

  it('P8: an admin edit to SEI_NAMES takes effect immediately, with no redeploy', async () => {
    const { repo, service } = makeService();
    repo.settings.SEI_NAMES = '';

    // Ships empty: nothing is selectable yet.
    await expect(
      service.createCustomer(baseUser, { name: 'Early Co', tags: ['Punjab'], sei: ['Ravi Kumar'] })
    ).rejects.toThrow('Ravi Kumar');

    // An L6 populates the list in Admin...
    repo.settings.SEI_NAMES = 'Ravi Kumar';

    // ...and the very next save accepts it.
    const created = await service.createCustomer(baseUser, {
      name: 'Later Co',
      tags: ['Punjab'],
      sei: ['Ravi Kumar']
    });
    expect(await repo.getCustomer(created.id)).toMatchObject({ sei: ['Ravi Kumar'] });
  });

  it('requires force to create a duplicate customer name', async () => {
    const { repo, service } = makeService();
    repo.customers = [customer()];

    await expect(service.createCustomer(baseUser, { name: ' alpha panels ', tags: ['Punjab'] })).rejects.toThrow(
      'DUPLICATE'
    );

    await expect(service.createCustomer(baseUser, { name: ' alpha panels ', tags: ['Punjab'], force: true })).resolves.toEqual({
      id: 'CUST-0001'
    });
    expect(repo.lockedNames).toEqual(['alpha panels']);
  });

  it('creates Direct placeholder handlers for L5/L6 creators and real self handlers for sales creators', async () => {
    const { repo, service } = makeService();

    await service.createCustomer({ ...baseUser, role: 'L5', email: 'backend@automationsystems.org' }, { name: 'Direct Co', tags: ['Punjab'] });
    await service.createCustomer(baseUser, { name: 'Sales Co', tags: ['Punjab'] });

    expect(repo.handlers).toEqual([
      expect.objectContaining({ customerId: 'CUST-0001', email: 'direct' }),
      expect.objectContaining({ customerId: 'CUST-0002', email: baseUser.email })
    ]);
  });

  it('adds first contact during customer creation', async () => {
    const { repo, service } = makeService();

    await service.createCustomer(baseUser, {
      name: 'Contact Co',
      tags: ['Punjab'],
      contact: { name: 'Buyer', phone: 12345, email: 'buyer@example.com' }
    });

    expect(repo.contacts).toEqual([
      expect.objectContaining({ id: 'CT-0001', customerId: 'CUST-0001', name: 'Buyer', phone: '12345' })
    ]);
  });

  it('enforces field-level edit rights and partially succeeds for saveCustomerCells', async () => {
    const { repo, service } = makeService();
    repo.customers = [customer(), customer({ id: 'CUST-0002', name: 'Beta Panels' })];
    repo.handlers = [
      { customerId: 'CUST-0001', email: baseUser.email, assignedBy: baseUser.email, assignedAt: 'now' },
      { customerId: 'CUST-0002', email: baseUser.email, assignedBy: baseUser.email, assignedAt: 'now' }
    ];

    const result = await service.saveCustomerCells(baseUser, [
      { id: 'CUST-0001', fields: { area: 'Mohali', priority: 'Medium' } },
      { id: 'CUST-0002', fields: { tags: ['NCR'] } }
    ]);

    expect(result).toEqual({
      saved: ['CUST-0001'],
      failed: [{ id: 'CUST-0002', error: 'Tags, type and archive status can only be changed at L3 or higher.' }]
    });
    expect(await repo.getCustomer('CUST-0001')).toMatchObject({ area: 'Mohali', priority: 'Medium' });
  });

  it('blocks customer deletes with cases or quotes and moves eligible customers to recycle bin', async () => {
    const { repo, service } = makeService();
    repo.customers = [
      customer({ id: 'CUST-0001', name: 'Has Case' }),
      customer({ id: 'CUST-0002', name: 'Has Quote' }),
      customer({ id: 'CUST-0003', name: 'Delete Me' })
    ];
    repo.handlers = repo.customers.map((row) => ({
      customerId: row.id,
      email: 'manager@automationsystems.org',
      assignedBy: 'manager@automationsystems.org',
      assignedAt: 'now'
    }));
    repo.contacts = [{ id: 'CT-0001', customerId: 'CUST-0003', name: 'Contact', phone: '', email: '', designation: '', notes: '' }];
    repo.casesByCustomerId.set('CUST-0001', 1);
    repo.quotesByCustomerId.set('CUST-0002', 1);

    const result = await service.deleteCustomers({ ...baseUser, role: 'L3', email: 'manager@automationsystems.org' }, [
      'CUST-0001',
      'CUST-0002',
      'CUST-0003'
    ]);

    expect(result).toEqual({
      deleted: 1,
      skipped: [
        { name: 'Has Case', reason: 'has cases/quotations' },
        { name: 'Has Quote', reason: 'has cases/quotations' }
      ]
    });
    expect(repo.recycleBin).toEqual([expect.objectContaining({ id: 'CUST-0003', deletedBy: 'manager@automationsystems.org' })]);
    expect(await repo.getCustomer('CUST-0003')).toBeNull();
    expect(repo.contacts).toEqual([]);
  });
});

describe('contact and handler service APIs', () => {
  it('supports contact CRUD and bulk import while preserving omitted fields', async () => {
    const { repo, service } = makeService();
    repo.customers = [customer()];
    repo.handlers = [{ customerId: 'CUST-0001', email: baseUser.email, assignedBy: baseUser.email, assignedAt: 'now' }];

    await expect(service.addContact(baseUser, 'CUST-0001', { name: '' })).rejects.toThrow('Contact name is required');
    const added = await service.addContact(baseUser, 'CUST-0001', {
      name: 'Buyer',
      designation: 'GM',
      phone: 987,
      email: 'buyer@example.com',
      notes: 'First'
    });
    await service.updateContact(baseUser, added.id, { phone: '654' });
    const bulk = await service.bulkContacts(baseUser, 'CUST-0001', [
      { name: 'Second', email: 'two@example.com' },
      { name: '   ' }
    ]);
    await service.deleteContact(baseUser, added.id);

    expect(bulk).toEqual({ created: 1 });
    expect(repo.contacts).toEqual([
      expect.objectContaining({ id: 'CT-0002', name: 'Second', email: 'two@example.com' })
    ]);
  });

  it('caps bulk customer import at 500 rows and skips case-insensitive duplicates', async () => {
    const { repo, service } = makeService();
    repo.customers = [customer({ name: 'Existing Co' })];

    await expect(
      service.bulkCustomers(baseUser, Array.from({ length: 501 }, (_, index) => ({ name: `Co ${index}` })))
    ).rejects.toThrow('at most 500');

    const result = await service.bulkCustomers(baseUser, [
      { name: 'existing co' },
      { name: 'New Co', tag: 'Punjab', type: 'OEM', priority: 'High', area: 'Delhi' },
      { name: ' ' }
    ]);

    expect(result).toEqual({ created: 1, skipped: ['existing co'] });
    expect(repo.lockedNames).toEqual(['existing co', 'new co']);
    expect(repo.handlers).toEqual([
      expect.objectContaining({ customerId: 'CUST-0001', email: baseUser.email })
    ]);
  });

  it('expands usernames, validates active users, removes Direct, and prevents duplicate handlers', async () => {
    const { repo, service } = makeService();
    repo.customers = [customer()];
    repo.handlers = [{ customerId: 'CUST-0001', email: 'direct', assignedBy: 'backend@automationsystems.org', assignedAt: 'now' }];

    await service.addHandler({ ...baseUser, role: 'L3', email: 'manager@automationsystems.org' }, 'CUST-0001', 'target');

    expect(repo.handlers).toEqual([
      expect.objectContaining({ customerId: 'CUST-0001', email: 'target@automationsystems.org' })
    ]);
    await expect(
      service.addHandler({ ...baseUser, role: 'L3', email: 'manager@automationsystems.org' }, 'CUST-0001', 'target')
    ).rejects.toThrow('already a handler');
    await expect(
      service.addHandler({ ...baseUser, role: 'L3', email: 'manager@automationsystems.org' }, 'CUST-0001', 'inactive')
    ).rejects.toThrow('not an active CRM user');
  });

  it('P1: refuses to make an L5 or L6 an account handler, and allows L1-L4', async () => {
    const { repo, service } = makeService();
    repo.customers = [customer()];
    repo.users = [
      user({ email: 'manager@automationsystems.org', name: 'Manager User', role: 'L3' }),
      user({ email: 'l1@automationsystems.org', name: 'L1 User', role: 'L1' }),
      user({ email: 'l2@automationsystems.org', name: 'L2 User', role: 'L2' }),
      user({ email: 'l3@automationsystems.org', name: 'L3 User', role: 'L3' }),
      user({ email: 'l4@automationsystems.org', name: 'L4 User', role: 'L4' }),
      user({ email: 'l5@automationsystems.org', name: 'L5 User', role: 'L5' }),
      user({ email: 'l6@automationsystems.org', name: 'L6 User', role: 'L6' })
    ];
    const actor: CrmContext = { ...baseUser, role: 'L3', email: 'manager@automationsystems.org' };

    for (const role of ['l1', 'l2', 'l3', 'l4']) {
      await expect(service.addHandler(actor, 'CUST-0001', role)).resolves.toEqual({ ok: true });
    }
    await expect(service.addHandler(actor, 'CUST-0001', 'l5')).rejects.toThrow(
      'L5 and L6 users cannot be account handlers'
    );
    await expect(service.addHandler(actor, 'CUST-0001', 'l6')).rejects.toThrow(
      'L5 and L6 users cannot be account handlers'
    );

    expect(repo.handlers.map((row) => row.email)).toEqual([
      'l1@automationsystems.org',
      'l2@automationsystems.org',
      'l3@automationsystems.org',
      'l4@automationsystems.org'
    ]);
  });

  it('P11: adding a handler makes them an owner of the customer active cases only', async () => {
    const { repo, service } = makeService();
    repo.customers = [customer()];
    repo.handlers = [{ customerId: 'CUST-0001', email: baseUser.email, assignedBy: baseUser.email, assignedAt: 'now' }];
    repo.caseOwnerRows = [
      { id: 'CASE-2026-0001', customerId: 'CUST-0001', outcome: '', extraOwners: [baseUser.email] },
      { id: 'CASE-2026-0002', customerId: 'CUST-0001', outcome: 'Won', extraOwners: [baseUser.email] },
      { id: 'CASE-2026-0003', customerId: 'CUST-0001', outcome: 'Hold', extraOwners: [baseUser.email] },
      { id: 'CASE-2026-0004', customerId: 'CUST-0002', outcome: '', extraOwners: [baseUser.email] }
    ];
    const closedBefore = { ...repo.caseOwnerRows[1], extraOwners: [...repo.caseOwnerRows[1].extraOwners] };

    await service.addHandler(baseUser, 'CUST-0001', 'target');

    // Active case on this customer gains the new handler.
    expect(repo.caseOwnerRows[0].extraOwners).toEqual([baseUser.email, 'target@automationsystems.org']);
    // Closed case is byte-identical.
    expect(repo.caseOwnerRows[1]).toEqual(closedBefore);
    // Hold counts as closed (outcome is set).
    expect(repo.caseOwnerRows[2].extraOwners).toEqual([baseUser.email]);
    // Another customer's case is untouched.
    expect(repo.caseOwnerRows[3].extraOwners).toEqual([baseUser.email]);
  });

  it('P11: removing a handler does not touch any case', async () => {
    const { repo, service } = makeService();
    repo.customers = [customer()];
    repo.handlers = [
      { customerId: 'CUST-0001', email: baseUser.email, assignedBy: baseUser.email, assignedAt: 'now' },
      { customerId: 'CUST-0001', email: 'target@automationsystems.org', assignedBy: baseUser.email, assignedAt: 'now' }
    ];
    repo.caseOwnerRows = [
      {
        id: 'CASE-2026-0001',
        customerId: 'CUST-0001',
        outcome: '',
        extraOwners: [baseUser.email, 'target@automationsystems.org']
      },
      { id: 'CASE-2026-0002', customerId: 'CUST-0001', outcome: 'Won', extraOwners: ['target@automationsystems.org'] }
    ];
    const before = JSON.parse(JSON.stringify(repo.caseOwnerRows));

    await service.removeHandler(baseUser, 'CUST-0001', 'target@automationsystems.org');

    expect(repo.caseOwnerRows).toEqual(before);
    expect(repo.caseWrites).toEqual([]);
  });

  it('P11: a handler already stored on an active case is not duplicated', async () => {
    const { repo, service } = makeService();
    repo.customers = [customer()];
    repo.handlers = [{ customerId: 'CUST-0001', email: baseUser.email, assignedBy: baseUser.email, assignedAt: 'now' }];
    repo.caseOwnerRows = [
      {
        id: 'CASE-2026-0001',
        customerId: 'CUST-0001',
        outcome: '',
        extraOwners: [baseUser.email, 'target@automationsystems.org']
      }
    ];

    await service.addHandler(baseUser, 'CUST-0001', 'target');

    expect(repo.caseOwnerRows[0].extraOwners).toEqual([baseUser.email, 'target@automationsystems.org']);
    expect(repo.caseWrites).toEqual([]);
  });

  it('lets an existing handler remove handlers and rejects absent handlers', async () => {
    const { repo, service } = makeService();
    repo.customers = [customer()];
    repo.handlers = [
      { customerId: 'CUST-0001', email: baseUser.email, assignedBy: baseUser.email, assignedAt: 'now' },
      { customerId: 'CUST-0001', email: 'target@automationsystems.org', assignedBy: baseUser.email, assignedAt: 'now' }
    ];

    await service.removeHandler(baseUser, 'CUST-0001', 'target@automationsystems.org');

    expect(repo.handlers).toEqual([
      expect.objectContaining({ customerId: 'CUST-0001', email: baseUser.email })
    ]);
    await expect(service.removeHandler(baseUser, 'CUST-0001', 'target@automationsystems.org')).rejects.toThrow(
      'not a handler'
    );
  });
});
