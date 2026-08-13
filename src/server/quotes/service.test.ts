import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { CrmContext } from '../auth/context';
import { createQuoteService, type QuoteRepository, type QuoteServiceDeps } from './service';

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
  contacts: Array<{ name: string; designation: string }> = [];
  logs: Array<{ action: string; entity: string; customerId: string; details: string; who: string }> = [];
  lockedQuoteFamilies: string[] = [];
  quoteSeq = 1;
  caseSeq = 2;

  async withTransaction<T>(fn: (repo?: QuoteRepository) => Promise<T>): Promise<T> {
    return fn(this);
  }

  async lockQuoteFamily(quoteNo: string): Promise<void> {
    this.lockedQuoteFamilies.push(quoteNo.trim().toUpperCase());
  }

  async nextQuoteNo(): Promise<string> {
    return `QTN-2026-${String(this.quoteSeq++).padStart(4, '0')}`;
  }

  async nextCaseId(): Promise<string> {
    return `CASE-2026-${String(this.caseSeq++).padStart(4, '0')}`;
  }

  async listContacts(): Promise<Array<{ name: string; designation: string }>> {
    return this.contacts;
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
    sei: [],
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
      uploadMimeType: '',
      uploadDataB64: '',
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
    driveFileId: '',
    driveViewLink: '',
    driveSavedAt: '',
    driveSavedBy: '',
    createdBy: sales.email,
    createdAt: '2026-07-29T00:00:00.000Z',
    updatedAt: '2026-07-29T00:00:00.000Z',
    ...overrides
  };
}

function makeService(deps: QuoteServiceDeps = {}) {
  const repo = new FakeQuoteRepository();
  repo.customers = [customer()];
  repo.cases = [caseRow()];
  repo.handlers = [{ customerId: 'CUST-0001', email: sales.email, assignedBy: sales.email, assignedAt: 'now' }];
  repo.users = [
    user(),
    user({ email: 'manager@automationsystems.org', name: 'Manager User', role: 'L4', allowedTags: ['*'] }),
    user({ email: 'outsider@automationsystems.org', name: 'Outsider', allowedTags: ['NCR'] })
  ];
  // Provide default Drive mocks if not overridden
  const finalDeps: QuoteServiceDeps = {
    getDriveClient: () => ({
      uploadFile: vi.fn().mockResolvedValue({ id: 'pdf-1', webViewLink: 'https://drive.google.com/file/d/pdf-1/view' }),
      listDocsInFolder: vi.fn().mockResolvedValue([]),
      copyFile: vi.fn().mockResolvedValue({ id: 'copy-1', webViewLink: 'https://drive.google.com/file/d/copy-1/view' }),
      exportPdf: vi.fn().mockResolvedValue(Buffer.from('%PDF-1.4')),
      shareDomainReadable: vi.fn().mockResolvedValue(undefined),
      renameFile: vi.fn().mockResolvedValue(undefined),
      deleteFile: vi.fn().mockResolvedValue(undefined)
    }),
    getQuotationsFolderId: async () => 'folder-out',
    ...deps
  };
  return { repo, service: createQuoteService(repo, finalDeps) };
}

function fakeDriveDeps(overrides: Partial<{
  upload: (input: { fileName: string; mimeType: string; body: Buffer }, folderId: string) => Promise<{ id: string; webViewLink: string }>;
  rename: (fileId: string, name: string) => Promise<void>;
  remove: (fileId: string) => Promise<void>;
}> = {}) {
  const calls = {
    uploaded: [] as Array<{ fileName: string; folderId: string; body: Buffer }>,
    renamed: [] as Array<{ fileId: string; name: string }>,
    deleted: [] as string[]
  };
  const deps: QuoteServiceDeps = {
    getQuotationsFolderId: async () => 'folder-abc',
    getDriveClient: () =>
      ({
        async uploadFile(input: { fileName: string; mimeType: string; body: Buffer }, folderId: string) {
          calls.uploaded.push({ fileName: input.fileName, folderId, body: input.body });
          if (overrides.upload) return overrides.upload(input, folderId);
          return { id: 'drive-file-1', webViewLink: 'https://drive.google.com/file/d/drive-file-1/view' };
        },
        async renameFile(fileId: string, name: string) {
          calls.renamed.push({ fileId, name });
          if (overrides.rename) return overrides.rename(fileId, name);
        },
        async deleteFile(fileId: string) {
          calls.deleted.push(fileId);
          if (overrides.remove) return overrides.remove(fileId);
        },
        async listDocsInFolder() { return []; },
        async copyFile() { return { id: '', webViewLink: '' }; },
        async exportPdf() { return Buffer.alloc(0); },
        async shareDomainReadable() { return undefined; }
      }) as never
  };
  return { deps, calls };
}

describe('quote service template listing', () => {
  it('lists templates from the injected Drive-backed source, sorted by name', async () => {
    const repo = new FakeQuoteRepository();
    const listTemplates = vi.fn().mockResolvedValue([
      { id: 'tpl-b', name: 'Project Quote' },
      { id: 'tpl-a', name: 'Annual Contract' }
    ]);
    const service = createQuoteService(repo, { listTemplates });

    const result = await service.listTemplates(sales);

    expect(result).toEqual([
      { id: 'tpl-a', name: 'Annual Contract' },
      { id: 'tpl-b', name: 'Project Quote' }
    ]);
    expect(listTemplates).toHaveBeenCalledTimes(1);
  });
});

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
    expect(repo.lockedQuoteFamilies).toEqual(['QTN-2026-0001']);
  });
});

describe('quote service external uploads and status changes', () => {
  it('stores external upload metadata with Google Drive links, not the blob, and advances open Sent cases to Quoted', async () => {
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
      uploadMimeType: 'application/pdf',
      uploadDataB64: '',
      status: 'Sent',
      subtotal: '',
      taxPct: '',
      taxAmount: '',
      total: 2500,
      doc: '',
      pdf: '',
      driveFileId: 'pdf-1',
      driveViewLink: 'https://drive.google.com/file/d/pdf-1/view'
    });
    expect(repo.cases[0].stage).toBe('Quoted');
  });

  it('refuses to build a download artifact for a Drive-hosted upload', async () => {
    const { deps } = fakeDriveDeps();
    const { repo, service } = makeService(deps);

    const result = await service.uploadQuotation(sales, {
      customerId: 'CUST-0001',
      caseId: 'CASE-2026-0001',
      title: 'Vendor offer',
      fileName: 'vendor-offer.pdf',
      dataB64: Buffer.from('x').toString('base64'),
      total: 100,
      status: 'Sent'
    });

    expect(repo.quotes[0].uploadDataB64).toBe('');
    await expect(service.getDownloadArtifact(sales, result.quoteNo, result.rev)).rejects.toThrow(
      /stored in Google Drive/
    );
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

  it('refuses to upload a quotation when Drive is not configured', async () => {
    const repo = new FakeQuoteRepository();
    repo.customers = [customer()];
    repo.cases = [caseRow()];
    repo.handlers = [{ customerId: 'CUST-0001', email: sales.email, assignedBy: sales.email, assignedAt: 'now' }];
    repo.users = [user()];
    const service = createQuoteService(repo); // no deps: Drive unavailable

    await expect(
      service.uploadQuotation(sales, {
        customerId: 'CUST-0001',
        title: 'Vendor offer',
        fileName: 'vendor-offer.pdf',
        mimeType: 'application/pdf',
        dataB64: Buffer.from('external quotation').toString('base64'),
        total: 100,
        status: 'Sent'
      })
    ).rejects.toThrow(/Google Drive is not configured/);

    expect(repo.quotes).toHaveLength(0);
  });

  it('stores an uploaded quotation in Drive and not in the database', async () => {
    const { deps, calls } = fakeDriveDeps();
    const { repo, service } = makeService(deps);

    const result = await service.uploadQuotation(sales, {
      customerId: 'CUST-0001',
      caseId: 'CASE-2026-0001',
      title: 'Vendor offer',
      fileName: 'vendor-offer.pdf',
      mimeType: 'application/pdf',
      dataB64: Buffer.from('external quotation').toString('base64'),
      total: 100,
      status: 'Sent'
    });

    const stored = repo.quotes.find((q) => q.quoteNo === result.quoteNo && q.rev === result.rev)!;
    expect(stored.uploadDataB64).toBe('');
    expect(stored.pdf).toBe('');
    expect(stored.driveFileId).toBe('drive-file-1');
    expect(stored.driveViewLink).toBe('https://drive.google.com/file/d/drive-file-1/view');
    expect(stored.driveSavedBy).toBe('sales@automationsystems.org');
    expect(stored.driveSavedAt).not.toBe('');

    expect(calls.uploaded).toHaveLength(1);
    expect(calls.uploaded[0].folderId).toBe('folder-abc');
    expect(calls.uploaded[0].body.toString()).toBe('external quotation');
    expect(calls.uploaded[0].fileName).toBe('Alpha Panels - vendor-offer.pdf');
  });

  it('renames the Drive file to the full convention after the transaction commits', async () => {
    const { deps, calls } = fakeDriveDeps();
    const { service } = makeService(deps);

    const result = await service.uploadQuotation(sales, {
      customerId: 'CUST-0001',
      caseId: 'CASE-2026-0001',
      title: 'Vendor offer',
      fileName: 'vendor-offer.pdf',
      dataB64: Buffer.from('x').toString('base64'),
      total: 100,
      status: 'Sent'
    });

    expect(calls.renamed).toEqual([
      { fileId: 'drive-file-1', name: `${result.quoteNo} R${result.rev} - Alpha Panels - vendor-offer.pdf` }
    ]);
  });

  it('writes nothing to the database when the Drive upload fails', async () => {
    const { deps } = fakeDriveDeps({
      upload: async () => {
        throw new Error('Drive quota exceeded.');
      }
    });
    const { repo, service } = makeService(deps);

    await expect(
      service.uploadQuotation(sales, {
        customerId: 'CUST-0001',
        caseId: 'CASE-2026-0001',
        title: 'Vendor offer',
        fileName: 'vendor-offer.pdf',
        dataB64: Buffer.from('x').toString('base64'),
        total: 100,
        status: 'Sent'
      })
    ).rejects.toThrow('Drive quota exceeded.');

    expect(repo.quotes).toHaveLength(0);
    expect(repo.logs).toHaveLength(0);
  });

  it('deletes the orphaned Drive file when the transaction fails', async () => {
    const { deps, calls } = fakeDriveDeps();
    const { repo, service } = makeService(deps);
    repo.createQuote = async () => {
      throw new Error('database write failed');
    };

    await expect(
      service.uploadQuotation(sales, {
        customerId: 'CUST-0001',
        caseId: 'CASE-2026-0001',
        title: 'Vendor offer',
        fileName: 'vendor-offer.pdf',
        dataB64: Buffer.from('x').toString('base64'),
        total: 100,
        status: 'Sent'
      })
    ).rejects.toThrow('database write failed');

    expect(calls.deleted).toEqual(['drive-file-1']);
  });

  it('surfaces the original error when the orphan cleanup also fails', async () => {
    const { deps } = fakeDriveDeps({
      remove: async () => {
        throw new Error('drive delete failed');
      }
    });
    const { repo, service } = makeService(deps);
    repo.createQuote = async () => {
      throw new Error('database write failed');
    };

    await expect(
      service.uploadQuotation(sales, {
        customerId: 'CUST-0001',
        caseId: 'CASE-2026-0001',
        title: 'Vendor offer',
        fileName: 'vendor-offer.pdf',
        dataB64: Buffer.from('x').toString('base64'),
        total: 100,
        status: 'Sent'
      })
    ).rejects.toThrow('database write failed');
  });

  it('still succeeds when the post-commit rename fails', async () => {
    const { deps } = fakeDriveDeps({
      rename: async () => {
        throw new Error('drive rename failed');
      }
    });
    const { repo, service } = makeService(deps);

    const result = await service.uploadQuotation(sales, {
      customerId: 'CUST-0001',
      caseId: 'CASE-2026-0001',
      title: 'Vendor offer',
      fileName: 'vendor-offer.pdf',
      dataB64: Buffer.from('x').toString('base64'),
      total: 100,
      status: 'Sent'
    });

    const stored = repo.quotes.find((q) => q.quoteNo === result.quoteNo)!;
    expect(stored.driveFileId).toBe('drive-file-1');
  });
});

describe('quote repository Drive save fields', () => {
  it('updateQuote persists Drive save fields', async () => {
    const repo = new FakeQuoteRepository();
    repo.quotes.push({
      quoteNo: 'QTN-2026-0001',
      rev: 0,
      caseId: '',
      customerId: 'CUST-1',
      title: 'Test quote',
      source: 'Generated',
      fileName: '',
      uploadMimeType: '',
      uploadDataB64: '',
      templateId: '',
      templateName: '',
      status: 'Draft',
      subtotal: 100,
      taxPct: 18,
      taxAmount: 18,
      total: 118,
      currency: 'INR',
      validUntil: '',
      notes: '',
      doc: '',
      pdf: '',
      driveFileId: '',
      driveViewLink: '',
      driveSavedAt: '',
      driveSavedBy: '',
      createdBy: 'sales@automationsystems.org',
      createdAt: '2026-07-01T00:00:00.000Z',
      updatedAt: '2026-07-01T00:00:00.000Z'
    });

    await repo.updateQuote('QTN-2026-0001', 0, {
      driveFileId: 'file-123',
      driveViewLink: 'https://drive.google.com/file/d/file-123/view',
      driveSavedAt: '2026-07-31T10:00:00.000Z',
      driveSavedBy: 'sales@automationsystems.org'
    });

    const updated = await repo.getQuote('QTN-2026-0001', 0);
    expect(updated?.driveFileId).toBe('file-123');
    expect(updated?.driveViewLink).toBe('https://drive.google.com/file/d/file-123/view');
    expect(updated?.driveSavedBy).toBe('sales@automationsystems.org');
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

  it('returns uploaded external quotation bytes instead of a placeholder artifact', async () => {
    const { repo, service } = makeService();
    repo.quotes = [
      makeQuote({
        source: 'External',
        fileName: 'vendor-offer.pdf',
        uploadMimeType: 'application/pdf',
        uploadDataB64: Buffer.from('external quotation').toString('base64'),
        templateId: '',
        templateName: '',
        pdf: '/api/download/quote/QTN-2026-0001/0'
      })
    ];

    const artifact = await service.getDownloadArtifact(sales, 'QTN-2026-0001', 0);

    expect(artifact.fileName).toBe('vendor-offer.pdf');
    expect(artifact.mimeType).toBe('application/pdf');
    expect(Buffer.from(artifact.body as Uint8Array).toString()).toBe('external quotation');
  });
});

describe('generateQuoteDoc', () => {
  const markerDoc = {
    body: {
      content: [
        {
          startIndex: 40,
          paragraph: { elements: [{ startIndex: 40, textRun: { content: '{{BOQ_TABLE}}\n' } }] }
        }
      ]
    }
  };

  // Two tables read back after insertion: the BOQ block (2x2) then totals (3x2).
  const tablesDoc = {
    body: {
      content: [
        {
          startIndex: 41,
          table: {
            tableRows: [
              { tableCells: [{ content: [{ startIndex: 43 }] }, { content: [{ startIndex: 46 }] }] },
              { tableCells: [{ content: [{ startIndex: 49 }] }, { content: [{ startIndex: 52 }] }] }
            ]
          }
        },
        {
          startIndex: 60,
          table: {
            tableRows: [
              { tableCells: [{ content: [{ startIndex: 62 }] }, { content: [{ startIndex: 65 }] }] },
              { tableCells: [{ content: [{ startIndex: 68 }] }, { content: [{ startIndex: 71 }] }] },
              { tableCells: [{ content: [{ startIndex: 74 }] }, { content: [{ startIndex: 77 }] }] }
            ]
          }
        }
      ]
    }
  };

  function makeClients(firstDoc: unknown = markerDoc) {
    const driveClient = {
      uploadFile: vi.fn().mockResolvedValue({ id: 'pdf-1', webViewLink: 'https://drive.google.com/file/d/pdf-1/view' }),
      listDocsInFolder: vi.fn().mockResolvedValue([]),
      copyFile: vi.fn().mockResolvedValue({ id: 'copy-1', webViewLink: 'https://drive.google.com/file/d/copy-1/view' }),
      exportPdf: vi.fn().mockResolvedValue(Buffer.from('%PDF-1.4')),
      shareDomainReadable: vi.fn().mockResolvedValue(undefined),
      renameFile: vi.fn().mockResolvedValue(undefined),
      deleteFile: vi.fn().mockResolvedValue(undefined)
    };
    const docsClient = {
      getDocument: vi.fn().mockResolvedValueOnce(firstDoc).mockResolvedValueOnce(tablesDoc),
      batchUpdate: vi.fn().mockResolvedValue(undefined)
    };
    return {
      driveClient,
      docsClient,
      deps: {
        getDriveClient: () => driveClient,
        getDocsClient: () => docsClient,
        getQuotationsFolderId: async () => 'folder-out'
      }
    };
  }

  function seedGenerated(repo: FakeQuoteRepository) {
    repo.quotes.push(makeQuote());
    repo.contacts.push({ name: 'Rajesh Kumar', designation: 'Purchase Manager' });
    repo.blocks.push({
      quoteNo: 'QTN-2026-0001',
      rev: 0,
      block: 1,
      title: 'Main panel BOQ',
      headers: ['Item', 'Qty'],
      rows: [['Contactor', '4']]
    });
  }

  it('copies the template, merges fields, inserts BOQ tables, exports a PDF and records both links', async () => {
    const { driveClient, docsClient, deps } = makeClients();
    const { repo, service } = makeService(deps);
    seedGenerated(repo);

    const result = await service.generateQuoteDoc(sales, 'QTN-2026-0001', 0);

    expect(driveClient.copyFile).toHaveBeenCalledWith('tpl-standard', 'QTN-2026-0001-R0 - Alpha Panels', 'folder-out');

    // Merge pass carries every legacy placeholder, contact formatted as legacy did.
    const mergeRequests = docsClient.batchUpdate.mock.calls[0][1];
    const replaced = Object.fromEntries(
      mergeRequests.map((r: { replaceAllText: { containsText: { text: string }; replaceText: string } }) => [
        r.replaceAllText.containsText.text,
        r.replaceAllText.replaceText
      ])
    );
    expect(replaced['{{QUOTE_NO}}']).toBe('QTN-2026-0001');
    expect(replaced['{{REV}}']).toBe('R0');
    expect(replaced['{{CUSTOMER_NAME}}']).toBe('Alpha Panels');
    expect(replaced['{{CUSTOMER_ADDRESS}}']).toBe('Industrial Area, Ludhiana');
    expect(replaced['{{CONTACT_NAME}}']).toBe('Rajesh Kumar (Purchase Manager)');
    expect(replaced['{{TOTAL}}']).toBe('1,180.00');
    expect(replaced['{{CURRENCY}}']).toBe('INR');
    // The structural marker is never merge-replaced - it is deleted in the
    // structure pass so a table can take its place.
    expect(replaced['{{BOQ_TABLE}}']).toBeUndefined();

    // Structure pass deletes the marker first.
    const structureRequests = docsClient.batchUpdate.mock.calls[1][1];
    expect(structureRequests[0]).toEqual({ deleteContentRange: { range: { startIndex: 40, endIndex: 53 } } });

    // Cell-fill pass writes highest index first so earlier indices stay valid.
    const fillRequests = docsClient.batchUpdate.mock.calls[2][1];
    const fillIndices = fillRequests.map((r: { insertText: { location: { index: number } } }) => r.insertText.location.index);
    expect(fillIndices).toEqual([...fillIndices].sort((a, b) => b - a));
    // BOQ headers/rows land in the first table, totals in the second.
    const fillByIndex = Object.fromEntries(
      fillRequests.map((r: { insertText: { text: string; location: { index: number } } }) => [
        r.insertText.location.index,
        r.insertText.text
      ])
    );
    expect(fillByIndex[43]).toBe('Item');
    expect(fillByIndex[52]).toBe('4');
    expect(fillByIndex[62]).toBe('Subtotal');
    expect(fillByIndex[77]).toBe('INR 1,180.00');

    expect(driveClient.exportPdf).toHaveBeenCalledWith('copy-1');
    expect(driveClient.uploadFile).toHaveBeenCalledWith(
      expect.objectContaining({ fileName: 'QTN-2026-0001-R0 - Alpha Panels.pdf', mimeType: 'application/pdf' }),
      'folder-out'
    );
    expect(driveClient.shareDomainReadable).toHaveBeenCalledWith('copy-1');

    expect(result.doc.url).toBe('https://drive.google.com/file/d/copy-1/view');
    expect(result.pdf.url).toBe('https://drive.google.com/file/d/pdf-1/view');

    const stored = await repo.getQuote('QTN-2026-0001', 0);
    expect(stored?.doc).toBe('https://drive.google.com/file/d/copy-1/view');
    expect(stored?.pdf).toBe('https://drive.google.com/file/d/pdf-1/view');
    expect(repo.logs.some((l) => l.action === 'QUOTE_PDF')).toBe(true);
  });

  it('refuses to generate for an external quotation', async () => {
    const { repo, service } = makeService(makeClients().deps);
    repo.quotes.push(makeQuote({ source: 'External', fileName: 'vendor-quote.pdf' }));

    await expect(service.generateQuoteDoc(sales, 'QTN-2026-0001', 0)).rejects.toThrow('uploaded as an external file');
  });

  it('refuses to generate when the quote has no template selected', async () => {
    const { repo, service } = makeService(makeClients().deps);
    repo.quotes.push(makeQuote({ templateId: '' }));

    await expect(service.generateQuoteDoc(sales, 'QTN-2026-0001', 0)).rejects.toThrow('no template selected');
  });

  it('fails clearly when the template has no BOQ placeholder', async () => {
    const noMarkerDoc = {
      body: {
        content: [
          { startIndex: 1, paragraph: { elements: [{ startIndex: 1, textRun: { content: 'No placeholder here\n' } }] } }
        ]
      }
    };
    const { repo, service } = makeService(makeClients(noMarkerDoc).deps);
    seedGenerated(repo);

    await expect(service.generateQuoteDoc(sales, 'QTN-2026-0001', 0)).rejects.toThrow('{{BOQ_TABLE}}');
  });

  it('refuses to generate when Drive is not configured', async () => {
    const { repo, service } = makeService({ getDriveClient: undefined, getQuotationsFolderId: undefined });
    seedGenerated(repo);

    await expect(service.generateQuoteDoc(sales, 'QTN-2026-0001', 0)).rejects.toThrow('not configured');
  });
});
