import { describe, expect, it } from 'vitest';

import type { CrmContext } from '../auth/context';
import { createCustomerService, type CustomerRepository } from '../customers/service';
import { createCaseService, type CaseRepository } from '../cases/service';
import { createQuoteService, type QuoteRepository } from '../quotes/service';

type CustomerRow = Awaited<ReturnType<CustomerRepository['listCustomers']>>[number];
type ContactRow = Awaited<ReturnType<CustomerRepository['listContactsByCustomer']>>[number];
type HandlerRow = Awaited<ReturnType<CustomerRepository['listHandlers']>>[number];
type UserRow = Awaited<ReturnType<CustomerRepository['listUsers']>>[number];
type CaseRow = NonNullable<Awaited<ReturnType<CaseRepository['getCase']>>>;
type QuoteRow = NonNullable<Awaited<ReturnType<QuoteRepository['getQuote']>>>;
type BoqBlock = Awaited<ReturnType<QuoteRepository['listBoqBlocks']>>[number];

const sales: CrmContext = {
  email: 'sales@automationsystems.org',
  name: 'Sales User',
  role: 'L2',
  allowedTags: ['Punjab'],
  active: true
};

class Mutex {
  private chain = Promise.resolve();

  async run<T>(fn: () => Promise<T>): Promise<T> {
    const previous = this.chain;
    let release!: () => void;
    this.chain = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await fn();
    } finally {
      release();
    }
  }
}

class ConcurrentRepository implements CustomerRepository, CaseRepository, QuoteRepository {
  customers: CustomerRow[] = [];
  contacts: ContactRow[] = [];
  handlers: HandlerRow[] = [];
  users: UserRow[] = [];
  cases: CaseRow[] = [];
  quotes: QuoteRow[] = [];
  blocks: BoqBlock[] = [];
  logs: Array<{ action: string; entity: string; customerId: string; details: string; who: string }> = [];
  private readonly txLock = new Mutex();
  private customerSeq = 1;
  private contactSeq = 1;
  private caseSeq = 1;
  private quoteSeq = 1;

  constructor() {
    this.users = [
      { email: sales.email, name: sales.name, role: 'L2', allowedTags: ['Punjab'], active: true },
      { email: 'worker@automationsystems.org', name: 'Worker User', role: 'L1', allowedTags: [], active: true }
    ];
    this.customers = [this.customer({ id: 'CUST-9999', name: 'Anchor Account' })];
    this.handlers = [{ customerId: 'CUST-9999', email: sales.email, assignedBy: sales.email, assignedAt: 'now' }];
  }

  async withTransaction<T>(fn: (repo?: this) => Promise<T>): Promise<T> {
    return this.txLock.run(() => fn(this));
  }

  async lockCustomerName(): Promise<void> {}

  async lockQuoteFamily(): Promise<void> {}

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
        outcome: row.outcome,
        orderValue: row.orderValue,
        quotedValue: '',
        owners: [row.owner, ...row.extraOwners].filter(Boolean),
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
    return {};
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

  async addHandler(handler: HandlerRow): Promise<void> {
    this.handlers.push(handler);
  }

  async removeHandler(customerId: string, email: string): Promise<void> {
    this.handlers = this.handlers.filter((row) => !(row.customerId === customerId && row.email === email));
  }

  async removeDirectHandlers(customerId: string): Promise<void> {
    this.handlers = this.handlers.filter((row) => !(row.customerId === customerId && row.email === 'direct'));
  }

  async listUsers(): Promise<UserRow[]> {
    return this.users;
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
    return {};
  }

  async listActivityByEntity() {
    return [];
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

  async logActivity(entry: { action: string; entity: string; customerId: string; details: string; who: string }): Promise<void> {
    this.logs.push(entry);
  }

  customer(overrides: Partial<CustomerRow> = {}): CustomerRow {
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
      createdAt: '2026-07-29T00:00:00.000Z',
      updatedAt: '2026-07-29T00:00:00.000Z',
      ...overrides
    };
  }
}

function quoteInput(baseQuoteNo = '') {
  return {
    customerId: 'CUST-9999',
    caseId: 'CASE-2026-0001',
    baseQuoteNo,
    title: 'Panel quotation',
    templateId: 'tpl-standard',
    subtotal: 1000,
    blocks: [{ title: 'Main', headers: ['Item', 'Amount'], rows: [['VFD', 1000]] }]
  };
}

describe('CRM concurrency behavior', () => {
  it('allocates unique customer IDs under concurrent customer creation', async () => {
    const repo = new ConcurrentRepository();
    const service = createCustomerService(repo);

    const created = await Promise.all(
      Array.from({ length: 12 }, (_, index) =>
        service.createCustomer(sales, {
          name: `Concurrent Customer ${index}`,
          tags: ['Punjab'],
          type: 'OEM',
          priority: 'Medium'
        })
      )
    );

    expect(new Set(created.map((row) => row.id)).size).toBe(created.length);
    expect(created.map((row) => row.id)).toContain('CUST-0001');
    expect(created.map((row) => row.id)).toContain('CUST-0012');
  });

  it('allocates unique case IDs under concurrent case creation', async () => {
    const repo = new ConcurrentRepository();
    const service = createCaseService(repo);

    const created = await Promise.all(
      Array.from({ length: 10 }, (_, index) =>
        service.createCase(sales, 'CUST-9999', {
          title: `Concurrent Case ${index}`,
          stage: 'Lead',
          assignee: sales.email
        })
      )
    );

    expect(new Set(created.map((row) => row.id)).size).toBe(created.length);
    expect(created.map((row) => row.id)).toContain('CASE-2026-0001');
    expect(created.map((row) => row.id)).toContain('CASE-2026-0010');
  });

  it('serializes quote revisions so each concurrent revision gets one rev and supersedes older active revisions', async () => {
    const repo = new ConcurrentRepository();
    const service = createQuoteService(repo);
    repo.cases = [
      {
        id: 'CASE-2026-0001',
        customerId: 'CUST-9999',
        title: 'Panel upgrade',
        details: '',
        source: '',
        stage: 'Opportunity',
        outcome: '',
        orderValue: '',
        wonCategories: [],
        outcomeNote: '',
        owner: sales.email,
        extraOwners: [],
        assignee: sales.email,
        closedOn: '',
        createdBy: sales.email,
        createdAt: '2026-07-29T00:00:00.000Z',
        updatedAt: '2026-07-29T00:00:00.000Z'
      }
    ];

    const original = await service.createQuotation(sales, quoteInput());
    const revisions = await Promise.all([
      service.createQuotation(sales, quoteInput(original.quoteNo)),
      service.createQuotation(sales, quoteInput(original.quoteNo)),
      service.createQuotation(sales, quoteInput(original.quoteNo))
    ]);

    expect(revisions.map((row) => row.rev).sort((a, b) => a - b)).toEqual([1, 2, 3]);
    expect(repo.quotes.filter((quote) => quote.quoteNo === original.quoteNo && quote.status === 'Draft')).toHaveLength(1);
    expect(repo.quotes.find((quote) => quote.rev === 3)?.status).toBe('Draft');
  });

  it('applies grid patches without overwriting unrelated field changes', async () => {
    const repo = new ConcurrentRepository();
    const service = createCustomerService(repo);

    await Promise.all([
      service.saveCustomerCells(sales, [{ id: 'CUST-9999', fields: { priority: 'High' } }]),
      service.saveCustomerCells(sales, [{ id: 'CUST-9999', fields: { area: 'Mohali' } }])
    ]);

    expect(repo.customers[0]).toMatchObject({ priority: 'High', area: 'Mohali' });
  });
});
