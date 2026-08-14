import { beforeEach, describe, expect, it } from 'vitest';

import type { CrmContext } from '../auth/context';
import { createCaseService, type CaseActivityLogEntry, type CaseRepository } from './service';

const sales: CrmContext = {
  email: 'sales@automationsystems.org',
  name: 'Sales User',
  role: 'L2',
  allowedTags: ['Punjab'],
  active: true
};

type CustomerRow = Awaited<ReturnType<CaseRepository['getCustomer']>>;
type CaseRow = NonNullable<Awaited<ReturnType<CaseRepository['getCase']>>>;
type UserRow = Awaited<ReturnType<CaseRepository['listUsers']>>[number];
type HandlerRow = Awaited<ReturnType<CaseRepository['listHandlers']>>[number];
type QuoteRow = Awaited<ReturnType<CaseRepository['listQuotesByCase']>>[number];

class FakeCaseRepository implements CaseRepository {
  customers: NonNullable<CustomerRow>[] = [];
  cases: CaseRow[] = [];
  users: UserRow[] = [];
  handlers: HandlerRow[] = [];
  quotes: QuoteRow[] = [];
  logs: CaseActivityLogEntry[] = [];
  lockedNames: string[] = [];
  nextCustomer = 2;
  nextCase = 1;

  async withTransaction<T>(fn: (repo?: CaseRepository) => Promise<T>): Promise<T> {
    return fn(this);
  }

  async lockCustomerName(name: string): Promise<void> {
    this.lockedNames.push(name.trim().toLowerCase().replace(/\s+/g, ' '));
  }

  async nextCustomerId(): Promise<string> {
    return `CUST-${String(this.nextCustomer++).padStart(4, '0')}`;
  }

  async nextCaseId(): Promise<string> {
    return `CASE-2026-${String(this.nextCase++).padStart(4, '0')}`;
  }

  async getCustomer(id: string): Promise<NonNullable<CustomerRow> | null> {
    return this.customers.find((customer) => customer.id === id) ?? null;
  }

  async findCustomerByName(name: string): Promise<NonNullable<CustomerRow> | null> {
    const key = name.trim().toLowerCase();
    return this.customers.find((customer) => customer.name.trim().toLowerCase() === key) ?? null;
  }

  async createCustomer(customer: NonNullable<CustomerRow>): Promise<void> {
    this.customers.push(customer);
  }

  async addHandler(handler: HandlerRow): Promise<void> {
    this.handlers.push(handler);
  }

  async listHandlers(): Promise<HandlerRow[]> {
    return this.handlers;
  }

  async listUsers(): Promise<UserRow[]> {
    return this.users;
  }

  async getCase(id: string): Promise<CaseRow | null> {
    return this.cases.find((row) => row.id === id) ?? null;
  }

  async listCases(): Promise<CaseRow[]> {
    return this.cases;
  }

  async createCase(row: CaseRow): Promise<void> {
    this.cases.push(row);
  }

  async updateCase(id: string, fields: Partial<CaseRow>): Promise<void> {
    const row = await this.getCase(id);
    if (!row) throw new Error('missing test case');
    Object.assign(row, fields);
  }

  async listQuotesByCase(caseId: string): Promise<QuoteRow[]> {
    return this.quotes.filter((quote) => quote.caseId === caseId);
  }

  async listActivityByEntity(entity: string): Promise<Array<{ when: string; who: string; action: string; details: string; note: string }>> {
    return this.logs
      .filter((log) => log.entity === entity)
      .map((log, index) => ({
        when: `2026-07-29T00:00:${index}.000Z`,
        who: log.who,
        action: log.action,
        details: log.details,
        note: log.note ?? ''
      }));
  }

  async latestQuotedValueByCase(): Promise<Record<string, number>> {
    return this.quotes
      .filter((quote) => quote.status !== 'Superseded')
      .reduce<Record<string, number>>((map, quote) => {
        map[quote.caseId] = quote.total;
        return map;
      }, {});
  }

  async logActivity(entry: CaseActivityLogEntry): Promise<void> {
    this.logs.push(entry);
  }

  async latestHandoverNote(caseId: string): Promise<string> {
    const matches = this.logs.filter(
      (log) => log.entity === caseId && log.action === 'CASE_ASSIGN' && (log.note ?? '') !== ''
    );
    return matches.length ? (matches[matches.length - 1].note ?? '') : '';
  }
}

function customer(overrides: Partial<NonNullable<CustomerRow>> = {}): NonNullable<CustomerRow> {
  return {
    id: 'CUST-0001',
    name: 'Alpha Panels',
    tags: ['Punjab'],
    type: 'OEM',
    priority: 'High',
    area: 'Ludhiana',
    address: 'Industrial Area',
    gstin: '03AAAAA0000A1Z5',
    website: 'https://alpha.example',
    notes: 'Sensitive customer notes',
    sei: [],
    remarks: '',
    status: 'Active',
    createdBy: sales.email,
    createdAt: '2026-07-01T00:00:00.000Z',
    updatedAt: '2026-07-01T00:00:00.000Z',
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

function caseRow(overrides: Partial<CaseRow> = {}): CaseRow {
  return {
    id: 'CASE-2026-0001',
    customerId: 'CUST-0001',
    title: 'Panel upgrade',
    details: 'Upgrade details',
    source: 'Direct Enquiry',
    stage: 'Lead',
    outcome: '',
    orderValue: '',
    wonCategories: [],
    outcomeNote: '',
    owner: sales.email,
    extraOwners: [],
    assignee: sales.email,
    closedOn: '',
    createdBy: sales.email,
    createdAt: '2026-07-01T00:00:00.000Z',
    updatedAt: '2026-07-01T00:00:00.000Z',
    ...overrides
  };
}

function makeService() {
  const repo = new FakeCaseRepository();
  repo.customers = [customer()];
  repo.users = [
    user({ email: sales.email, name: sales.name }),
    user({ email: 'other@automationsystems.org', name: 'Other Sales', allowedTags: ['NCR'] }),
    user({ email: 'worker@automationsystems.org', name: 'Ticket Worker', role: 'L1', allowedTags: [] }),
    user({ email: 'manager@automationsystems.org', name: 'Manager User', role: 'L4', allowedTags: ['*'] }),
    user({ email: 'inactive@automationsystems.org', name: 'Inactive User', active: false })
  ];
  repo.handlers = [{ customerId: 'CUST-0001', email: sales.email, assignedBy: sales.email, assignedAt: 'now' }];
  return { repo, service: createCaseService(repo) };
}

describe('case service ownership and assignment', () => {
  it('P11: seeds owners from the real handlers at creation and stores them on the case', async () => {
    const { repo, service } = makeService();
    repo.handlers.push({ customerId: 'CUST-0001', email: 'other@automationsystems.org', assignedBy: sales.email, assignedAt: 'now' });

    const created = await service.createCase(sales, 'CUST-0001', {
      title: 'Shared opportunity',
      stage: 'Opportunity',
      assignee: 'worker'
    });

    expect(repo.cases.find((row) => row.id === created.id)?.extraOwners).toEqual([
      sales.email,
      'other@automationsystems.org'
    ]);

    await service.addCaseOwner(sales, created.id, 'manager');
    const full = await service.getCase(sales, created.id);

    expect(full.case.ownerEmails).toEqual([
      sales.email,
      'other@automationsystems.org',
      'manager@automationsystems.org'
    ]);
    expect(full.case.ownerList).toEqual([
      { email: sales.email, name: sales.name, source: 'handler', removable: false },
      { email: 'other@automationsystems.org', name: 'Other Sales', source: 'handler', removable: false },
      { email: 'manager@automationsystems.org', name: 'Manager User', source: 'manual', removable: true }
    ]);

    // P11: dropping the handler rows must NOT change who owns the case.
    repo.handlers = [];
    const afterHandlerRemoval = await service.getCase({ ...sales, role: 'L4' }, created.id);
    expect(afterHandlerRemoval.case.ownerEmails).toEqual([
      sales.email,
      'other@automationsystems.org',
      'manager@automationsystems.org'
    ]);
    // ...but they are no longer labelled as account handlers, so they become removable.
    expect(afterHandlerRemoval.case.ownerList.map((owner) => owner.source)).toEqual([
      'creator',
      'manual',
      'manual'
    ]);
  });

  it('P10: a case created on a Direct-handled customer labels the creator as creator, not handler', async () => {
    const { repo, service } = makeService();
    // Exactly the reported scenario: an L6 creates the customer, so the handler is Direct.
    repo.handlers = [{ customerId: 'CUST-0001', email: 'direct', assignedBy: 'admin@automationsystems.org', assignedAt: 'now' }];
    repo.users.push(user({ email: 'admin@automationsystems.org', name: 'Admin User', role: 'L6', allowedTags: ['*'] }));
    const admin: CrmContext = { ...sales, email: 'admin@automationsystems.org', name: 'Admin User', role: 'L6', allowedTags: ['*'] };

    const created = await service.createCase(admin, 'CUST-0001', { title: 'Direct enquiry', assignee: 'worker' });
    const full = await service.getCase(admin, created.id);

    expect(full.case.ownerEmails).toEqual([admin.email]);
    expect(full.case.ownerList).toEqual([
      { email: admin.email, name: 'Admin User', source: 'creator', removable: false }
    ]);
    // The creator is NOT an account handler, so the handler-specific refusal must not fire...
    await expect(service.removeCaseOwner(admin, created.id, admin.email)).rejects.toThrow(
      'at least one owner'
    );
    // ...and once a second owner exists, the creator can be removed.
    await service.addCaseOwner(admin, created.id, 'manager');
    await service.removeCaseOwner(admin, created.id, admin.email);
    expect(repo.cases.find((row) => row.id === created.id)?.extraOwners).toEqual([
      'manager@automationsystems.org'
    ]);
  });

  it('refuses to remove an account handler from a case and refuses to empty the owner list', async () => {
    const { repo, service } = makeService();
    const created = await service.createCase(sales, 'CUST-0001', { title: 'Solo case', assignee: 'worker' });

    await expect(service.removeCaseOwner(sales, created.id, sales.email)).rejects.toThrow('at least one owner');

    await service.addCaseOwner(sales, created.id, 'manager');
    await expect(service.removeCaseOwner(sales, created.id, sales.email)).rejects.toThrow(
      'Account handlers are owners of every case'
    );
    expect(repo.cases.find((row) => row.id === created.id)?.extraOwners).toEqual([
      sales.email,
      'manager@automationsystems.org'
    ]);
  });

  it('lets any visible open case be reassigned to any active user and blocks inactive targets', async () => {
    const { repo, service } = makeService();
    repo.cases = [caseRow({ assignee: 'worker@automationsystems.org' })];

    const result = await service.assignTicket({ ...sales, email: 'worker@automationsystems.org', role: 'L1' }, 'CASE-2026-0001', 'other');

    expect(result).toEqual({ ok: true, assignee: 'Other Sales', assigneeEmail: 'other@automationsystems.org' });
    expect(repo.cases[0].assignee).toBe('other@automationsystems.org');
    await expect(service.assignTicket(sales, 'CASE-2026-0001', 'inactive')).rejects.toThrow('not an active CRM user');
  });
});

describe('case service assignable users', () => {
  it('P1: an L5/L6 who may not be an account handler is still eligible as case owner and assignee', async () => {
    const { repo, service } = makeService();
    repo.users.push(user({ email: 'l5@automationsystems.org', name: 'L5 User', role: 'L5', allowedTags: ['*'] }));
    repo.users.push(user({ email: 'l6@automationsystems.org', name: 'L6 User', role: 'L6', allowedTags: ['*'] }));
    const created = await service.createCase(sales, 'CUST-0001', { title: 'Backend help', assignee: 'worker' });

    await service.addCaseOwner(sales, created.id, 'l5');
    await service.addCaseOwner(sales, created.id, 'l6');
    const assigned = await service.assignTicket(sales, created.id, 'l5');

    expect(repo.cases.find((row) => row.id === created.id)?.extraOwners).toEqual([
      sales.email,
      'l5@automationsystems.org',
      'l6@automationsystems.org'
    ]);
    expect(assigned).toMatchObject({ ok: true, assigneeEmail: 'l5@automationsystems.org' });
    expect((await service.listAssignableUsers(sales)).map((row) => row.email)).toEqual(
      expect.arrayContaining(['l5@automationsystems.org', 'l6@automationsystems.org'])
    );
  });

  it('P9: never offers the virtual Direct account as a ticket assignee', async () => {
    const { repo, service } = makeService();
    // Even if a 'direct' row somehow reached public.users, it can never hold a ticket.
    repo.users.push(user({ email: 'direct', name: 'Direct', role: 'L2', allowedTags: ['*'] }));

    const assignable = await service.listAssignableUsers(sales);

    expect(assignable.map((row) => row.email)).not.toContain('direct');
    await expect(service.assignTicket(sales, 'CASE-2026-0001', 'direct')).rejects.toThrow();
  });
});

describe('case service outcomes and stage rules', () => {
  it('validates won orders, clears assignee on Won/Lost, and keeps Hold assigned until stage changes', async () => {
    const { repo, service } = makeService();
    repo.cases = [caseRow({ stage: 'Opportunity', assignee: 'worker@automationsystems.org' })];

    await expect(service.setCaseOutcome(sales, 'CASE-2026-0001', 'Won', { orderValue: 0, categories: ['Panels'] })).rejects.toThrow(
      'order value'
    );
    await expect(service.setCaseOutcome(sales, 'CASE-2026-0001', 'Won', { orderValue: 5000, categories: [] })).rejects.toThrow(
      'category'
    );

    await service.setCaseOutcome(sales, 'CASE-2026-0001', 'Hold', { note: 'Awaiting client' });
    expect(repo.cases[0]).toMatchObject({ outcome: 'Hold', assignee: 'worker@automationsystems.org', closedOn: '' });
    await expect(service.assignTicket(sales, 'CASE-2026-0001', 'other')).rejects.toThrow('ticket can no longer be reassigned');

    await service.setCaseStage(sales, 'CASE-2026-0001', 'Quoted', 'resumed');
    expect(repo.cases[0]).toMatchObject({ stage: 'Quoted', outcome: '', assignee: 'worker@automationsystems.org' });

    await service.setCaseOutcome(sales, 'CASE-2026-0001', 'Won', {
      orderValue: 5000,
      categories: ['Panels', 'Lighting, Switches, Wires']
    });
    expect(repo.cases[0]).toMatchObject({
      stage: 'Quoted',
      outcome: 'Won',
      orderValue: 5000,
      wonCategories: ['Panels', 'Lighting, Switches, Wires'],
      assignee: ''
    });
    await expect(service.setCaseStage(sales, 'CASE-2026-0001', 'Lead')).rejects.toThrow('Reopen');

    await service.setCaseOutcome(sales, 'CASE-2026-0001', 'Open', {});
    await service.setCaseOutcome(sales, 'CASE-2026-0001', 'Lost', { note: 'No budget' });
    expect(repo.cases[0]).toMatchObject({ outcome: 'Lost', assignee: '' });
  });

  it('creates direct won cases without assignee and requires L5 creators to pick assignee for open cases', async () => {
    const { repo, service } = makeService();

    await expect(
      service.createCase({ ...sales, role: 'L5', email: 'manager@automationsystems.org' }, 'CUST-0001', {
        title: 'Backend opportunity'
      })
    ).rejects.toThrow('Choose who this case is assigned to');

    const result = await service.createCase(sales, 'CUST-0001', {
      title: 'Repeat order',
      order: true,
      orderValue: 10000,
      categories: ['Panels'],
      assignee: 'worker'
    });

    expect(repo.cases.find((row) => row.id === result.id)).toMatchObject({
      stage: 'Quoted',
      outcome: 'Won',
      assignee: '',
      orderValue: 10000,
      wonCategories: ['Panels']
    });
  });
});

describe('case reads, lists, and quick log', () => {
  it('returns only minimal customer data to assignee-only users', async () => {
    const { repo, service } = makeService();
    repo.cases = [caseRow({ assignee: 'worker@automationsystems.org' })];

    const result = await service.getCase({ ...sales, email: 'worker@automationsystems.org', role: 'L1', allowedTags: [] }, 'CASE-2026-0001');

    expect(result.canEdit).toBe(true);
    expect(result.customer).toEqual({ id: 'CUST-0001', name: 'Alpha Panels', tags: ['Punjab'] });
    expect(result.customer).not.toHaveProperty('address');
    expect(result.case.assignee).toBe('Ticket Worker');
  });

  it('filters visible cases, mine by owners only, open excluding Hold, search text, quoted value, and caps at 300', async () => {
    const { repo, service } = makeService();
    repo.cases = Array.from({ length: 305 }, (_, index) =>
      caseRow({
        id: `CASE-2026-${String(index + 1).padStart(4, '0')}`,
        title: `Panel work ${String(index + 1).padStart(3, '0')}`,
        assignee: index === 0 ? 'worker@automationsystems.org' : sales.email,
        outcome: index === 1 ? 'Hold' : '',
        updatedAt: `2026-07-${String((index % 28) + 1).padStart(2, '0')}T00:00:00.000Z`
      })
    );
    repo.quotes = [{ caseId: 'CASE-2026-0001', quoteNo: 'QTN-2026-0001', rev: 0, title: 'Quote', total: 1234, currency: 'INR', status: 'Sent', createdAt: '2026-07-10T00:00:00.000Z', createdBy: sales.email, doc: '', pdf: '' }];

    const workerList = await service.listCases({ ...sales, email: 'worker@automationsystems.org', role: 'L1', allowedTags: [] }, {});
    expect(workerList).toEqual([expect.objectContaining({ id: 'CASE-2026-0001', quotedValue: 1234 })]);

    const mine = await service.listCases(sales, { mine: true, outcome: 'Open', q: 'panel' });
    expect(mine).toHaveLength(300);
    expect(mine.some((row) => row.id === 'CASE-2026-0002')).toBe(false);
    expect(mine.every((row) => row.assignee !== '')).toBe(true);
  });

  it('P6: filters by owned, assigned, both (OR) and neither', async () => {
    const { repo, service } = makeService();
    // A fixture where the owned set and the assigned set genuinely differ.
    repo.cases = [
      // owned only
      caseRow({ id: 'CASE-2026-0001', extraOwners: [sales.email], assignee: 'other@automationsystems.org' }),
      // assigned only
      caseRow({
        id: 'CASE-2026-0002',
        owner: 'other@automationsystems.org',
        extraOwners: ['other@automationsystems.org'],
        assignee: sales.email
      }),
      // both
      caseRow({ id: 'CASE-2026-0003', extraOwners: [sales.email], assignee: sales.email }),
      // neither (visible only because sales is an account handler of CUST-0001)
      caseRow({
        id: 'CASE-2026-0004',
        owner: 'other@automationsystems.org',
        extraOwners: ['other@automationsystems.org'],
        assignee: 'other@automationsystems.org'
      })
    ];

    const ids = async (filter: Record<string, unknown>) =>
      (await service.listCases(sales, filter)).map((row) => row.id).sort();

    expect(await ids({ owned: true })).toEqual(['CASE-2026-0001', 'CASE-2026-0003']);
    expect(await ids({ assigned: true })).toEqual(['CASE-2026-0002', 'CASE-2026-0003']);
    // OR, not AND.
    expect(await ids({ owned: true, assigned: true })).toEqual([
      'CASE-2026-0001',
      'CASE-2026-0002',
      'CASE-2026-0003'
    ]);
    // Neither set: every visible case, i.e. today's behaviour.
    expect(await ids({})).toEqual([
      'CASE-2026-0001',
      'CASE-2026-0002',
      'CASE-2026-0003',
      'CASE-2026-0004'
    ]);
    expect(await ids({ owned: false, assigned: false })).toHaveLength(4);
    // Legacy in-flight clients send `mine`, which must keep behaving as `owned`.
    expect(await ids({ mine: true })).toEqual(['CASE-2026-0001', 'CASE-2026-0003']);
    expect(await ids({ mine: true, assigned: true })).toEqual([
      'CASE-2026-0001',
      'CASE-2026-0002',
      'CASE-2026-0003'
    ]);
  });

  it('quick-log creates new customers with handlers, reuses duplicate names, and blocks inaccessible existing customers', async () => {
    const { repo, service } = makeService();
    repo.customers.push(customer({ id: 'CUST-0099', name: 'Existing Co', tags: ['NCR'] }));

    const created = await service.quickLog(sales, {
      newCustomer: { name: 'Site Co', tag: 'Punjab', type: 'OEM', priority: 'High', area: 'Mohali' },
      title: 'Site visit',
      stage: 'Opportunity',
      details: 'Walk-in enquiry'
    });
    expect(created).toEqual({ caseId: 'CASE-2026-0001', customerId: 'CUST-0002' });
    expect(repo.handlers).toContainEqual(expect.objectContaining({ customerId: 'CUST-0002', email: sales.email, assignedBy: 'quick-log' }));

    const reused = await service.quickLog(sales, { newCustomer: { name: 'site co' }, title: 'Second enquiry' });
    expect(reused.customerId).toBe('CUST-0002');
    expect(repo.lockedNames).toEqual(['site co', 'site co']);

    await expect(service.quickLog(sales, { customerId: 'CUST-0099', title: 'No access' })).rejects.toThrow('not an account handler');
  });
});
