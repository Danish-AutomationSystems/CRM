import { beforeEach, describe, expect, it } from 'vitest';

import type { CrmContext } from '../auth/context';
import { createQuoteService, type QuoteRepository } from './service';

const sales: CrmContext = {
  email: 'sales@automationsystems.org',
  name: 'Sales User',
  role: 'L2',
  allowedTags: ['Punjab'],
  active: true
};

type CustomerRow = NonNullable<Awaited<ReturnType<QuoteRepository['getCustomer']>>>;
type CaseRow = NonNullable<Awaited<ReturnType<QuoteRepository['getCase']>>>;
type HandlerRow = Awaited<ReturnType<QuoteRepository['listHandlers']>>[number];
type UserRow = Awaited<ReturnType<QuoteRepository['listUsers']>>[number];
type QuoteRow = NonNullable<Awaited<ReturnType<QuoteRepository['getQuote']>>>;
type BoqBlock = Awaited<ReturnType<QuoteRepository['listBoqBlocks']>>[number];

class FakeQuoteRepository implements QuoteRepository {
  customers: CustomerRow[] = [];
  cases: CaseRow[] = [];
  handlers: HandlerRow[] = [];
  users: UserRow[] = [];
  quotes: QuoteRow[] = [];
  blocks: BoqBlock[] = [];
  logs: Array<{ action: string; entity: string; customerId: string; details: string; who: string }> = [];
  quoteSeq = 1;
  caseSeq = 2;

  async withTransaction<T>(fn: (repo?: QuoteRepository) => Promise<T>): Promise<T> {
    return fn(this);
  }

  async nextQuoteNo(): Promise<string> {
    return `QTN-2026-${String(this.quoteSeq++).padStart(4, '0')}`;
  }

  async nextCaseId(): Promise<string> {
    return `CASE-2026-${String(this.caseSeq++).padStart(4, '0')}`;
  }

  async listTemplates(): Promise<Array<{ id: string; name: string }>> {
    return [
      { id: 'tpl-standard', name: 'Standard Quote' },
      { id: 'tpl-project', name: 'Project Quote' }
    ];
  }

  async getCustomer(id: string): Promise<CustomerRow | null> {
    return this.customers.find((customer) => customer.id === id) ?? null;
  }

  async listUsers(): Promise<UserRow[]> {
    return this.users;
  }

  async listHandlers(): Promise<HandlerRow[]> {
    return this.handlers;
  }

  async getCase(id: string): Promise<CaseRow | null> {
    return this.cases.find((row) => row.id === id) ?? null;
  }

  async createCase(row: CaseRow): Promise<void> {
    this.cases.push(row);
  }

  async updateCase(id: string, fields: Partial<CaseRow>): Promise<void> {
    const row = await this.getCase(id);
    if (!row) throw new Error('missing test case');
    Object.assign(row, fields);
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

  async createBoqBlocks(quoteNo: string, rev: number, blocks: BoqBlock[]): Promise<void> {
    this.blocks = this.blocks.filter((block) => !(block.quoteNo === quoteNo && block.rev === rev));
    this.blocks.push(...blocks);
  }

  async listBoqBlocks(quoteNo: string, rev: number): Promise<BoqBlock[]> {
    return this.blocks
      .filter((block) => block.quoteNo === quoteNo && block.rev === rev)
      .sort((a, b) => a.block - b.block);
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
    address: 'Industrial Area',
    gstin: '03AAAAA0000A1Z5',
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
    details: 'Upgrade details',
    source: 'Direct Enquiry',
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
    createdAt: '2026-07-01T00:00:00.000Z',
    updatedAt: '2026-07-01T00:00:00.000Z',
    ...overrides
  };
}

function user(overrides: Partial<UserRow> = {}): UserRow {
  return {
    email: sales.email,
    name: sales.name,
    role: 'L2',
    allowedTags: ['Punjab'],
    active: true,
    ...overrides
  };
}

function makeQuote(overrides: Partial<QuoteRow> = {}): QuoteRow {
  return {
    quoteNo: 'QTN-2026-0001',
    rev: 0,
    caseId: 'CASE-2026-0001',
    customerId: 'CUST-0001',
    title: 'Panel quotation',
    source: 'Generated',
    fileName: '',
    templateId: 'tpl-standard',
    templateName: 'Standard Quote',
    status: 'Draft',
    subtotal: 1000,
    taxPct: 18,
    taxAmount: 180,
    total: 1180,
    currency: 'INR',
    validUntil: '2026-08-31',
    notes: 'Standard terms',
    doc: '',
    pdf: '',
    createdBy: sales.email,
    createdAt: '2026-07-29T00:00:00.000Z',
    updatedAt: '2026-07-29T00:00:00.000Z',
    ...overrides
  };
}

function makeService() {
  const repo = new FakeQuoteRepository();
  repo.customers = [customer()];
  repo.cases = [caseRow()];
  repo.handlers = [{ customerId: 'CUST-0001', email: sales.email, assignedBy: sales.email, assignedAt: 'now' }];
  repo.users = [
    user(),
    user({ email: 'manager@automationsystems.org', name: 'Manager User', role: 'L4', allowedTags: ['*'] }),
    user({ email: 'outsider@automationsystems.org', name: 'Outsider', allowedTags: ['NCR'] })
  ];
  return { repo, service: createQuoteService(repo) };
}

describe('quote service generated quotations', () => {
  it('allocates QTN number, starts at R0, stores BOQ JSON blocks, and keeps Draft case at Opportunity', async () => {
    const { repo, service } = makeService();

    const result = await service.createQuotation(sales, {
      customerId: 'CUST-0001',
      caseId: 'CASE-2026-0001',
      title: 'Panel quotation',
      templateId: 'tpl-standard',
      subtotal: 1000,
      taxPct: 18,
      currency: 'INR',
      validUntil: '2026-08-31',
      notes: 'Standard terms',
      blocks: [
        {
          title: 'Main BOQ',
          headers: ['Item', 'Qty', 'Price', ''],
          rows: [
            ['VFD', 2, 500, 'ignored'],
            ['', '', '', '']
          ]
        }
      ]
    });

    expect(result).toEqual({ quoteNo: 'QTN-2026-0001', rev: 0, caseId: 'CASE-2026-0001' });
    expect(repo.quotes[0]).toMatchObject({
      quoteNo: 'QTN-2026-0001',
      rev: 0,
      source: 'Generated',
      status: 'Draft',
      subtotal: 1000,
      taxPct: 18,
      taxAmount: 180,
      total: 1180,
      doc: '',
      pdf: ''
    });
    expect(repo.blocks).toEqual([
      {
        quoteNo: 'QTN-2026-0001',
        rev: 0,
        block: 1,
        title: 'Main BOQ',
        headers: ['Item', 'Qty', 'Price'],
        rows: [['VFD', '2', '500']]
      }
    ]);
    expect(repo.cases[0].stage).toBe('Opportunity');
  });

  it('creates an Opportunity case for Draft quotes without a selected case and validates case ownership', async () => {
    const { repo, service } = makeService();
    repo.cases = [];

    const result = await service.createQuotation(sales, {
      customerId: 'CUST-0001',
      title: 'Auto case quote',
      templateId: 'tpl-standard',
      subtotal: 0,
      blocks: [{ headers: ['Item'], rows: [['Panel']] }]
    });

    expect(result.caseId).toBe('CASE-2026-0002');
    expect(repo.cases[0]).toMatchObject({
      id: 'CASE-2026-0002',
      customerId: 'CUST-0001',
      title: 'Auto case quote',
      stage: 'Opportunity',
      details: 'Auto-created with quotation QTN-2026-0001'
    });

    repo.cases.push(caseRow({ id: 'CASE-2026-0999', customerId: 'CUST-9999' }));
    await expect(
      service.createQuotation(sales, {
        customerId: 'CUST-0001',
        caseId: 'CASE-2026-0999',
        title: 'Wrong case',
        templateId: 'tpl-standard',
        blocks: [{ headers: ['Item'], rows: [['Panel']] }]
      })
    ).rejects.toThrow('different customer');
  });

  it('increments revisions and supersedes earlier Draft/Sent revisions', async () => {
    const { repo, service } = makeService();
    repo.quotes = [makeQuote({ status: 'Sent' })];

    const result = await service.createQuotation(sales, {
      customerId: 'CUST-0001',
      baseQuoteNo: 'QTN-2026-0001',
      title: 'Revision',
      templateId: 'tpl-standard',
      subtotal: 500,
      blocks: [{ headers: ['Item'], rows: [['Panel']] }]
    });

    expect(result).toEqual({ quoteNo: 'QTN-2026-0001', rev: 1, caseId: 'CASE-2026-0001' });
    expect(repo.quotes[0].status).toBe('Superseded');
    expect(repo.quotes[1]).toMatchObject({ quoteNo: 'QTN-2026-0001', rev: 1, status: 'Draft' });
  });
});

describe('quote service external uploads and status changes', () => {
  it('stores external upload metadata without Google Drive links and advances open Sent cases to Quoted', async () => {
    const { repo, service } = makeService();

    const result = await service.uploadQuotation(sales, {
      customerId: 'CUST-0001',
      caseId: 'CASE-2026-0001',
      title: 'Vendor offer',
      fileName: 'vendor-offer.pdf',
      mimeType: 'application/pdf',
      dataB64: Buffer.from('external quotation').toString('base64'),
      total: 2500,
      currency: 'INR',
      status: 'Sent'
    });

    expect(result).toEqual({ quoteNo: 'QTN-2026-0001', rev: 0, caseId: 'CASE-2026-0001' });
    expect(repo.quotes[0]).toMatchObject({
      source: 'External',
      fileName: 'vendor-offer.pdf',
      status: 'Sent',
      subtotal: '',
      taxPct: '',
      taxAmount: '',
      total: 2500,
      doc: '',
      pdf: '/api/download/quote/QTN-2026-0001/0'
    });
    expect(repo.cases[0].stage).toBe('Quoted');
  });

  it('creates Draft external auto-cases at Opportunity and Sent external auto-cases at Quoted', async () => {
    const { repo, service } = makeService();
    repo.cases = [];

    const draft = await service.uploadQuotation(sales, {
      customerId: 'CUST-0001',
      title: 'Draft upload',
      fileName: 'draft.xlsx',
      dataB64: 'abc',
      total: -1,
      status: 'Draft'
    });
    const sent = await service.uploadQuotation(sales, {
      customerId: 'CUST-0001',
      title: 'Sent upload',
      fileName: 'sent.pdf',
      dataB64: 'abc',
      total: 300,
      status: 'Sent'
    });

    expect(repo.cases.find((row) => row.id === draft.caseId)?.stage).toBe('Opportunity');
    expect(repo.cases.find((row) => row.id === sent.caseId)?.stage).toBe('Quoted');
    expect(repo.quotes[0].total).toBe(0);
  });

  it('marks Sent quotes and does not move closed or held cases', async () => {
    const { repo, service } = makeService();
    repo.quotes = [makeQuote({ status: 'Draft' })];

    await service.setQuoteStatus(sales, 'QTN-2026-0001', 0, 'Sent');
    expect(repo.quotes[0].status).toBe('Sent');
    expect(repo.cases[0].stage).toBe('Quoted');

    repo.cases[0] = caseRow({ stage: 'Opportunity', outcome: 'Hold' });
    await service.setQuoteStatus(sales, 'QTN-2026-0001', 0, 'Sent');
    expect(repo.cases[0].stage).toBe('Opportunity');

    repo.cases[0] = caseRow({ stage: 'Opportunity', outcome: 'Won' });
    await service.setQuoteStatus(sales, 'QTN-2026-0001', 0, 'Sent');
    expect(repo.cases[0].stage).toBe('Opportunity');
  });
});

describe('quote reads and direct download metadata', () => {
  beforeEach(() => {
    process.env.CRM_COMPANY_NAME = 'Automation Systems NG Pvt Ltd';
  });

  it('returns quote details, customer, BOQ blocks, and revisions sorted descending', async () => {
    const { repo, service } = makeService();
    repo.quotes = [
      makeQuote({ rev: 0, status: 'Superseded' }),
      makeQuote({ rev: 1, title: 'Revision', status: 'Draft', total: 590 })
    ];
    repo.blocks = [
      { quoteNo: 'QTN-2026-0001', rev: 1, block: 1, title: 'BOQ', headers: ['Item'], rows: [['Panel']] }
    ];

    const result = await service.getQuotation(sales, 'QTN-2026-0001', 1);

    expect(result.quote).toMatchObject({
      quoteNo: 'QTN-2026-0001',
      rev: 1,
      title: 'Revision',
      by: 'Sales User',
      pdf: ''
    });
    expect(result.customer).toEqual({ id: 'CUST-0001', name: 'Alpha Panels' });
    expect(result.blocks).toEqual(repo.blocks);
    expect(result.revisions).toEqual([
      { rev: 1, status: 'Draft', date: expect.any(String), total: 590 },
      { rev: 0, status: 'Superseded', date: expect.any(String), total: 1180 }
    ]);
  });

  it('generates direct download metadata instead of Drive links and blocks external generation', async () => {
    const { repo, service } = makeService();
    repo.quotes = [makeQuote()];
    repo.blocks = [{ quoteNo: 'QTN-2026-0001', rev: 0, block: 1, title: 'BOQ', headers: ['Item'], rows: [['Panel']] }];

    const result = await service.generateQuoteDoc(sales, 'QTN-2026-0001', 0);

    expect(result).toEqual({
      doc: {
        fileName: 'QTN-2026-0001-R0-Alpha Panels.html',
        mimeType: 'text/html; charset=utf-8',
        url: '/api/download/quote/QTN-2026-0001/0?format=html'
      },
      pdf: {
        fileName: 'QTN-2026-0001-R0-Alpha Panels.html',
        mimeType: 'text/html; charset=utf-8',
        url: '/api/download/quote/QTN-2026-0001/0?format=html'
      }
    });
    expect(repo.quotes[0]).toMatchObject({
      doc: '/api/download/quote/QTN-2026-0001/0?format=html',
      pdf: '/api/download/quote/QTN-2026-0001/0?format=html'
    });

    repo.quotes[0] = makeQuote({ source: 'External', fileName: 'external.pdf', templateId: '', pdf: '/api/download/quote/QTN-2026-0001/0' });
    await expect(service.generateQuoteDoc(sales, 'QTN-2026-0001', 0)).rejects.toThrow('external file');
  });

  it('enforces full customer access before rendering a download artifact', async () => {
    const { repo, service } = makeService();
    repo.quotes = [makeQuote()];
    repo.blocks = [{ quoteNo: 'QTN-2026-0001', rev: 0, block: 1, title: 'BOQ', headers: ['Item'], rows: [['Panel']] }];

    const artifact = await service.getDownloadArtifact(sales, 'QTN-2026-0001', 0);
    expect(artifact.fileName).toBe('QTN-2026-0001-R0-Alpha Panels.html');
    expect(artifact.body).toContain('Panel quotation');

    await expect(
      service.getDownloadArtifact({ ...sales, email: 'outsider@automationsystems.org', allowedTags: ['NCR'] }, 'QTN-2026-0001', 0)
    ).rejects.toThrow('not an account handler');
  });
});
