import { beforeEach, describe, expect, it } from 'vitest';

import type { CrmContext } from '../auth/context';
import { createCustomerService, type CustomerRepository } from './service';

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
    sei: '',
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

  it('requires force to create a duplicate customer name', async () => {
    const { repo, service } = makeService();
    repo.customers = [customer()];

    await expect(service.createCustomer(baseUser, { name: ' alpha panels ' })).rejects.toThrow(
      'DUPLICATE'
    );

    await expect(service.createCustomer(baseUser, { name: ' alpha panels ', force: true })).resolves.toEqual({
      id: 'CUST-0001'
    });
    expect(repo.lockedNames).toEqual(['alpha panels']);
  });

  it('creates Direct placeholder handlers for L5/L6 creators and real self handlers for sales creators', async () => {
    const { repo, service } = makeService();

    await service.createCustomer({ ...baseUser, role: 'L5', email: 'backend@automationsystems.org' }, { name: 'Direct Co' });
    await service.createCustomer(baseUser, { name: 'Sales Co' });

    expect(repo.handlers).toEqual([
      expect.objectContaining({ customerId: 'CUST-0001', email: 'direct' }),
      expect.objectContaining({ customerId: 'CUST-0002', email: baseUser.email })
    ]);
  });

  it('adds first contact during customer creation', async () => {
    const { repo, service } = makeService();

    await service.createCustomer(baseUser, {
      name: 'Contact Co',
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
