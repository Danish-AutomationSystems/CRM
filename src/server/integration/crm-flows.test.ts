import { describe, expect, it } from 'vitest';

import type { CrmContext } from '../auth/context';
import { createAdminService, type AdminRepository } from '../admin/service';
import { createCaseService, type CaseAttachmentRow, type CaseRepository } from '../cases/service';
import { createCustomerService, type CustomerRepository } from '../customers/service';
import { createDashboardService, type DashboardRepository } from '../dashboard/service';
import { createQuoteService, type QuoteRepository } from '../quotes/service';

type UserRow = Awaited<ReturnType<AdminRepository['listUsers']>>[number];
type CustomerRow = Awaited<ReturnType<AdminRepository['listCustomers']>>[number];
type ContactRow = Awaited<ReturnType<AdminRepository['listContactsByCustomer']>>[number];
type HandlerRow = Awaited<ReturnType<AdminRepository['listHandlers']>>[number];
type SettingRow = Awaited<ReturnType<AdminRepository['listSettings']>>[number];
type CaseRow = NonNullable<Awaited<ReturnType<CaseRepository['getCase']>>>;
type QuoteRow = NonNullable<Awaited<ReturnType<QuoteRepository['getQuote']>>>;
type BoqBlock = Awaited<ReturnType<QuoteRepository['listBoqBlocks']>>[number];

const admin: CrmContext = {
  email: 'admin@automationsystems.org',
  name: 'Admin User',
  role: 'L6',
  allowedTags: ['*'],
  active: true
};

const sales: CrmContext = {
  email: 'sales@automationsystems.org',
  name: 'Sales User',
  role: 'L2',
  allowedTags: ['Punjab'],
  active: true
};

const handler: CrmContext = {
  email: 'handler@automationsystems.org',
  name: 'Handler User',
  role: 'L2',
  allowedTags: ['Punjab'],
  active: true
};

const assignee: CrmContext = {
  email: 'assignee@automationsystems.org',
  name: 'Assignee User',
  role: 'L1',
  allowedTags: [],
  active: true
};

class CrmFlowRepository implements AdminRepository, CustomerRepository, CaseRepository, QuoteRepository, DashboardRepository {
  users: UserRow[] = [];
  customers: CustomerRow[] = [];
  contacts: ContactRow[] = [];
  handlers: HandlerRow[] = [];
  settings: SettingRow[] = [];
  importCustomers: Awaited<ReturnType<AdminRepository['listImportCustomers']>> = [];
  importContacts: Awaited<ReturnType<AdminRepository['listImportContacts']>> = [];
  recycle: Awaited<ReturnType<AdminRepository['listRecycleCustomers']>> = [];
  cases: CaseRow[] = [];
  quotes: QuoteRow[] = [];
  blocks: BoqBlock[] = [];
  logs: Array<{ action: string; entity: string; customerId: string; details: string; who: string; when?: string; note?: string }> = [];
  attachments: CaseAttachmentRow[] = [];
  customerSeq = 1;
  contactSeq = 1;
  caseSeq = 1;
  quoteSeq = 1;
  logSeq = 1;
  logIds: string[] = [];
  attachmentSeq = 1;

  async withTransaction<T>(fn: (repo?: this) => Promise<T>): Promise<T> {
    return fn(this);
  }

  async lockCustomerName(): Promise<void> {}

  async lockQuoteFamily(): Promise<void> {}

  async listUsers(): Promise<UserRow[]> {
    return this.users;
  }

  async getUser(email: string): Promise<UserRow | null> {
    return this.users.find((user) => user.email === email) ?? null;
  }

  async createUser(user: UserRow): Promise<void> {
    this.users.push(user);
  }

  async updateUser(email: string, fields: Partial<UserRow>): Promise<void> {
    const row = await this.getUser(email);
    if (!row) throw new Error('missing test user');
    Object.assign(row, fields);
  }

  async listSettings(): Promise<SettingRow[]> {
    return this.settings;
  }

  async setSetting(key: SettingRow['key'], value: string): Promise<void> {
    const row = this.settings.find((setting) => setting.key === key);
    if (row) row.value = value;
    else this.settings.push({ key, value });
  }

  async lockSetting(key: SettingRow['key']): Promise<string | null> {
    return this.settings.find((setting) => setting.key === key)?.value ?? null;
  }

  /**
   * These integration flows never rename a config value, so there is nothing to
   * rewrite here. Modelling it faithfully would need generic per-table row storage
   * this fake does not have; the column-level model lives in the admin service
   * tests, where rename is actually exercised. If a flow here ever starts renaming,
   * this must stop being a no-op or the flow will silently prove nothing.
   */
  async renameConfigValue(): Promise<void> {}

  async nextCustomerId(): Promise<string> {
    return `CUST-${String(this.customerSeq++).padStart(4, '0')}`;
  }

  async nextContactId(): Promise<string> {
    return `CT-${String(this.contactSeq++).padStart(4, '0')}`;
  }

  async nextCaseId(): Promise<string> {
    return `CASE-2026-${String(this.caseSeq++).padStart(4, '0')}`;
  }

  async nextQuoteNo(): Promise<string> {
    return `QTN-2026-${String(this.quoteSeq++).padStart(4, '0')}`;
  }

  async listContacts(customerId: string): Promise<Array<{ name: string; designation: string }>> {
    return this.contacts
      .filter((contact) => contact.customerId === customerId)
      .map((contact) => ({ name: contact.name, designation: contact.designation }));
  }

  async listCustomers(): Promise<CustomerRow[]> {
    return this.customers;
  }

  async getCustomer(id: string): Promise<CustomerRow | null> {
    return this.customers.find((customer) => customer.id === id) ?? null;
  }

  async getCustomersByIds(ids: string[]): Promise<CustomerRow[]> {
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
    this.contacts = this.contacts.filter((contact) => contact.customerId !== id);
    this.handlers = this.handlers.filter((handlerRow) => handlerRow.customerId !== id);
  }

  async moveCustomerToRecycleBin(customer: CustomerRow, deletedBy: string): Promise<void> {
    this.recycle.push({ ...customer, status: 'Archived', deletedBy, deletedAt: '2026-07-29T00:00:00.000Z' });
  }

  async listContactsByCustomer(customerId: string): Promise<ContactRow[]> {
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
        createdBy: row.createdBy,
        assignee: row.assignee,
        updatedAt: row.updatedAt
      }));
  }

  async listQuotesByCustomer(customerId: string): Promise<Awaited<ReturnType<CustomerRepository['listQuotesByCustomer']>>> {
    return this.quotes
      .filter((row) => row.customerId === customerId)
      .map((row) => ({
        quoteNo: row.quoteNo,
        rev: row.rev,
        caseId: row.caseId,
        customerId: row.customerId,
        title: row.title,
        source: row.source,
        status: row.status,
        total: row.total,
        currency: row.currency,
        fileName: row.fileName,
        doc: row.doc,
        pdf: row.pdf,
        createdAt: row.createdAt
      }));
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
    const row = await this.getContact(contactId);
    if (!row) throw new Error('missing test contact');
    Object.assign(row, fields);
  }

  async deleteContact(contactId: string): Promise<void> {
    this.contacts = this.contacts.filter((contact) => contact.id !== contactId);
  }

  async listHandlers(): Promise<HandlerRow[]> {
    return this.handlers;
  }

  async addHandler(handlerRow: HandlerRow): Promise<void> {
    this.handlers.push(handlerRow);
  }

  async removeHandler(customerId: string, email: string): Promise<void> {
    this.handlers = this.handlers.filter((row) => !(row.customerId === customerId && row.email === email));
  }

  async customersHandledBy(email: string): Promise<Array<{ customerId: string; name: string; tags: string[] }>> {
    const customerIds = new Set(
      this.handlers.filter((row) => row.email === email).map((row) => row.customerId)
    );
    return this.customers
      .filter((row) => customerIds.has(row.id))
      .map((row) => ({ customerId: row.id, name: row.name, tags: row.tags }));
  }

  async removeDirectHandlers(customerId: string): Promise<void> {
    this.handlers = this.handlers.filter((row) => !(row.customerId === customerId && row.email === 'direct'));
  }

  settingRows: Record<string, string> = {};

  async getSetting(key: string): Promise<string | null> {
    return this.settingRows[key] ?? null;
  }

  async hasCases(customerId: string): Promise<boolean> {
    return this.cases.some((row) => row.customerId === customerId);
  }

  async hasQuotations(customerId: string): Promise<boolean> {
    return this.quotes.some((row) => row.customerId === customerId);
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

  async listQuotesByCase(caseId: string): Promise<Awaited<ReturnType<CaseRepository['listQuotesByCase']>>> {
    return this.quotes
      .filter((quote) => quote.caseId === caseId)
      .map((quote) => ({
        caseId: quote.caseId,
        quoteNo: quote.quoteNo,
        rev: quote.rev,
        title: quote.title,
        total: Number(quote.total || 0),
        currency: quote.currency,
        status: quote.status,
        createdAt: quote.createdAt,
        createdBy: quote.createdBy,
        doc: quote.doc,
        pdf: quote.pdf
      }));
  }

  async latestQuotedValueByCase(): Promise<Record<string, number>> {
    return this.quotes
      .filter((quote) => quote.status !== 'Superseded')
      .reduce<Record<string, number>>((values, quote) => {
        values[quote.caseId] = Number(quote.total || 0);
        return values;
      }, {});
  }

  async listActivity(limit = 250) {
    return this.logs.slice(-limit).map((log, index) => ({
      when: log.when ?? `2026-07-29T00:00:${String(index).padStart(2, '0')}.000Z`,
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

  async listTemplates(): Promise<Array<{ id: string; name: string }>> {
    return [{ id: 'tpl-standard', name: 'Standard Quote' }];
  }

  async getQuote(quoteNo: string, rev: number): Promise<QuoteRow | null> {
    return this.quotes.find((quote) => quote.quoteNo === quoteNo && quote.rev === rev) ?? null;
  }

  async listQuotesByQuoteNo(quoteNo: string): Promise<QuoteRow[]> {
    return this.quotes.filter((quote) => quote.quoteNo === quoteNo);
  }

  async createQuote(row: QuoteRow): Promise<void> {
    this.quotes.push(row);
  }

  async updateQuote(quoteNo: string, rev: number, fields: Partial<QuoteRow>): Promise<void> {
    const row = await this.getQuote(quoteNo, rev);
    if (!row) throw new Error('missing test quote');
    Object.assign(row, fields);
  }

  async createBoqBlocks(_quoteNo: string, _rev: number, blocks: BoqBlock[]): Promise<void> {
    this.blocks.push(...blocks);
  }

  async listBoqBlocks(quoteNo: string, rev: number): Promise<BoqBlock[]> {
    return this.blocks.filter((block) => block.quoteNo === quoteNo && block.rev === rev);
  }

  async listImportCustomers() {
    return this.importCustomers;
  }

  async deleteImportCustomers(ids: string[]): Promise<void> {
    this.importCustomers = this.importCustomers.filter((row) => !ids.includes(row.id));
  }

  async listImportContacts() {
    return this.importContacts;
  }

  async deleteImportContacts(ids: string[]): Promise<void> {
    this.importContacts = this.importContacts.filter((row) => !ids.includes(row.id));
  }

  async listRecycleCustomers() {
    return this.recycle;
  }

  async getRecycleCustomer(id: string) {
    return this.recycle.find((customer) => customer.id === id) ?? null;
  }

  async deleteRecycleCustomer(id: string): Promise<void> {
    this.recycle = this.recycle.filter((customer) => customer.id !== id);
  }

  // Overloaded so this single implementation satisfies both CaseRepository's widened
  // logActivity (returns the new id) and AdminRepository/CustomerRepository/
  // QuoteRepository's unwidened logActivity (returns void) - this class implements
  // all of them at once.
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
    const id = `LOG-${this.logSeq++}`;
    this.logs.push(entry);
    this.logIds.push(id);
    return id;
  }

  async createAttachments(rows: Array<Omit<CaseAttachmentRow, 'id' | 'createdAt'>>): Promise<void> {
    const now = new Date().toISOString();
    for (const row of rows) {
      this.attachments.push({ ...row, id: `ATT-${this.attachmentSeq++}`, createdAt: now });
    }
  }

  async listAttachmentsByCase(caseId: string): Promise<CaseAttachmentRow[]> {
    return this.attachments.filter((row) => row.caseId === caseId);
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
}

function makeServices() {
  const repo = new CrmFlowRepository();
  const customerService = createCustomerService(repo);
  const caseService = createCaseService(repo);
  return {
    repo,
    adminService: createAdminService(repo),
    customerService,
    caseService,
    quoteService: createQuoteService(repo),
    dashboardService: createDashboardService(repo, { customerService, caseService })
  };
}

describe('CRM integrated service flows', () => {
  it('covers admin seeding, search-first customer creation, ticket visibility, quote stage changes, and won credit', async () => {
    const { repo, adminService, customerService, caseService, quoteService, dashboardService } = makeServices();

    await adminService.saveUser(admin, { email: sales.email, name: sales.name, role: 'L2', allowedTags: ['Punjab'] });
    await adminService.saveUser(admin, { email: handler.email, name: handler.name, role: 'L2', allowedTags: ['Punjab'] });
    await adminService.saveUser(admin, { email: assignee.email, name: assignee.name, role: 'L1', allowedTags: [] });

    expect(await customerService.searchCustomers(sales, 'alpha')).toEqual([]);

    const createdCustomer = await customerService.createCustomer(sales, {
      name: 'Alpha Panels',
      tags: ['Punjab'],
      type: 'OEM',
      priority: 'High',
      area: 'Ludhiana'
    });
    await customerService.addHandler(sales, createdCustomer.id, handler.email);

    const grid = await customerService.myCustomers(handler);
    expect(grid.customers).toEqual([expect.objectContaining({ id: createdCustomer.id, name: 'Alpha Panels' })]);

    const createdCase = await caseService.createCase(sales, createdCustomer.id, {
      title: 'Panel upgrade',
      stage: 'Opportunity',
      assignee: assignee.email
    });

    const assignedCase = await caseService.getCase(assignee, createdCase.id);
    expect(assignedCase.customer).toEqual({ id: createdCustomer.id, name: 'Alpha Panels', tags: ['Punjab'] });
    await expect(customerService.getCustomer(assignee, createdCustomer.id)).rejects.toThrow('access');

    const draft = await quoteService.createQuotation(sales, {
      customerId: createdCustomer.id,
      caseId: createdCase.id,
      title: 'Panel quotation',
      templateId: 'tpl-standard',
      subtotal: 1000,
      blocks: [{ title: 'Main', headers: ['Item', 'Amount'], rows: [['VFD', 1000]] }]
    });
    expect(repo.cases[0]).toMatchObject({ id: createdCase.id, stage: 'Opportunity' });

    await quoteService.setQuoteStatus(sales, draft.quoteNo, draft.rev, 'Sent');
    expect(repo.cases[0]).toMatchObject({ id: createdCase.id, stage: 'Quoted' });

    await caseService.setCaseOutcome(sales, createdCase.id, 'Won', {
      orderValue: 2500,
      categories: ['Panels'],
      note: 'PO received'
    });
    expect(repo.cases[0]).toMatchObject({ outcome: 'Won', assignee: '', orderValue: 2500 });

    const salesDash = await dashboardService.dashboard(sales);
    const handlerDash = await dashboardService.dashboard(handler);
    expect(salesDash.dash.stats.wonMonthValue).toBe(2500);
    expect(handlerDash.dash.stats.wonMonthValue).toBe(2500);
  });

  it('walks a customerless lead through mapping, quoting, revision and back to Quoted', async () => {
    const { repo, adminService, customerService, caseService, quoteService } = makeServices();

    // L3+ with a matching tag gets FULL access to a matching-tag customer purely by tag
    // match - never having been added as a handler. Also the case's creator, and creating
    // it below L5 with no explicit assignee makes salesRep its default assignee too, which
    // is what gives them visibility while the case is still customerless (no customer to
    // check tags against, and no handler claim from having created it). Used to prove
    // mapping neither needs nor grants handler membership.
    const salesRep: CrmContext = {
      email: 'lead-sales@automationsystems.org',
      name: 'Lead Sales',
      role: 'L3',
      allowedTags: ['Punjab'],
      active: true
    };
    const revisionHolder: CrmContext = {
      email: 'lead-holder@automationsystems.org',
      name: 'Lead Holder',
      role: 'L2',
      allowedTags: ['Punjab'],
      active: true
    };
    // No shared tag, not a handler, not an assignee, below L4 - genuinely unrelated to the case.
    const outsider: CrmContext = {
      email: 'lead-outsider@automationsystems.org',
      name: 'Lead Outsider',
      role: 'L2',
      allowedTags: ['Gujarat'],
      active: true
    };

    await adminService.saveUser(admin, { email: salesRep.email, name: salesRep.name, role: 'L3', allowedTags: ['Punjab'] });
    await adminService.saveUser(admin, { email: revisionHolder.email, name: revisionHolder.name, role: 'L2', allowedTags: ['Punjab'] });
    await adminService.saveUser(admin, { email: outsider.email, name: outsider.name, role: 'L2', allowedTags: ['Gujarat'] });

    // 1. A customerless (Lead) case can no longer be created through caseService -
    // createCase now requires a customer. A row with no customer can still exist from
    // before this rule (or from a migration), so it is injected directly here, matching
    // exactly what createCase used to produce for this input, to keep the rest of this
    // walk - mapping an already-existing unmapped case - covered.
    const leadCaseId = await repo.nextCaseId();
    const leadNow = new Date().toISOString();
    repo.cases.push({
      id: leadCaseId,
      customerId: '',
      title: 'Cold lead - panel enquiry',
      details: '',
      source: '',
      priority: '',
      stage: 'Lead',
      outcome: '',
      orderValue: '',
      wonCategories: [],
      outcomeNote: '',
      assignee: normalizeTestEmail(salesRep.email),
      closedOn: '',
      createdBy: normalizeTestEmail(salesRep.email),
      createdAt: leadNow,
      updatedAt: leadNow
    });

    const leadRow = repo.cases.find((row) => row.id === leadCaseId);
    expect(leadRow?.customerId).toBe('');

    // The case has no customer, so it has no real handler to derive one from - it is held
    // by the virtual Direct account (caseHandlers). This stays true throughout the walk
    // below, because the mapped customer never gains salesRep as a real handler either.
    const expectedHandlers = ['direct'];

    // 2. Someone with no relationship to the case cannot see it.
    await expect(caseService.getCase(outsider, leadCaseId)).rejects.toThrow(/access/i);

    // The creator (visible only as the case's default assignee, not as a handler) and an
    // L4+ can see it, even customerless.
    const ownedView = await caseService.getCase(salesRep, leadCaseId);
    expect(ownedView.customer).toBeNull();
    expect(ownedView.case.id).toBe(leadCaseId);
    expect(ownedView.case.handlerList.map((h) => h.email)).toEqual(expectedHandlers);

    // 3. First quotation saved against a real, fully-accessible customer - mapping happens
    // atomically inside that same call, by the case creator (salesRep) who has FULL customer access purely by
    // tag match and was never added as a handler.
    const customer = await customerService.createCustomer(admin, {
      name: 'Beta Switchgear',
      tags: ['Punjab'],
      type: 'OEM',
      priority: 'High',
      area: 'Mohali'
    });

    const logsBeforeMap = repo.logs.length;
    const firstQuote = await quoteService.createQuotation(salesRep, {
      customerId: customer.id,
      caseId: leadCaseId,
      title: 'Switchgear quotation',
      templateId: 'tpl-standard',
      subtotal: 5000,
      blocks: [{ title: 'Main', headers: ['Item', 'Amount'], rows: [['Panel', 5000]] }]
    });

    const mappedRow = repo.cases.find((row) => row.id === leadCaseId);
    expect(mappedRow?.customerId).toBe(customer.id);
    const mapActivities = repo.logs.slice(logsBeforeMap);
    expect(mapActivities).toContainEqual(
      expect.objectContaining({ action: 'CASE_CUSTOMER_MAP', entity: leadCaseId, customerId: customer.id })
    );
    // Mapping never grants handler membership.
    expect(repo.handlers.some((row) => row.customerId === customer.id && row.email === normalizeTestEmail(salesRep.email))).toBe(false);
    // caseHandlers is untouched by mapping - still the virtual Direct account, since the
    // mapped customer has no real handlers of its own either.
    expect((await caseService.getCase(salesRep, leadCaseId)).case.handlerList.map((h) => h.email)).toEqual(expectedHandlers);

    // 4. Marking the first quotation Sent moves the case to Quoted with no ticket holder.
    await quoteService.setQuoteStatus(salesRep, firstQuote.quoteNo, firstQuote.rev, 'Sent');
    const quotedRow = repo.cases.find((row) => row.id === leadCaseId);
    expect(quotedRow?.stage).toBe('Quoted');
    expect(quotedRow?.assignee).toBe('');
    expect((await caseService.getCase(salesRep, leadCaseId)).case.handlerList.map((h) => h.email)).toEqual(expectedHandlers);

    // 5. Requesting a revision moves Quoted -> Revision and sets the selected holder.
    await caseService.assignTicket(salesRep, leadCaseId, revisionHolder.email, 'please rework the pricing', undefined, true);
    const revisionRow = repo.cases.find((row) => row.id === leadCaseId);
    expect(revisionRow?.stage).toBe('Revision');
    expect(revisionRow?.assignee).toBe(normalizeTestEmail(revisionHolder.email));
    expect((await caseService.getCase(salesRep, leadCaseId)).case.handlerList.map((h) => h.email)).toEqual(expectedHandlers);

    // 6. A revision quotation is saved and marked Sent -> case returns to Quoted, holder cleared again.
    const revisionQuote = await quoteService.createQuotation(salesRep, {
      customerId: customer.id,
      caseId: leadCaseId,
      baseQuoteNo: firstQuote.quoteNo,
      title: 'Switchgear quotation - revised pricing',
      templateId: 'tpl-standard',
      subtotal: 4500,
      blocks: [{ title: 'Main', headers: ['Item', 'Amount'], rows: [['Panel', 4500]] }]
    });
    expect(revisionQuote.rev).toBe(firstQuote.rev + 1);

    await quoteService.setQuoteStatus(salesRep, revisionQuote.quoteNo, revisionQuote.rev, 'Sent');
    const backToQuotedRow = repo.cases.find((row) => row.id === leadCaseId);
    expect(backToQuotedRow?.stage).toBe('Quoted');
    expect(backToQuotedRow?.assignee).toBe('');
    expect((await caseService.getCase(salesRep, leadCaseId)).case.handlerList.map((h) => h.email)).toEqual(expectedHandlers);

    // Guardrail: an already-mapped case cannot be remapped to a different customer by a
    // later quotation.
    const otherCustomer = await customerService.createCustomer(admin, {
      name: 'Gamma Automation',
      tags: ['Punjab'],
      type: 'EPC',
      priority: 'Medium',
      area: 'Mohali'
    });
    await expect(
      quoteService.createQuotation(salesRep, {
        customerId: otherCustomer.id,
        caseId: leadCaseId,
        title: 'Should not remap',
        templateId: 'tpl-standard',
        subtotal: 100,
        blocks: [{ title: 'Main', headers: ['Item', 'Amount'], rows: [['X', 100]] }]
      })
    ).rejects.toThrow(/different customer/i);

    // Guardrail: a legacy customerless case cannot become Quoted or Won before it has a
    // customer. A new one can no longer be created this way, so it is injected directly.
    const otherLeadId = await repo.nextCaseId();
    const otherLeadNow = new Date().toISOString();
    repo.cases.push({
      id: otherLeadId,
      customerId: '',
      title: 'Another cold lead',
      details: '',
      source: '',
      priority: '',
      stage: 'Lead',
      outcome: '',
      orderValue: '',
      wonCategories: [],
      outcomeNote: '',
      assignee: normalizeTestEmail(salesRep.email),
      closedOn: '',
      createdBy: normalizeTestEmail(salesRep.email),
      createdAt: otherLeadNow,
      updatedAt: otherLeadNow
    });
    const otherLead = { id: otherLeadId };
    await expect(caseService.setCaseStage(salesRep, otherLead.id, 'Quoted')).rejects.toThrow(/map a customer/i);
    await expect(
      caseService.setCaseOutcome(salesRep, otherLead.id, 'Won', {
        orderValue: 1000,
        categories: ['Panels'],
        note: 'no customer yet'
      })
    ).rejects.toThrow(/map a customer/i);
  });

  it('agrees across all three case-creation paths on who owns the case: the account handlers, or Direct when there are none', async () => {
    const { repo, adminService, customerService, caseService, quoteService } = makeServices();

    // U has FULL customer access purely by L3 tag match - never a handler on either
    // customer below. Both createCase and quotation creation require FULL access, so an
    // L2 (NAME-only by tag) would be rejected; L3 is the minimum that clears that bar
    // without also being a handler.
    const u: CrmContext = {
      email: 'tag-match@automationsystems.org',
      name: 'Tag Match User',
      role: 'L3',
      allowedTags: ['Punjab'],
      active: true
    };
    const h: CrmContext = {
      email: 'real-handler@automationsystems.org',
      name: 'Real Handler',
      role: 'L2',
      allowedTags: ['Punjab'],
      active: true
    };
    await adminService.saveUser(admin, { email: u.email, name: u.name, role: 'L3', allowedTags: ['Punjab'] });
    await adminService.saveUser(admin, { email: h.email, name: h.name, role: 'L2', allowedTags: ['Punjab'] });

    async function createThreeWays(customerId: string) {
      const created = await caseService.createCase(u, customerId, { title: 'Via createCase', stage: 'Opportunity' });
      const quickLogged = await caseService.quickLog(u, { customerId, title: 'Via quickLog', stage: 'Opportunity' });
      const quoted = await quoteService.createQuotation(u, {
        customerId,
        title: 'Via first-quotation auto-case',
        templateId: 'tpl-standard',
        subtotal: 1000,
        blocks: [{ title: 'Main', headers: ['Item', 'Amount'], rows: [['Panel', 1000]] }]
      });
      await quoteService.setQuoteStatus(u, quoted.quoteNo, quoted.rev, 'Sent');
      return [created.id, quickLogged.caseId, quoted.caseId];
    }

    async function expectHandlers(caseIds: string[], expected: string[]) {
      for (const caseId of caseIds) {
        const detail = await caseService.getCase(u, caseId);
        expect(detail.case.handlerList.map((row) => row.email)).toEqual(expected);
      }
    }

    // A customer with a real handler H: all three creation paths must agree that H, not
    // the creator U, owns the resulting case.
    const handledCustomer = await customerService.createCustomer(admin, {
      name: 'Handled Co', tags: ['Punjab'], type: 'OEM', priority: 'High', area: 'Ludhiana'
    });
    await customerService.addHandler(admin, handledCustomer.id, h.email);
    await expectHandlers(await createThreeWays(handledCustomer.id), [h.email]);

    // A Direct-only customer (no real handler, created by an L6 admin so nobody becomes a
    // handler on creation): all three paths agree it is owned by Direct, not by U, its
    // creator - creating a case grants no handler claim on its own.
    const directCustomer = await customerService.createCustomer(admin, {
      name: 'Direct Co', tags: ['Punjab'], type: 'OEM', priority: 'High', area: 'Ludhiana'
    });
    expect(repo.handlers.filter((row) => row.customerId === directCustomer.id).map((row) => row.email)).toEqual(['direct']);
    await expectHandlers(await createThreeWays(directCustomer.id), ['direct']);
  });
});

function normalizeTestEmail(email: string): string {
  return email.trim().toLowerCase();
}
