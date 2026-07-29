import { describe, expect, it } from 'vitest';

import type { CrmContext } from '../auth/context';
import type { CaseRepository } from '../cases/service';
import { createCaseService } from '../cases/service';
import { createCustomerService, type CustomerRepository } from '../customers/service';
import { createDashboardService, type DashboardRepository } from './service';

const sales: CrmContext = {
  email: 'sales@automationsystems.org',
  name: 'Sales User',
  role: 'L2',
  allowedTags: ['Punjab'],
  active: true
};

type CustomerRow = NonNullable<Awaited<ReturnType<DashboardRepository['getCustomer']>>>;
type CaseRow = Awaited<ReturnType<DashboardRepository['listCases']>>[number];
type UserRow = Awaited<ReturnType<DashboardRepository['listUsers']>>[number];
type HandlerRow = Awaited<ReturnType<DashboardRepository['listHandlers']>>[number];

class FakeDashboardRepository implements DashboardRepository, CaseRepository, CustomerRepository {
  customers: CustomerRow[] = [];
  cases: CaseRow[] = [];
  users: UserRow[] = [];
  handlers: HandlerRow[] = [];
  contacts: Awaited<ReturnType<CustomerRepository['listContactsByCustomer']>> = [];
  quotes: Awaited<ReturnType<CaseRepository['listQuotesByCase']>> = [];
  logs: Array<{ action: string; entity: string; customerId: string; details: string; who: string; when?: string }> = [];
  failCustomers = false;
  failCases = false;
  nextCustomer = 10;
  nextCase = 10;
  nextContact = 1;

  async withTransaction<T>(fn: (repo?: DashboardRepository & CaseRepository & CustomerRepository) => Promise<T>): Promise<T> {
    return fn(this);
  }

  async nextCustomerId(): Promise<string> {
    return `CUST-${String(this.nextCustomer++).padStart(4, '0')}`;
  }

  async nextCaseId(): Promise<string> {
    return `CASE-2026-${String(this.nextCase++).padStart(4, '0')}`;
  }

  async nextContactId(): Promise<string> {
    return `CT-${String(this.nextContact++).padStart(4, '0')}`;
  }

  async listCustomers(): Promise<CustomerRow[]> {
    if (this.failCustomers) throw new Error('customer grid failed');
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
    const row = await this.getCustomer(id);
    if (!row) throw new Error('missing test customer');
    Object.assign(row, fields);
  }

  async deleteCustomer(id: string): Promise<void> {
    this.customers = this.customers.filter((customer) => customer.id !== id);
  }

  async moveCustomerToRecycleBin(): Promise<void> {}

  async listContactsByCustomer(customerId: string) {
    return this.contacts.filter((contact) => contact.customerId === customerId);
  }

  async countContactsByCustomer(): Promise<Record<string, number>> {
    return {};
  }

  async getContact() {
    return null;
  }

  async createContact(): Promise<void> {}

  async updateContact(): Promise<void> {}

  async deleteContact(): Promise<void> {}

  async listHandlers(): Promise<HandlerRow[]> {
    return this.handlers;
  }

  async addHandler(handler: HandlerRow): Promise<void> {
    this.handlers.push(handler);
  }

  async removeHandler(customerId: string, email: string): Promise<void> {
    this.handlers = this.handlers.filter((handler) => !(handler.customerId === customerId && handler.email === email));
  }

  async removeDirectHandlers(customerId: string): Promise<void> {
    this.handlers = this.handlers.filter((handler) => !(handler.customerId === customerId && handler.email === 'direct'));
  }

  async listUsers(): Promise<UserRow[]> {
    return this.users;
  }

  async hasCases(customerId: string): Promise<boolean> {
    return this.cases.some((row) => row.customerId === customerId);
  }

  async hasQuotations(): Promise<boolean> {
    return false;
  }

  async getCase(id: string): Promise<CaseRow | null> {
    return this.cases.find((row) => row.id === id) ?? null;
  }

  async listCases(): Promise<CaseRow[]> {
    if (this.failCases) throw new Error('case list failed');
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

  async listQuotesByCase(caseId: string) {
    return this.quotes.filter((quote) => quote.caseId === caseId);
  }

  async latestQuotedValueByCase(): Promise<Record<string, number>> {
    return {};
  }

  async listActivity(limit = 250) {
    return this.logs.slice(-limit).map((log, index) => ({
      when: log.when ?? `2026-07-29T00:00:${index}.000Z`,
      who: log.who,
      action: log.action,
      entity: log.entity,
      customerId: log.customerId,
      details: log.details
    }));
  }

  async listActivityByEntity(entity: string) {
    return (await this.listActivity()).filter((log) => log.entity === entity);
  }

  async logActivity(entry: { action: string; entity: string; customerId: string; details: string; who: string }): Promise<void> {
    this.logs.push(entry);
  }
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
    createdBy: sales.email,
    createdAt: '2026-07-01T00:00:00.000Z',
    updatedAt: '2026-07-01T00:00:00.000Z',
    ...overrides
  };
}

function caseRow(overrides: Partial<CaseRow> = {}): CaseRow {
  return {
    id: 'CASE-2026-0001',
    customerId: 'CUST-0001',
    title: 'Panel upgrade',
    details: '',
    source: '',
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
  const repo = new FakeDashboardRepository();
  repo.users = [
    user({ email: sales.email, name: sales.name }),
    user({ email: 'peer@automationsystems.org', name: 'Peer Sales', allowedTags: ['Punjab'] }),
    user({ email: 'ncr@automationsystems.org', name: 'NCR Sales', allowedTags: ['NCR'] }),
    user({ email: 'supervisor@automationsystems.org', name: 'Supervisor', role: 'L3', allowedTags: ['Punjab'] }),
    user({ email: 'manager@automationsystems.org', name: 'Manager', role: 'L4', allowedTags: ['*'] }),
    user({ email: 'backend@automationsystems.org', name: 'Backend', role: 'L5', allowedTags: ['*'] }),
    user({ email: 'admin@automationsystems.org', name: 'Admin', role: 'L6', allowedTags: ['*'] }),
    user({ email: 'inactive@automationsystems.org', name: 'Inactive', active: false })
  ];
  repo.customers = [customer(), customer({ id: 'CUST-0002', name: 'Beta Motors', tags: ['NCR'] })];
  repo.handlers = [
    { customerId: 'CUST-0001', email: sales.email, assignedBy: sales.email, assignedAt: 'now' },
    { customerId: 'CUST-0001', email: 'peer@automationsystems.org', assignedBy: sales.email, assignedAt: 'now' },
    { customerId: 'CUST-0002', email: 'ncr@automationsystems.org', assignedBy: sales.email, assignedAt: 'now' }
  ];
  repo.cases = [
    caseRow(),
    caseRow({ id: 'CASE-2026-0002', title: 'Held case', outcome: 'Hold', assignee: sales.email }),
    caseRow({ id: 'CASE-2026-0003', title: 'Won case', outcome: 'Won', orderValue: 5000, closedOn: '2026-07-29T00:00:00.000Z', assignee: '' }),
    caseRow({ id: 'CASE-2026-0004', customerId: 'CUST-0002', title: 'NCR case', assignee: 'ncr@automationsystems.org' })
  ];
  return {
    repo,
    dashboard: createDashboardService(repo, {
      customerService: createCustomerService(repo),
      caseService: createCaseService(repo)
    })
  };
}

describe('dashboard service', () => {
  it('returns bootstrap differences for L1, L2-L4, and L5-L6 users with peer restrictions', async () => {
    const { dashboard } = makeService();

    const l1 = await dashboard.bootstrap({ ...sales, email: 'worker@automationsystems.org', role: 'L1', allowedTags: [] });
    expect(l1.isL1).toBe(true);
    expect(l1.self?.stats).toMatchObject({ myCustomers: 0, openOpps: 0 });

    const l3 = await dashboard.bootstrap({ ...sales, email: 'supervisor@automationsystems.org', role: 'L3', allowedTags: ['Punjab'] });
    expect(l3.peers.map((peer) => peer.email)).toEqual(expect.arrayContaining([sales.email, 'peer@automationsystems.org']));
    expect(l3.peers.map((peer) => peer.email)).not.toContain('ncr@automationsystems.org');
    await expect(dashboard.dashboard({ ...sales, email: 'supervisor@automationsystems.org', role: 'L3', allowedTags: ['Punjab'] }, 'ncr')).rejects.toThrow(
      'share one of your tags'
    );

    const backend = await dashboard.bootstrap({ ...sales, email: 'backend@automationsystems.org', role: 'L5', allowedTags: ['*'] });
    expect(backend.isBackend).toBe(true);
    expect(backend.self).toBeNull();
  });

  it('caps dashboard case and ticket lists at 60 and credits won value in full to every handler owner', async () => {
    const { repo, dashboard } = makeService();
    repo.cases = Array.from({ length: 65 }, (_, index) =>
      caseRow({
        id: `CASE-2026-${String(index + 1).padStart(4, '0')}`,
        title: `Open ${String(index + 1).padStart(3, '0')}`,
        assignee: sales.email
      })
    );
    repo.cases.push(caseRow({ id: 'CASE-2026-0900', title: 'Won together', outcome: 'Won', orderValue: 7000, closedOn: '2026-07-29T00:00:00.000Z', assignee: '' }));

    const result = await dashboard.dashboard(sales, sales.email);

    expect(result.dash.stats).toMatchObject({
      myCustomers: 1,
      openOpps: 65,
      wonMonthValue: 7000,
      wonMonthCount: 1,
      won2wValue: 7000,
      won2wCount: 1
    });
    expect(result.dash.cases).toHaveLength(60);
    expect(result.dash.tickets).toHaveLength(60);

    const peer = await dashboard.dashboard({ ...sales, email: 'manager@automationsystems.org', role: 'L4', allowedTags: ['*'] }, 'peer');
    expect(peer.dash.stats.wonMonthValue).toBe(7000);
  });

  it('composes workspace bootstrap, customers, and cases while tolerating partial failures', async () => {
    const { repo, dashboard } = makeService();

    const ok = await dashboard.workspace(sales, { outcome: 'Open' });
    expect(ok.boot.user.email).toBe(sales.email);
    expect(ok.customers?.scope).toBe('mine');
    expect(ok.cases).toEqual([expect.objectContaining({ id: 'CASE-2026-0001' })]);

    repo.failCustomers = true;
    repo.failCases = true;
    const partial = await dashboard.workspace(sales, {});
    expect(partial.boot.user.email).toBe(sales.email);
    expect(partial.customers).toBeNull();
    expect(partial.cases).toBeNull();
  });

  it('filters recent activity to self, full-access customers, and L4+ visibility', async () => {
    const { repo, dashboard } = makeService();
    repo.logs = [
      { who: 'ncr@automationsystems.org', action: 'CASE_EDIT', entity: 'CASE-1', customerId: 'CUST-0002', details: 'Hidden', when: '2026-07-28T00:00:00.000Z' },
      { who: sales.email, action: 'CASE_EDIT', entity: 'CASE-2', customerId: 'CUST-0002', details: 'Own log', when: '2026-07-29T00:00:00.000Z' },
      { who: 'peer@automationsystems.org', action: 'CASE_EDIT', entity: 'CASE-3', customerId: 'CUST-0001', details: 'Visible customer', when: '2026-07-30T00:00:00.000Z' }
    ];

    const boot = await dashboard.bootstrap(sales);
    expect(boot.recent.map((row) => row.details)).toEqual(['Visible customer', 'Own log']);

    const manager = await dashboard.bootstrap({ ...sales, email: 'manager@automationsystems.org', role: 'L4', allowedTags: ['*'] });
    expect(manager.recent.map((row) => row.details)).toEqual(['Visible customer', 'Own log', 'Hidden']);
  });
});
