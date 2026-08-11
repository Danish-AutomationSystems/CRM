import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { CrmContext } from '../auth/context';
import { createQuoteService, type QuoteRepository } from '../quotes/service';
import { createDriveService } from './service';
import type { DriveClient } from './client';

function fakeDriveClient(overrides: Partial<DriveClient> = {}): DriveClient {
  return {
    uploadFile: vi.fn(),
    listDocsInFolder: vi.fn(),
    copyFile: vi.fn(),
    exportPdf: vi.fn(),
    shareDomainReadable: vi.fn(),
    ...overrides
  };
}

const sales: CrmContext = {
  email: 'sales@automationsystems.org',
  name: 'Sales User',
  role: 'L2',
  allowedTags: ['Punjab'],
  active: true
};

type CustomerRow = NonNullable<Awaited<ReturnType<QuoteRepository['getCustomer']>>>;
type QuoteRow = NonNullable<Awaited<ReturnType<QuoteRepository['getQuote']>>>;
type HandlerRow = Awaited<ReturnType<QuoteRepository['listHandlers']>>[number];

class FakeQuoteRepository implements QuoteRepository {
  customers: CustomerRow[] = [];
  cases: Awaited<ReturnType<QuoteRepository['getCase']>>[] = [];
  handlers: HandlerRow[] = [];
  users: Awaited<ReturnType<QuoteRepository['listUsers']>> = [];
  quotes: QuoteRow[] = [];
  blocks: Awaited<ReturnType<QuoteRepository['listBoqBlocks']>> = [];
  logs: Array<{ action: string; entity: string; customerId: string; details: string; who: string }> = [];

  async withTransaction<T>(fn: (repo?: QuoteRepository) => Promise<T>): Promise<T> { return fn(this); }
  async lockQuoteFamily(): Promise<void> {}
  async nextQuoteNo(): Promise<string> { return 'QTN-2026-0001'; }
  async nextCaseId(): Promise<string> { return 'CASE-2026-0001'; }
  async listTemplates() { return []; }
  async listContacts() { return []; }
  async getCustomer(id: string) { return this.customers.find((c) => c.id === id) ?? null; }
  async listUsers() { return this.users; }
  async listHandlers() { return this.handlers; }
  async getCase(id: string) { return this.cases.find((c) => c?.id === id) ?? null; }
  async createCase(): Promise<void> {}
  async updateCase(): Promise<void> {}
  async getQuote(quoteNo: string, rev: number) {
    return this.quotes.find((q) => q.quoteNo === quoteNo && q.rev === rev) ?? null;
  }
  async listQuotesByQuoteNo(quoteNo: string) { return this.quotes.filter((q) => q.quoteNo === quoteNo); }
  async createQuote(row: QuoteRow): Promise<void> { this.quotes.push(row); }
  async updateQuote(quoteNo: string, rev: number, fields: Partial<QuoteRow>): Promise<void> {
    const existing = await this.getQuote(quoteNo, rev);
    if (!existing) throw new Error(`Quotation ${quoteNo} R${rev} was not found.`);
    Object.assign(existing, fields);
  }
  async createBoqBlocks(): Promise<void> {}
  async listBoqBlocks() { return this.blocks; }
  async logActivity(entry: { action: string; entity: string; customerId: string; details: string; who: string }): Promise<void> {
    this.logs.push(entry);
  }
}

function baseQuote(): QuoteRow {
  return {
    quoteNo: 'QTN-2026-0001',
    rev: 0,
    caseId: '',
    customerId: 'CUST-1',
    title: 'Panel upgrade quote',
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
  };
}

describe('createDriveService', () => {
  let repo: FakeQuoteRepository;

  beforeEach(() => {
    repo = new FakeQuoteRepository();
    repo.customers.push({
      id: 'CUST-1',
      name: 'Acme Controls',
      tags: ['Punjab'],
      type: '',
      priority: '',
      area: '',
      address: '',
      gstin: '',
      website: '',
      notes: '',
      sei: [],
      remarks: '',
      status: 'Active',
      createdBy: 'sales@automationsystems.org',
      createdAt: '2026-07-01T00:00:00.000Z',
      updatedAt: '2026-07-01T00:00:00.000Z'
    });
    repo.handlers.push({ customerId: 'CUST-1', email: 'sales@automationsystems.org', assignedBy: 'sales@automationsystems.org', assignedAt: '2026-07-01T00:00:00.000Z' });
    repo.quotes.push(baseQuote());
  });

  it('uploads a Generated quote using its already-complete artifact fileName verbatim (not double-wrapped)', async () => {
    const quoteService = createQuoteService(repo);
    const uploadFile = vi.fn().mockResolvedValue({ id: 'file-123', webViewLink: 'https://drive.google.com/file/d/file-123/view' });
    const driveService = createDriveService({
      quoteService,
      quoteRepository: repo,
      getDriveClient: () => fakeDriveClient({ uploadFile }),
      getFolderId: async () => 'folder-abc'
    });

    const artifact = await quoteService.getDownloadArtifact(sales, 'QTN-2026-0001', 0);
    const result = await driveService.saveQuotationToDrive(sales, 'QTN-2026-0001', 0);

    // Generated quotes already bake quoteNo/rev/customerName into
    // artifact.fileName (via safeQuoteFileName) - it must be used as-is,
    // not wrapped again with the "<quoteNo> R<rev> - <customerName> - " prefix.
    expect(uploadFile).toHaveBeenCalledWith(
      expect.objectContaining({ fileName: artifact.fileName }),
      'folder-abc'
    );
    expect(uploadFile.mock.calls[0][0].fileName).not.toContain('QTN-2026-0001 R0 - Acme Controls -');
    expect(result.quote.driveViewLink).toBe('https://drive.google.com/file/d/file-123/view');

    const stored = await repo.getQuote('QTN-2026-0001', 0);
    expect(stored?.driveFileId).toBe('file-123');
    expect(stored?.driveSavedBy).toBe('sales@automationsystems.org');
    expect(stored?.driveSavedAt).not.toBe('');
  });

  it('uploads an External quote with the wrapped "<quoteNo> R<rev> - <customerName> - <fileName>" name', async () => {
    repo.quotes.push({
      ...baseQuote(),
      rev: 1,
      source: 'External',
      fileName: 'customer-quote.pdf',
      uploadMimeType: 'application/pdf',
      uploadDataB64: Buffer.from('pdf-bytes').toString('base64')
    });

    const quoteService = createQuoteService(repo);
    const uploadFile = vi.fn().mockResolvedValue({ id: 'file-456', webViewLink: 'https://drive.google.com/file/d/file-456/view' });
    const driveService = createDriveService({
      quoteService,
      quoteRepository: repo,
      getDriveClient: () => fakeDriveClient({ uploadFile }),
      getFolderId: async () => 'folder-abc'
    });

    await driveService.saveQuotationToDrive(sales, 'QTN-2026-0001', 1);

    expect(uploadFile).toHaveBeenCalledWith(
      expect.objectContaining({ fileName: 'QTN-2026-0001 R1 - Acme Controls - customer-quote.pdf' }),
      'folder-abc'
    );
  });

  it('rejects a customer the user cannot access, same as getDownloadArtifact would', async () => {
    const outsider: CrmContext = { ...sales, allowedTags: ['NCR'] };
    const quoteService = createQuoteService(repo);
    const driveService = createDriveService({
      quoteService,
      quoteRepository: repo,
      getDriveClient: () => fakeDriveClient(),
      getFolderId: async () => 'folder-abc'
    });

    await expect(driveService.saveQuotationToDrive(outsider, 'QTN-2026-0001', 0)).rejects.toThrow();
  });

  it('propagates a Drive upload failure without corrupting the quote row', async () => {
    const quoteService = createQuoteService(repo);
    const driveService = createDriveService({
      quoteService,
      quoteRepository: repo,
      getDriveClient: () => fakeDriveClient({ uploadFile: vi.fn().mockRejectedValue(new Error('Drive quota exceeded.')) }),
      getFolderId: async () => 'folder-abc'
    });

    await expect(driveService.saveQuotationToDrive(sales, 'QTN-2026-0001', 0)).rejects.toThrow('Drive quota exceeded.');
    const stored = await repo.getQuote('QTN-2026-0001', 0);
    expect(stored?.driveFileId).toBe('');
  });
});
