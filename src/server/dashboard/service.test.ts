import { afterEach, describe, expect, it, vi } from 'vitest';

import type { CrmContext } from '../auth/context';
import type { CaseAttachmentRow, CaseRepository } from '../cases/service';
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
  logs: Array<{ action: string; entity: string; customerId: string; details: string; who: string; when?: string; note?: string }> = [];
  attachments: CaseAttachmentRow[] = [];
  failCustomers = false;
  failCases = false;
  nextCustomer = 10;
  nextCase = 10;
  nextContact = 1;
  // Parallel to `logs`, so the fake can answer latestHandover with an id.
  // Tests that assign `logs` wholesale leave this empty on purpose: those cases
  // have no meaningful activity id.
  logIds: string[] = [];
  nextLogId = 1;
  nextAttachmentId = 1;
  getCustomerCallCount = 0;
  getCustomersByIdsCalls: string[][] = [];

  async withTransaction<T>(fn: (repo?: DashboardRepository & CaseRepository & CustomerRepository) => Promise<T>): Promise<T> {
    return fn(this);
  }

  async lockCustomerName(): Promise<void> {}

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
    this.getCustomerCallCount++;
    return this.customers.find((customer) => customer.id === id) ?? null;
  }

  async getCustomersByIds(ids: string[]): Promise<CustomerRow[]> {
    this.getCustomersByIdsCalls.push(ids);
    return this.customers.filter((customer) => ids.includes(customer.id));
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

  async listCasesByCustomer(customerId: string): Promise<Awaited<ReturnType<CustomerRepository['listCasesByCustomer']>>> {
    return this.cases
      .filter((row) => row.customerId === customerId)
      .map((row) => ({
        id: row.id,
        customerId: row.customerId,
        title: row.title,
        stage: row.stage,
        priority: row.priority,
        outcome: row.outcome,
        orderValue: row.orderValue,
        quotedValue: '',
        owners: [row.owner, ...row.extraOwners].filter(Boolean),
        assignee: row.assignee,
        updatedAt: row.updatedAt
      }));
  }

  async listQuotesByCustomer(): Promise<Awaited<ReturnType<CustomerRepository['listQuotesByCustomer']>>> {
    return [];
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

  settingRows: Record<string, string> = {};

  async listCaseOwnerRows(customerId: string): Promise<Array<{ id: string; customerId: string; outcome: string; extraOwners: string[] }>> {
    return this.cases
      .filter((row) => row.customerId === customerId)
      .map((row) => ({ id: row.id, customerId: row.customerId, outcome: row.outcome, extraOwners: row.extraOwners }));
  }

  async setCaseExtraOwners(caseId: string, extraOwners: string[]): Promise<void> {
    const row = this.cases.find((item) => item.id === caseId);
    if (!row) throw new Error('missing test case');
    row.extraOwners = extraOwners;
  }

  async getSetting(key: string): Promise<string | null> {
    return this.settingRows[key] ?? null;
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
    // Mirrors the real repository's `order by created_at desc limit 40`:
    // newest-first, capped at 40 rows.
    // Each row carries its own activity id, derived from its position exactly
    // as logActivity hands them out - a constant id would make attachments look
    // grouped while collapsing every entry onto one.
    return this.logs
      .map((log, index) => ({ log, id: `LOG-${index + 1}` }))
      .filter(({ log }) => log.entity === entity)
      .map(({ log, id }, index) => ({
        id,
        when: log.when ?? `2026-07-29T00:00:${index}.000Z`,
        who: log.who,
        action: log.action,
        details: log.details,
        note: log.note ?? ''
      }))
      .slice()
      .reverse()
      .slice(0, 40);
  }

  // Overloaded so this single implementation satisfies both CaseRepository's widened
  // logActivity (returns the new id) and CustomerRepository's unwidened logActivity
  // (returns void) - this class implements both at once.
  //
  // The implementation signature is typed `Promise<string | void>`, not `Promise<string>`,
  // because TS rejects `Promise<string>` as an implementation for an overload set that
  // includes a `Promise<void>` signature (TS2394: "This overload signature is not
  // compatible with its implementation signature") - confirmed by trying it. This is NOT
  // a loophole: TS does not check the function body against each overload signature
  // independently, only against this implementation signature, so it will not catch a
  // future edit that drops the `return` below. That gap is accepted here deliberately -
  // it is a test fixture, and the real parity guard against a drifting `logActivity` is
  // src/server/cases/repository.test.ts, not this fake's return type.
  async logActivity(entry: { action: string; entity: string; customerId: string; details: string; who: string; note?: string }): Promise<string>;
  async logActivity(entry: { action: string; entity: string; customerId: string; details: string; who: string; note?: string }): Promise<void>;
  async logActivity(entry: { action: string; entity: string; customerId: string; details: string; who: string; note?: string }): Promise<string | void> {
    const id = `LOG-${this.nextLogId++}`;
    this.logs.push(entry);
    this.logIds.push(id);
    return id;
  }

  async latestHandover(caseId: string): Promise<{ note: string; activityId: string }> {
    for (let i = this.logs.length - 1; i >= 0; i -= 1) {
      const log = this.logs[i];
      if (log.entity === caseId && log.action === 'CASE_ASSIGN' && (log.note ?? '') !== '') {
        return { note: log.note ?? '', activityId: this.logIds[i] ?? '' };
      }
    }
    return { note: '', activityId: '' };
  }

  async createAttachments(rows: Array<Omit<CaseAttachmentRow, 'id' | 'createdAt'>>): Promise<void> {
    const now = new Date().toISOString();
    for (const row of rows) {
      this.attachments.push({ ...row, id: `ATT-${this.nextAttachmentId++}`, createdAt: now });
    }
  }

  async listAttachmentsByCase(caseId: string): Promise<CaseAttachmentRow[]> {
    return this.attachments.filter((row) => row.caseId === caseId);
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
    sei: [],
    remarks: '',
    status: 'Active',
    createdBy: sales.email,
    createdAt: '2026-07-01T00:00:00.000Z',
    updatedAt: '2026-07-01T00:00:00.000Z',
    ...overrides
  };
}

/**
 * A timestamp that is simultaneously inside the current UTC calendar month AND within the
 * trailing 14-day window, on every day of every month (28/29/30/31-day months included).
 *
 * `service.ts` credits a won case to `wonMonthCount` when its `closedOn` falls in the current
 * UTC year-month, and to `won2wCount` when `daysAgo(closedOn) <= 14`. Neither "the 1st of this
 * month" nor "14 days ago" alone satisfies both on every day: the 1st falls outside the 14-day
 * window from roughly the 16th onward, while "14 days ago" falls in the *previous* month during
 * the first half of a month.
 *
 * The fix is to pick the later (more recent) of "start of this month" and "14 days ago", then
 * clamp to "now" so the result is never in the future:
 *   - Early in the month (through ~day 15), "14 days ago" is in the previous month, so
 *     `max()` picks the start of this month — satisfying the month check, and within 14 days
 *     of `now` because we're still near the start of the month.
 *   - Later in the month (~day 16 onward), "14 days ago" has moved into this month and is more
 *     recent than the 1st, so `max()` picks it — satisfying the 14-day check by construction,
 *     and still within this month since it's day 2 or later.
 *   - On day 1 itself, "start of this month" (pinned to 12:00 UTC) can be later than `now` if
 *     the test runs before noon UTC; `min(now, ...)` clamps that back to `now` so the result is
 *     never a future timestamp.
 * This holds at both month-length boundaries (31-day months, 30-day months, and February in
 * leap and non-leap years) because it never depends on the month's length — only on "day 1" and
 * "14 days back" relative to `now`.
 */
function closedThisMonth(): string {
  const now = new Date();
  const startOfMonth = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 12);
  const fourteenDaysAgo = now.getTime() - 14 * 86_400_000;
  const closedOn = Math.min(now.getTime(), Math.max(startOfMonth, fourteenDaysAgo));
  return new Date(closedOn).toISOString();
}

function caseRow(overrides: Partial<CaseRow> = {}): CaseRow {
  return {
    id: 'CASE-2026-0001',
    customerId: 'CUST-0001',
    title: 'Panel upgrade',
    details: '',
    source: '',
    priority: '',
    stage: 'Lead',
    outcome: '',
    orderValue: '',
    wonCategories: [],
    outcomeNote: '',
    owner: sales.email,
    extraOwners: [sales.email, 'peer@automationsystems.org'],
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
    caseRow({ id: 'CASE-2026-0003', title: 'Won case', outcome: 'Won', orderValue: 5000, closedOn: closedThisMonth(), assignee: '' }),
    caseRow({
      id: 'CASE-2026-0004',
      customerId: 'CUST-0002',
      title: 'NCR case',
      owner: 'ncr@automationsystems.org',
      extraOwners: ['ncr@automationsystems.org'],
      assignee: 'ncr@automationsystems.org'
    })
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
    repo.cases.push(caseRow({ id: 'CASE-2026-0900', title: 'Won together', outcome: 'Won', orderValue: 7000, closedOn: closedThisMonth(), assignee: '' }));

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

  describe('closedThisMonth fixture across month boundaries', () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    const fixedDates = [
      '2026-08-01T09:00:00.000Z', // 1st of a 31-day month
      '2026-08-15T09:00:00.000Z', // 15th (last day the old fixture passed)
      '2026-08-16T09:00:00.000Z', // 16th (first day the old fixture failed)
      '2026-08-28T09:00:00.000Z', // 28th
      '2026-08-31T09:00:00.000Z', // last day of a 31-day month
      '2026-09-30T09:00:00.000Z', // last day of a 30-day month
      '2026-02-28T09:00:00.000Z', // last day of Feb, non-leap year
      '2028-02-29T09:00:00.000Z' // last day of Feb, leap year
    ];

    it.each(fixedDates)('credits both wonMonthCount and won2wCount as 1 on %s', async (isoNow) => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date(isoNow));

      const { repo, dashboard } = makeService();
      repo.cases = [caseRow({ id: 'CASE-2026-0900', title: 'Won together', outcome: 'Won', orderValue: 7000, closedOn: closedThisMonth(), assignee: '' })];

      const result = await dashboard.dashboard(sales, sales.email);

      expect(result.dash.stats).toMatchObject({
        wonMonthValue: 7000,
        wonMonthCount: 1,
        won2wValue: 7000,
        won2wCount: 1
      });
    });
  });

  it('carries the case priority into both dashboard case lists', async () => {
    const { repo, dashboard } = makeService();
    repo.cases = [caseRow({ id: 'CASE-2026-0001', priority: 'High' })];

    const { dash } = await dashboard.dashboard(sales, sales.email);

    expect(dash.cases[0].priority).toBe('High');
    expect(dash.tickets[0].priority).toBe('High');
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

  it('P7: does not advertise the TO BE FILLED placeholder in the client settings block', async () => {
    const { dashboard } = makeService();

    const boot = await dashboard.bootstrap(sales);

    expect(boot.settings.tags).toEqual(['Punjab', 'Chandigarh', 'NCR', 'Geo', 'Other']);
    expect(boot.settings.tags).not.toContain('TO BE FILLED');
  });

  it('P9: offers Direct in the dashboard picker for L4+ only, flagged as having no login', async () => {
    const { dashboard } = makeService();

    const manager = await dashboard.bootstrap({ ...sales, email: 'manager@automationsystems.org', role: 'L4', allowedTags: ['*'] });
    expect(manager.peers).toContainEqual({ email: 'direct', name: 'Direct', role: 'L2', hasLogin: false });
    expect(manager.peers.filter((peer) => peer.hasLogin === false)).toHaveLength(1);

    const supervisor = await dashboard.bootstrap({ ...sales, email: 'supervisor@automationsystems.org', role: 'L3', allowedTags: ['Punjab'] });
    expect(supervisor.peers.map((peer) => peer.email)).not.toContain('direct');

    const l2 = await dashboard.bootstrap(sales);
    expect(l2.peers.map((peer) => peer.email)).not.toContain('direct');
  });

  it('P9: api_dashboard("direct") reports Direct-handled customers and cases, L4+ only', async () => {
    const { repo, dashboard } = makeService();
    repo.handlers.push({ customerId: 'CUST-0002', email: 'direct', assignedBy: 'admin@automationsystems.org', assignedAt: 'now' });

    const manager: CrmContext = { ...sales, email: 'manager@automationsystems.org', role: 'L4', allowedTags: ['*'] };
    const result = await dashboard.dashboard(manager, 'direct');

    expect(result.subject).toEqual({ email: 'direct', name: 'Direct', role: '' });
    expect(result.dash.stats.myCustomers).toBe(1);
    // CASE-2026-0004 is the open case on the Direct-handled customer.
    expect(result.dash.cases.map((row) => row.id)).toEqual(['CASE-2026-0004']);

    await expect(dashboard.dashboard({ ...sales, role: 'L3' }, 'direct')).rejects.toThrow('L4');
    await expect(dashboard.dashboard(sales, 'direct')).rejects.toThrow();
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

  it('batches customer lookups for recent activity into one call instead of per-row sequential awaits', async () => {
    const { repo, dashboard } = makeService();
    // computeDash() (invoked by bootstrap() for self stats) also calls getCustomer per case -
    // that's a separate code path from recentActivity, so clear cases to isolate the assertion.
    repo.cases = [];
    // Distinct customer ids, repeated, none owned by `sales` and not otherwise visible -
    // this is the worst case: `ok` is false for every row, so the old code never breaks early
    // and re-fetches the same customer repeatedly.
    repo.logs = [
      { who: 'ncr@automationsystems.org', action: 'CASE_EDIT', entity: 'CASE-1', customerId: 'CUST-0002', details: 'a', when: '2026-07-28T00:00:00.000Z' },
      { who: 'ncr@automationsystems.org', action: 'CASE_EDIT', entity: 'CASE-2', customerId: 'CUST-0002', details: 'b', when: '2026-07-28T00:00:01.000Z' },
      { who: 'ncr@automationsystems.org', action: 'CASE_EDIT', entity: 'CASE-3', customerId: 'CUST-0001', details: 'c', when: '2026-07-28T00:00:02.000Z' }
    ];

    await dashboard.bootstrap(sales);

    expect(repo.getCustomerCallCount).toBe(0);
    expect(repo.getCustomersByIdsCalls).toHaveLength(1);
    expect(repo.getCustomersByIdsCalls[0].sort()).toEqual(['CUST-0001', 'CUST-0002']);
  });

  it('does not call getCustomersByIds when no activity rows need an access lookup', async () => {
    const { repo, dashboard } = makeService();
    repo.logs = [
      { who: sales.email, action: 'CASE_EDIT', entity: 'CASE-1', customerId: 'CUST-0002', details: 'own row', when: '2026-07-28T00:00:00.000Z' }
    ];

    const boot = await dashboard.bootstrap(sales);

    expect(boot.recent.map((row) => row.details)).toEqual(['own row']);
    expect(repo.getCustomersByIdsCalls).toHaveLength(0);
  });
});
