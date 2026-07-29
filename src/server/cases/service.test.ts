import { beforeEach, describe, expect, it } from 'vitest';

import type { CrmContext } from '../auth/context';
import { createCaseService, type CaseRepository } from './service';

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
  logs: Array<{ action: string; entity: string; customerId: string; details: string; who: string }> = [];
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

  async listActivityByEntity(entity: string): Promise<Array<{ when: string; who: string; action: string; details: string }>> {
    return this.logs
      .filter((log) => log.entity === entity)
      .map((log, index) => ({ when: `2026-07-29T00:00:${index}.000Z`, who: log.who, action: log.action, details: log.details }));
  }

  async latestQuotedValueByCase(): Promise<Record<string, number>> {
    return this.quotes
      .filter((quote) => quote.status !== 'Superseded')
      .reduce<Record<string, number>>((map, quote) => {
        map[quote.caseId] = quote.total;
        return map;
      }, {});
  }

  async logActivity(entry: { action: string; entity: string; customerId: string; details: string; who: string }): Promise<void> {
    this.logs.push(entry);
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
    sei: '',
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
  it('derives owners from handlers plus extras and uses stored owner only as fallback', async () => {
    const { repo, service } = makeService();
    repo.handlers.push({ customerId: 'CUST-0001', email: 'other@automationsystems.org', assignedBy: sales.email, assignedAt: 'now' });

    const created = await service.createCase(sales, 'CUST-0001', {
      title: 'Shared opportunity',
      stage: 'Opportunity',
      assignee: 'worker'
    });
    await service.addCaseOwner(sales, created.id, 'manager');
    const full = await service.getCase(sales, created.id);

    expect(full.case.ownerEmails).toEqual([
      sales.email,
      'other@automationsystems.org',
      'manager@automationsystems.org'
    ]);
    expect(full.case.ownerList).toEqual([
      expect.objectContaining({ email: sales.email, removable: false }),
      expect.objectContaining({ email: 'other@automationsystems.org', removable: false }),
      expect.objectContaining({ email: 'manager@automationsystems.org', removable: true })
    ]);

    repo.handlers = [];
    const fallback = await service.getCase({ ...sales, role: 'L4' }, created.id);
    expect(fallback.case.ownerEmails).toEqual([sales.email, 'manager@automationsystems.org']);
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
