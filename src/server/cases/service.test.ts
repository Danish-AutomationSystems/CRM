import { beforeEach, describe, expect, it } from 'vitest';

import type { CrmContext } from '../auth/context';
import type { DriveClient, DriveFileMeta, ResumableSessionInput } from '../drive/client';
import { MAX_ATTACHMENTS_PER_RESPONSE, MAX_ATTACHMENT_BYTES } from './attachments';
import { createCaseService, type CaseActivityLogEntry, type CaseAttachmentRow, type CaseRepository } from './service';

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
  /** Ids handed out by logActivity, aligned by index with `logs`. */
  logIds: string[] = [];
  attachments: CaseAttachmentRow[] = [];
  lockedNames: string[] = [];
  nextCustomer = 2;
  nextCase = 1;
  nextLogId = 1;
  nextAttachmentId = 1;
  getCustomerCalls = 0;
  getCustomersByIdsCalls: string[][] = [];
  updateCaseCalls = 0;

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
    this.getCustomerCalls++;
    return this.customers.find((customer) => customer.id === id) ?? null;
  }

  async getCustomersByIds(ids: string[]): Promise<NonNullable<CustomerRow>[]> {
    this.getCustomersByIdsCalls.push([...ids]);
    if (ids.length === 0) return [];
    return this.customers.filter((customer) => ids.includes(customer.id));
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
    this.updateCaseCalls++;
    const row = await this.getCase(id);
    if (!row) throw new Error('missing test case');
    Object.assign(row, fields);
  }

  async listQuotesByCase(caseId: string): Promise<QuoteRow[]> {
    return this.quotes.filter((quote) => quote.caseId === caseId);
  }

  async listActivityByEntity(
    entity: string
  ): Promise<Array<{ id: string; when: string; who: string; action: string; details: string; note: string }>> {
    // Mirrors the real repository's `order by created_at desc limit 40`:
    // newest-first, capped at 40 rows. Each row carries the id logActivity
    // handed out for it, exactly as the real `select id, ...` now does - a
    // fake that returned a constant id would make attachments look grouped
    // while silently collapsing every entry onto one.
    return this.logs
      .map((log, index) => ({ log, id: this.logIds[index] }))
      .filter(({ log }) => log.entity === entity)
      .map(({ log, id }, index) => ({
        id,
        when: `2026-07-29T00:00:${index}.000Z`,
        who: log.who,
        action: log.action,
        details: log.details,
        note: log.note ?? ''
      }))
      .slice()
      .reverse()
      .slice(0, 40);
  }

  async latestQuotedValueByCase(): Promise<Record<string, number>> {
    return this.quotes
      .filter((quote) => quote.status !== 'Superseded')
      .reduce<Record<string, number>>((map, quote) => {
        map[quote.caseId] = quote.total;
        return map;
      }, {});
  }

  async logActivity(entry: CaseActivityLogEntry): Promise<string> {
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
    priority: '',
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

const ATTACHMENTS_FOLDER = 'FOLDER-attachments';

/**
 * Every Drive method the attachment paths may legitimately use is recorded;
 * every other method throws, so a test fails loudly if the service reaches
 * for something it should not. No test ever contacts the real Google API.
 */
class FakeDriveClient implements DriveClient {
  sessions: ResumableSessionInput[] = [];
  files = new Map<string, DriveFileMeta>();
  folderNames: string[] = [];
  renames: Array<{ fileId: string; name: string }> = [];
  deleted: string[] = [];
  metaLookups: string[] = [];
  listCalls = 0;
  listedCaseIds: string[] = [];
  failDelete = false;

  put(meta: Partial<DriveFileMeta> & { id: string }): DriveFileMeta {
    const full: DriveFileMeta = {
      name: `${meta.id}-name`,
      size: 0,
      mimeType: 'application/pdf',
      webViewLink: `https://drive.example/${meta.id}`,
      parents: [ATTACHMENTS_FOLDER],
      ...meta
    };
    this.files.set(full.id, full);
    this.folderNames.push(full.name);
    return full;
  }

  async createResumableSession(input: ResumableSessionInput): Promise<{ sessionUrl: string }> {
    this.sessions.push(input);
    return { sessionUrl: `https://upload.example/session/${this.sessions.length}` };
  }

  async getFileMeta(fileId: string): Promise<DriveFileMeta | null> {
    this.metaLookups.push(fileId);
    return this.files.get(fileId) ?? null;
  }

  async listFileNamesInFolder(_folderId: string, caseId: string): Promise<string[]> {
    this.listCalls += 1;
    this.listedCaseIds.push(caseId);
    // Mirrors the real client, which now scopes the query to one case.
    return this.folderNames.filter((name) => name.startsWith(`${caseId} - `));
  }

  async renameFile(fileId: string, name: string): Promise<void> {
    this.renames.push({ fileId, name });
    const existing = this.files.get(fileId);
    if (existing) this.files.set(fileId, { ...existing, name });
  }

  async deleteFile(fileId: string): Promise<void> {
    this.deleted.push(fileId);
    if (this.failDelete) throw new Error('Drive delete blew up');
  }

  async uploadFile(): Promise<{ id: string; webViewLink: string }> {
    throw new Error('uploadFile must never be used by the attachment path');
  }

  async listDocsInFolder(): Promise<Array<{ id: string; name: string }>> {
    throw new Error('listDocsInFolder must never be used by the attachment path');
  }

  async copyFile(): Promise<{ id: string; webViewLink: string }> {
    throw new Error('copyFile must never be used by the attachment path');
  }

  async exportPdf(): Promise<Buffer> {
    throw new Error('exportPdf must never be used by the attachment path');
  }

  async shareDomainReadable(): Promise<void> {
    throw new Error('shareDomainReadable must never be used by the attachment path');
  }
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

function makeAttachmentService() {
  const repo = new FakeCaseRepository();
  repo.customers = [customer()];
  repo.users = [
    user({ email: sales.email, name: sales.name }),
    user({ email: 'other@automationsystems.org', name: 'Other Sales', allowedTags: ['NCR'] }),
    user({ email: 'worker@automationsystems.org', name: 'Ticket Worker', role: 'L1', allowedTags: [] })
  ];
  repo.handlers = [{ customerId: 'CUST-0001', email: sales.email, assignedBy: sales.email, assignedAt: 'now' }];
  repo.cases = [caseRow({ assignee: 'worker@automationsystems.org' })];
  const drive = new FakeDriveClient();
  const service = createCaseService(repo, {
    getDriveClient: () => drive,
    getAttachmentsFolderId: async () => ATTACHMENTS_FOLDER
  });
  return { repo, drive, service };
}

/** The UTC date buildDriveName stamps into the name, computed the same way. */
function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

function driveNameFor(fileName: string, uploader = 'Sales User'): string {
  return `CASE-2026-0001 - ${todayUtc()} - ${uploader} - ${fileName}`;
}

describe('beginAttachmentUpload access and validation', () => {
  it('refuses a user who cannot see the case and creates no upload session', async () => {
    const { drive, service } = makeAttachmentService();
    const stranger: CrmContext = {
      ...sales,
      email: 'other@automationsystems.org',
      name: 'Other Sales',
      allowedTags: ['NCR']
    };

    await expect(
      service.beginAttachmentUpload(stranger, 'CASE-2026-0001', [
        { fileName: 'report.pdf', mimeType: 'application/pdf', sizeBytes: 1024 }
      ])
    ).rejects.toThrow();

    expect(drive.sessions).toEqual([]);
  });

  it('refuses a closed case and creates no upload session', async () => {
    const { repo, drive, service } = makeAttachmentService();
    repo.cases = [caseRow({ assignee: 'worker@automationsystems.org', outcome: 'Won' })];

    await expect(
      service.beginAttachmentUpload(sales, 'CASE-2026-0001', [
        { fileName: 'report.pdf', mimeType: 'application/pdf', sizeBytes: 1024 }
      ])
    ).rejects.toThrow(/closed/);

    expect(drive.sessions).toEqual([]);
  });

  it('rejects a file over the size limit before creating any session', async () => {
    const { drive, service } = makeAttachmentService();

    await expect(
      service.beginAttachmentUpload(sales, 'CASE-2026-0001', [
        { fileName: 'small.pdf', mimeType: 'application/pdf', sizeBytes: 10 },
        { fileName: 'huge.iso', mimeType: 'application/octet-stream', sizeBytes: MAX_ATTACHMENT_BYTES + 1 }
      ])
    ).rejects.toThrow(/exceeds the 100 MB limit/);

    expect(drive.sessions).toEqual([]);
  });

  it('rejects more than the per-response maximum before creating any session', async () => {
    const { drive, service } = makeAttachmentService();
    const files = Array.from({ length: MAX_ATTACHMENTS_PER_RESPONSE + 1 }, (_, index) => ({
      fileName: `file-${index}.pdf`,
      mimeType: 'application/pdf',
      sizeBytes: 100
    }));

    await expect(service.beginAttachmentUpload(sales, 'CASE-2026-0001', files)).rejects.toThrow(
      /at most \d+ files per response/
    );

    expect(drive.sessions).toEqual([]);
  });

  it('names each session server-side and returns only the file name and session url', async () => {
    const { drive, service } = makeAttachmentService();

    const result = await service.beginAttachmentUpload(sales, 'CASE-2026-0001', [
      { fileName: '../../etc/passwd', mimeType: 'text/plain', sizeBytes: 12 },
      { fileName: 'quote.pdf', mimeType: 'application/pdf', sizeBytes: 2048 }
    ]);

    expect(result).toEqual([
      { fileName: '../../etc/passwd', sessionUrl: 'https://upload.example/session/1' },
      { fileName: 'quote.pdf', sessionUrl: 'https://upload.example/session/2' }
    ]);
    // Nothing beyond those two keys - no access token, no folder id.
    expect(result.every((entry) => Object.keys(entry).sort().join(',') === 'fileName,sessionUrl')).toBe(true);
    expect(JSON.stringify(result)).not.toContain(ATTACHMENTS_FOLDER);

    expect(drive.sessions).toEqual([
      {
        fileName: driveNameFor('etcpasswd'),
        mimeType: 'text/plain',
        sizeBytes: 12,
        folderId: ATTACHMENTS_FOLDER
      },
      {
        fileName: driveNameFor('quote.pdf'),
        mimeType: 'application/pdf',
        sizeBytes: 2048,
        folderId: ATTACHMENTS_FOLDER
      }
    ]);
  });

  it('refuses when Drive is not configured', async () => {
    const { repo } = makeAttachmentService();
    const service = createCaseService(repo);

    await expect(
      service.beginAttachmentUpload(sales, 'CASE-2026-0001', [
        { fileName: 'report.pdf', mimeType: 'application/pdf', sizeBytes: 10 }
      ])
    ).rejects.toThrow(/not configured/);
  });
});

describe('assignTicket rejects every way a client can lie about an upload', () => {
  const declared = [{ fileId: 'FILE-1', fileName: 'report.pdf', mimeType: 'application/pdf', sizeBytes: 2048 }];

  function expectNothingCommitted(repo: FakeCaseRepository) {
    expect(repo.logs.filter((entry) => entry.action === 'CASE_ASSIGN')).toHaveLength(0);
    expect(repo.attachments).toEqual([]);
    expect(repo.cases[0].assignee).toBe('worker@automationsystems.org');
  }

  it('rejects a file id Drive does not know, writes nothing, and deletes nothing', async () => {
    const { repo, drive, service } = makeAttachmentService();
    // FILE-1 was never created (or the app cannot see it) - getFileMeta is null.

    await expect(service.assignTicket(sales, 'CASE-2026-0001', 'other', 'handover', declared)).rejects.toThrow(
      /invalid/i
    );

    expectNothingCommitted(repo);
    // Unresolvable means unprovable: we cannot show this file is ours, so we
    // must not delete it. There is nothing to clean up anyway.
    expect(drive.deleted).toEqual([]);
    expect(drive.renames).toEqual([]);
  });

  it('rejects a file whose real size differs from the declared size', async () => {
    const { repo, drive, service } = makeAttachmentService();
    drive.put({ id: 'FILE-1', name: driveNameFor('report.pdf'), size: 999_999, parents: [ATTACHMENTS_FOLDER] });

    await expect(service.assignTicket(sales, 'CASE-2026-0001', 'other', 'handover', declared)).rejects.toThrow(
      /invalid/i
    );

    expectNothingCommitted(repo);
    expect(drive.deleted).toEqual(['FILE-1']);
    expect(drive.renames).toEqual([]);
  });

  it('rejects a file that does not live in our attachments folder, however real it is', async () => {
    const { repo, drive, service } = makeAttachmentService();
    // A quotation belonging to another customer: it exists, the size matches,
    // the app's credentials can read it - only its parent gives it away.
    drive.put({
      id: 'FILE-1',
      name: driveNameFor('report.pdf'),
      size: 2048,
      parents: ['FOLDER-quotations']
    });

    await expect(service.assignTicket(sales, 'CASE-2026-0001', 'other', 'handover', declared)).rejects.toThrow(
      /invalid/i
    );

    expectNothingCommitted(repo);
    // The whole point: this file is NOT ours. Deleting it here would hand any
    // authenticated user a way to destroy quotations, templates, or any other
    // file the app's credentials can reach.
    expect(drive.deleted).toEqual([]);
    expect(drive.files.has('FILE-1')).toBe(true);
    expect(drive.renames).toEqual([]);
  });

  it('rejects an attachment that belongs to a different case, even inside our own folder', async () => {
    const { repo, drive, service } = makeAttachmentService();
    drive.put({
      id: 'FILE-1',
      name: `CASE-2026-0999 - ${todayUtc()} - Other Sales - report.pdf`,
      size: 2048,
      parents: [ATTACHMENTS_FOLDER]
    });

    await expect(service.assignTicket(sales, 'CASE-2026-0001', 'other', 'handover', declared)).rejects.toThrow(
      /invalid/i
    );

    expectNothingCommitted(repo);
    // Another case's live attachment: deleting it would leave that case with a
    // row pointing at nothing.
    expect(drive.deleted).toEqual([]);
    expect(drive.files.has('FILE-1')).toBe(true);
  });

  it('cleans up only the files it proved are ours when a batch mixes ours with a foreign one', async () => {
    const { repo, drive, service } = makeAttachmentService();
    // A genuine upload for this case, sitting unreferenced in our folder...
    drive.put({ id: 'FILE-OURS', name: driveNameFor('a.pdf'), size: 10 });
    // ...smuggled alongside somebody else's quotation.
    drive.put({ id: 'FILE-THEIRS', name: 'Quotation for another customer.pdf', size: 20, parents: ['FOLDER-quotations'] });

    await expect(
      service.assignTicket(sales, 'CASE-2026-0001', 'other', 'handover', [
        { fileId: 'FILE-OURS', fileName: 'a.pdf', mimeType: 'application/pdf', sizeBytes: 10 },
        { fileId: 'FILE-THEIRS', fileName: 'b.pdf', mimeType: 'application/pdf', sizeBytes: 20 }
      ])
    ).rejects.toThrow(/invalid/i);

    expectNothingCommitted(repo);
    expect(drive.deleted).toEqual(['FILE-OURS']);
    expect(drive.files.has('FILE-THEIRS')).toBe(true);
  });

  it('refuses a file already attached to this case, and does not delete the live file', async () => {
    const { repo, drive, service } = makeAttachmentService();
    drive.put({ id: 'FILE-1', name: driveNameFor('a.pdf'), size: 10 });
    const upload = [{ fileId: 'FILE-1', fileName: 'a.pdf', mimeType: 'application/pdf', sizeBytes: 10 }];
    await service.assignTicket(sales, 'CASE-2026-0001', 'other', 'first handover', upload);
    expect(repo.attachments).toHaveLength(1);

    await expect(
      service.assignTicket(sales, 'CASE-2026-0001', 'worker', 'second handover', upload)
    ).rejects.toThrow(/invalid/i);

    expect(repo.attachments).toHaveLength(1);
    // The file backs a committed row: cleanup must not have touched it.
    expect(drive.deleted).toEqual([]);
  });

  it('does not delete a genuine file that got committed between the guard and the cleanup', async () => {
    const { repo, drive, service } = makeAttachmentService();
    drive.put({ id: 'FILE-OURS', name: driveNameFor('a.pdf'), size: 10 });
    drive.put({ id: 'FILE-THEIRS', name: 'Somebody elses quotation.pdf', size: 20, parents: ['FOLDER-quotations'] });

    // The already-attached guard reads first and sees nothing. A concurrent
    // reassignment then commits a row for FILE-OURS, so by the time this
    // request gives up on the foreign file, its own id is referenced.
    const real = repo.listAttachmentsByCase.bind(repo);
    let reads = 0;
    repo.listAttachmentsByCase = async (caseId: string) => {
      reads += 1;
      if (reads > 1) {
        return [
          {
            id: 'ATT-9',
            activityId: 'LOG-9',
            caseId,
            driveFileId: 'FILE-OURS',
            driveViewLink: 'https://drive.example/FILE-OURS',
            fileName: driveNameFor('a.pdf'),
            mimeType: 'application/pdf',
            sizeBytes: 10,
            uploadedBy: sales.email,
            createdAt: '2026-08-14T00:00:00.000Z'
          }
        ];
      }
      return real(caseId);
    };

    await expect(
      service.assignTicket(sales, 'CASE-2026-0001', 'other', 'handover', [
        { fileId: 'FILE-OURS', fileName: 'a.pdf', mimeType: 'application/pdf', sizeBytes: 10 },
        { fileId: 'FILE-THEIRS', fileName: 'b.pdf', mimeType: 'application/pdf', sizeBytes: 20 }
      ])
    ).rejects.toThrow(/invalid/i);

    expectNothingCommitted(repo);
    // FILE-OURS now backs the winner's row; FILE-THEIRS was never ours.
    expect(drive.deleted).toEqual([]);
    expect(drive.files.has('FILE-OURS')).toBe(true);
    expect(drive.files.has('FILE-THEIRS')).toBe(true);
  });

  it('deletes nothing and commits nothing when Drive fails outright during verification', async () => {
    const { repo, drive, service } = makeAttachmentService();
    drive.put({ id: 'FILE-1', name: driveNameFor('a.pdf'), size: 10 });
    drive.getFileMeta = async () => {
      // Not a 404/403 - getFileMeta rethrows those as a real error rather than
      // mapping them to null, and nothing about the file has been established.
      throw new Error('Drive could not return file metadata: backend error');
    };

    await expect(
      service.assignTicket(sales, 'CASE-2026-0001', 'other', 'handover', [
        { fileId: 'FILE-1', fileName: 'a.pdf', mimeType: 'application/pdf', sizeBytes: 10 }
      ])
    ).rejects.toThrow(/could not return file metadata/);

    expectNothingCommitted(repo);
    expect(drive.deleted).toEqual([]);
    expect(drive.files.has('FILE-1')).toBe(true);
  });

  it('rejects the same file id reported twice', async () => {
    const { repo, drive, service } = makeAttachmentService();
    drive.put({ id: 'FILE-1', name: driveNameFor('report.pdf'), size: 2048 });

    await expect(
      service.assignTicket(sales, 'CASE-2026-0001', 'other', 'handover', [...declared, ...declared])
    ).rejects.toThrow(/invalid/i);

    expectNothingCommitted(repo);
    expect(drive.metaLookups).toEqual([]);
  });
});

describe('assignTicket commits verified attachments', () => {
  it('writes one activity row and two attachment rows bound to that activity id', async () => {
    const { repo, drive, service } = makeAttachmentService();
    drive.put({
      id: 'FILE-1',
      name: driveNameFor('report.pdf'),
      size: 2048,
      mimeType: 'application/pdf',
      webViewLink: 'https://drive.example/FILE-1'
    });
    drive.put({
      id: 'FILE-2',
      name: driveNameFor('photo.jpg'),
      size: 4096,
      mimeType: 'image/jpeg',
      webViewLink: 'https://drive.example/FILE-2'
    });

    const result = await service.assignTicket(sales, 'CASE-2026-0001', 'other', 'Two documents attached.', [
      { fileId: 'FILE-1', fileName: 'report.pdf', mimeType: 'application/pdf', sizeBytes: 2048 },
      { fileId: 'FILE-2', fileName: 'photo.jpg', mimeType: 'image/jpeg', sizeBytes: 4096 }
    ]);

    expect(result).toEqual({ ok: true, assignee: 'Other Sales', assigneeEmail: 'other@automationsystems.org' });
    expect(repo.cases[0].assignee).toBe('other@automationsystems.org');

    const assignLogs = repo.logs.filter((entry) => entry.action === 'CASE_ASSIGN');
    expect(assignLogs).toHaveLength(1);
    expect(assignLogs[0].details).toBe('Working on -> Other Sales');
    expect(assignLogs[0].note).toBe('Two documents attached.');

    const activityId = repo.logIds[repo.logs.indexOf(assignLogs[0])];
    expect(repo.attachments).toHaveLength(2);
    expect(repo.attachments.map((row) => row.activityId)).toEqual([activityId, activityId]);
    expect(repo.attachments[0]).toMatchObject({
      caseId: 'CASE-2026-0001',
      driveFileId: 'FILE-1',
      driveViewLink: 'https://drive.example/FILE-1',
      fileName: driveNameFor('report.pdf'),
      mimeType: 'application/pdf',
      // The size Drive reports, never the size the client declared.
      sizeBytes: 2048,
      uploadedBy: sales.email
    });
    expect(repo.attachments[1]).toMatchObject({ driveFileId: 'FILE-2', sizeBytes: 4096, mimeType: 'image/jpeg' });
  });

  it('stores a server-built name, ignoring the name the client claims, and disambiguates collisions', async () => {
    const { repo, drive, service } = makeAttachmentService();
    // Someone else already parked a file under the very name this one will get.
    drive.folderNames.push(driveNameFor('etcpasswd'));
    drive.put({ id: 'FILE-1', name: driveNameFor('etcpasswd'), size: 12, mimeType: 'text/plain' });

    await service.assignTicket(sales, 'CASE-2026-0001', 'other', '', [
      { fileId: 'FILE-1', fileName: '../../etc/passwd', mimeType: 'text/plain', sizeBytes: 12 }
    ]);

    const stored = repo.attachments[0].fileName;
    expect(stored).toBe(`${driveNameFor('etcpasswd')} (2)`);
    expect(stored).not.toContain('..');
    expect(stored).not.toContain('/');
    // Uploader name comes from the users table, not from anything the client sent.
    expect(stored).toContain(' - Sales User - ');
    expect(drive.renames).toEqual([{ fileId: 'FILE-1', name: stored }]);
  });

  it('deletes the uploaded files and surfaces the original error when the transaction fails', async () => {
    const { repo, drive, service } = makeAttachmentService();
    drive.put({ id: 'FILE-1', name: driveNameFor('a.pdf'), size: 10 });
    drive.put({ id: 'FILE-2', name: driveNameFor('b.pdf'), size: 20 });
    repo.createAttachments = async () => {
      throw new Error('insert exploded');
    };
    // Even a failing cleanup must not replace the error the caller needs.
    drive.failDelete = true;

    await expect(
      service.assignTicket(sales, 'CASE-2026-0001', 'other', '', [
        { fileId: 'FILE-1', fileName: 'a.pdf', mimeType: 'application/pdf', sizeBytes: 10 },
        { fileId: 'FILE-2', fileName: 'b.pdf', mimeType: 'application/pdf', sizeBytes: 20 }
      ])
    ).rejects.toThrow('insert exploded');

    expect(drive.deleted).toEqual(['FILE-1', 'FILE-2']);
  });

  it('losing a race to the unique index does not delete the file the winner committed', async () => {
    const { repo, drive, service } = makeAttachmentService();
    drive.put({ id: 'FILE-1', name: driveNameFor('a.pdf'), size: 10 });
    repo.createAttachments = async () => {
      // A concurrent reassignment reporting the same file id got there first;
      // its row is committed and case_attachments_drive_file_id_key rejects us.
      repo.attachments.push({
        id: 'ATT-9',
        activityId: 'LOG-9',
        caseId: 'CASE-2026-0001',
        driveFileId: 'FILE-1',
        driveViewLink: 'https://drive.example/FILE-1',
        fileName: driveNameFor('a.pdf'),
        mimeType: 'application/pdf',
        sizeBytes: 10,
        uploadedBy: sales.email,
        createdAt: '2026-08-14T00:00:00.000Z'
      });
      throw new Error('duplicate key value violates unique constraint "case_attachments_drive_file_id_key"');
    };

    await expect(
      service.assignTicket(sales, 'CASE-2026-0001', 'other', '', [
        { fileId: 'FILE-1', fileName: 'a.pdf', mimeType: 'application/pdf', sizeBytes: 10 }
      ])
    ).rejects.toThrow(/duplicate key/);

    // The file now backs the winner's row. Deleting it would leave that row
    // dangling - the same defect as deleting somebody else's file.
    expect(drive.deleted).toEqual([]);
  });

  it('getCase hangs each activity entry its own attachments', async () => {
    const { repo, drive, service } = makeAttachmentService();
    drive.put({ id: 'FILE-1', name: driveNameFor('a.pdf'), size: 10 });
    drive.put({ id: 'FILE-2', name: driveNameFor('b.pdf'), size: 20 });

    await service.assignTicket(sales, 'CASE-2026-0001', 'other', 'first handover', [
      { fileId: 'FILE-1', fileName: 'a.pdf', mimeType: 'application/pdf', sizeBytes: 10 }
    ]);
    await service.assignTicket(sales, 'CASE-2026-0001', 'worker', 'second handover', [
      { fileId: 'FILE-2', fileName: 'b.pdf', mimeType: 'application/pdf', sizeBytes: 20 }
    ]);

    const full = await service.getCase(sales, 'CASE-2026-0001');
    const entries = full.history.filter((entry) => entry.action === 'CASE_ASSIGN');

    expect(entries).toHaveLength(2);
    // getCase returns the (newest-40) window oldest-first, and each entry
    // carries only its own file - not the other handover's.
    expect(entries[0].attachments.map((file) => file.fileName)).toEqual([driveNameFor('a.pdf')]);
    expect(entries[1].attachments.map((file) => file.fileName)).toEqual([driveNameFor('b.pdf')]);
    expect(entries[1].attachments[0]).toMatchObject({
      viewLink: 'https://drive.example/FILE-2',
      sizeBytes: 20,
      uploadedBy: 'Sales User'
    });
    expect(Object.keys(full.attachments)).toHaveLength(2);
  });
});

describe('assignTicket without attachments is unchanged', () => {
  it('produces the same details, the same return value, and touches Drive not at all', async () => {
    const { repo, drive, service } = makeAttachmentService();

    const withUndefined = await service.assignTicket(sales, 'CASE-2026-0001', 'other', 'A note.');
    const withEmptyList = await service.assignTicket(sales, 'CASE-2026-0001', 'worker', 'A note.', []);

    expect(withUndefined).toEqual({ ok: true, assignee: 'Other Sales', assigneeEmail: 'other@automationsystems.org' });
    expect(withEmptyList).toEqual({
      ok: true,
      assignee: 'Ticket Worker',
      assigneeEmail: 'worker@automationsystems.org'
    });

    const assignLogs = repo.logs.filter((entry) => entry.action === 'CASE_ASSIGN');
    expect(assignLogs.map((entry) => entry.details)).toEqual([
      'Working on -> Other Sales',
      'Working on -> Ticket Worker'
    ]);
    expect(assignLogs.every((entry) => entry.note === 'A note.')).toBe(true);
    expect(repo.attachments).toEqual([]);

    expect(drive.sessions).toEqual([]);
    expect(drive.metaLookups).toEqual([]);
    expect(drive.renames).toEqual([]);
    expect(drive.deleted).toEqual([]);
    expect(drive.listCalls).toBe(0);
  });

  it('still reassigns with no attachments when Drive is not configured at all', async () => {
    const { repo } = makeAttachmentService();
    const service = createCaseService(repo);

    const result = await service.assignTicket(sales, 'CASE-2026-0001', 'other', 'A note.');

    expect(result).toEqual({ ok: true, assignee: 'Other Sales', assigneeEmail: 'other@automationsystems.org' });
  });
});

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

  it('stores a handover note against the reassignment', async () => {
    const { repo, service } = makeService();
    repo.cases = [caseRow({ assignee: 'worker@automationsystems.org' })];

    await service.assignTicket(sales, 'CASE-2026-0001', 'other', 'Quoted, waiting on their PO.');

    const logged = repo.logs.find((entry) => entry.action === 'CASE_ASSIGN')!;
    expect(logged.note).toBe('Quoted, waiting on their PO.');
    expect(logged.details).toBe('Working on -> Other Sales');
  });

  it('reassigning without a note behaves exactly as before', async () => {
    const { repo, service } = makeService();
    repo.cases = [caseRow({ assignee: 'worker@automationsystems.org' })];

    const result = await service.assignTicket(sales, 'CASE-2026-0001', 'other');

    expect(result).toEqual({ ok: true, assignee: 'Other Sales', assigneeEmail: 'other@automationsystems.org' });
    const logged = repo.logs.find((entry) => entry.action === 'CASE_ASSIGN')!;
    expect(logged.note ?? '').toBe('');
    expect(logged.details).toBe('Working on -> Other Sales');
  });

  it('treats a whitespace-only handover note as no note', async () => {
    const { repo, service } = makeService();
    repo.cases = [caseRow({ assignee: 'worker@automationsystems.org' })];

    await service.assignTicket(sales, 'CASE-2026-0001', 'other', '   \n\t  ');

    const logged = repo.logs.find((entry) => entry.action === 'CASE_ASSIGN')!;
    expect(logged.note ?? '').toBe('');
  });

  it('rejects a handover note over 2000 characters without writing anything', async () => {
    const { repo, service } = makeService();
    repo.cases = [caseRow({ assignee: 'worker@automationsystems.org' })];

    await expect(
      service.assignTicket(sales, 'CASE-2026-0001', 'other', 'x'.repeat(2001))
    ).rejects.toThrow(/2000 characters/);

    expect(repo.logs.filter((entry) => entry.action === 'CASE_ASSIGN')).toHaveLength(0);
    expect(repo.cases[0].assignee).toBe('worker@automationsystems.org');
  });

  it('still refuses to reassign a closed case, note or not', async () => {
    const { repo, service } = makeService();
    repo.cases = [caseRow({ assignee: 'worker@automationsystems.org', outcome: 'Won' })];

    await expect(
      service.assignTicket(sales, 'CASE-2026-0001', 'other', 'a handover note')
    ).rejects.toThrow(/closed/);

    expect(repo.logs.filter((entry) => entry.action === 'CASE_ASSIGN')).toHaveLength(0);
  });

  it('getCase returns the latest handover note even when it falls outside the 40-entry history window', async () => {
    const { repo, service } = makeService();
    repo.cases = [caseRow({ assignee: 'worker@automationsystems.org' })];

    await service.assignTicket(sales, 'CASE-2026-0001', 'other', 'The handover note.');
    for (let i = 0; i < 45; i += 1) {
      await repo.logActivity({
        action: 'CASE_NOTE',
        entity: 'CASE-2026-0001',
        customerId: 'CUST-0001',
        details: `filler ${i}`,
        who: sales.email
      });
    }

    const result = await service.getCase(sales, 'CASE-2026-0001');

    expect(result.latestHandoverNote).toBe('The handover note.');
    expect(result.history.some((entry) => entry.details === 'Working on -> Other Sales')).toBe(false);
  });

  it('getCase returns the handover activity id, so the client need not match on note text', async () => {
    const { drive, service } = makeAttachmentService();
    const meta = drive.put({ id: 'DRIVE-1', name: 'CASE-2026-0001 - report.pdf', size: 11 });

    await service.assignTicket(sales, 'CASE-2026-0001', 'other', 'The handover note.', [
      { fileId: meta.id, fileName: 'report.pdf', sizeBytes: 11 }
    ]);

    const result = await service.getCase(sales, 'CASE-2026-0001');
    const activityId = result.latestHandoverActivityId;

    expect(activityId).toBeTruthy();
    // The attachments map is keyed by activity id and is not capped, unlike
    // history - which is why the client keys off this rather than the note text.
    expect(result.attachments[activityId]).toHaveLength(1);
    expect(result.attachments[activityId][0].fileName).toContain('report.pdf');
    // The history mapper carries the id too, so both render sites agree.
    const entry = result.history.find((item) => item.id === activityId);
    expect(entry?.note).toBe('The handover note.');
  });

  it('getCase reports an empty handover activity id when the case has no handover note', async () => {
    const { repo, service } = makeService();
    repo.cases = [caseRow({ assignee: 'worker@automationsystems.org' })];

    const result = await service.getCase(sales, 'CASE-2026-0001');

    expect(result.latestHandoverNote).toBe('');
    expect(result.latestHandoverActivityId).toBe('');
  });

  it('stores the priority a case is created with', async () => {
    const { repo, service } = makeService();

    const created = await service.createCase(sales, 'CUST-0001', {
      title: 'Urgent panel fault',
      priority: 'High'
    });

    const stored = await repo.getCase(created.id);
    expect(stored?.priority).toBe('High');
  });

  it('stores no priority when the case is created without one', async () => {
    const { repo, service } = makeService();

    const created = await service.createCase(sales, 'CUST-0001', { title: 'Routine enquiry' });

    const stored = await repo.getCase(created.id);
    expect(stored?.priority).toBe('');
  });

  it('ignores a priority outside the allowed list rather than failing the create', async () => {
    const { repo, service } = makeService();

    const created = await service.createCase(sales, 'CUST-0001', {
      title: 'Panel fault',
      priority: 'Urgent'
    });

    const stored = await repo.getCase(created.id);
    expect(stored?.priority).toBe('');
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
  it('fetches every case customer in one batched query rather than one per case', async () => {
    const { repo, service } = makeService();
    repo.customers.push(customer({ id: 'CUST-0002', name: 'Second Customer' }));
    repo.cases = [
      caseRow({ id: 'CASE-2026-0001', customerId: 'CUST-0001' }),
      caseRow({ id: 'CASE-2026-0002', customerId: 'CUST-0001' }),
      caseRow({ id: 'CASE-2026-0003', customerId: 'CUST-0002' })
    ];

    await service.listCases(sales);

    expect(repo.getCustomersByIdsCalls).toHaveLength(1);
    expect([...repo.getCustomersByIdsCalls[0]].sort()).toEqual(['CUST-0001', 'CUST-0002']);
    expect(repo.getCustomerCalls).toBe(0);
  });

  it('still lists cases whose customer no longer exists exactly as before', async () => {
    const { repo, service } = makeService();
    repo.cases = [
      caseRow({ id: 'CASE-2026-0001', customerId: 'CUST-0001' }),
      caseRow({ id: 'CASE-2026-0002', customerId: 'CUST-GONE' })
    ];

    const listed = await service.listCases(sales);

    expect(listed.map((row) => row.id)).toEqual(['CASE-2026-0001']);
  });

  it('issues no customer query at all when there are no cases', async () => {
    const { repo, service } = makeService();
    repo.cases = [];

    const listed = await service.listCases(sales);

    expect(listed).toEqual([]);
    expect(repo.getCustomersByIdsCalls.flat()).toEqual([]);
    expect(repo.getCustomerCalls).toBe(0);
  });

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

  it('quick log stores the case priority without confusing it with the new customer priority', async () => {
    const { repo, service } = makeService();

    const logged = await service.quickLog(sales, {
      newCustomer: { name: 'Fresh Co', tag: 'Punjab', priority: 'Low' },
      title: 'Site visit request',
      priority: 'High'
    });

    const storedCase = await repo.getCase(logged.caseId);
    const storedCustomer = await repo.getCustomer(logged.customerId);
    expect(storedCase?.priority).toBe('High');
    expect(storedCustomer?.priority).toBe('Low');
  });

  it('quick log stores no case priority when none is given', async () => {
    const { repo, service } = makeService();

    const logged = await service.quickLog(sales, {
      customerId: 'CUST-0001',
      title: 'Called about spares'
    });

    expect((await repo.getCase(logged.caseId))?.priority).toBe('');
  });
});

describe('setCasePriority', () => {
  // Same user/handler shape as makeService()'s default fixtures, reused so we know it is
  // genuinely denied: 'refuses a user who cannot see the case and creates no upload session'
  // (beginAttachmentUpload access and validation, near line 352) proves this exact user -
  // not a handler, not the assignee, not an owner of CASE-2026-0001 - fails loadVisibleCase.
  const outsider: CrmContext = {
    ...sales,
    email: 'other@automationsystems.org',
    name: 'Other Sales',
    allowedTags: ['NCR']
  };

  it('changes the priority and logs the change in history', async () => {
    const { repo, service } = makeService();
    repo.cases = [caseRow({ id: 'CASE-2026-0001', priority: 'Low' })];

    await service.setCasePriority(sales, 'CASE-2026-0001', 'High');

    expect((await repo.getCase('CASE-2026-0001'))?.priority).toBe('High');
    const logged = repo.logs.filter((entry) => entry.action === 'CASE_PRIORITY');
    expect(logged).toHaveLength(1);
    expect(logged[0].details).toBe('Low -> High');
    expect(logged[0].entity).toBe('CASE-2026-0001');
  });

  it('clears the priority when given an empty string', async () => {
    const { repo, service } = makeService();
    repo.cases = [caseRow({ id: 'CASE-2026-0001', priority: 'High' })];

    await service.setCasePriority(sales, 'CASE-2026-0001', '');

    expect((await repo.getCase('CASE-2026-0001'))?.priority).toBe('');
    expect(repo.logs.filter((e) => e.action === 'CASE_PRIORITY')[0].details).toBe('High -> -');
  });

  it('writes nothing and logs nothing when the priority is unchanged', async () => {
    const { repo, service } = makeService();
    repo.cases = [caseRow({ id: 'CASE-2026-0001', priority: 'Medium' })];

    await service.setCasePriority(sales, 'CASE-2026-0001', 'Medium');

    // A same-value call must not reach the repository at all: repository.ts rewrites every
    // column on updateCase, so a no-op write would still bump updatedAt on a case nobody
    // actually changed.
    expect(repo.updateCaseCalls).toBe(0);
    expect(repo.logs.filter((e) => e.action === 'CASE_PRIORITY')).toEqual([]);
  });

  it('rejects a priority outside the allowed list', async () => {
    const { repo, service } = makeService();
    repo.cases = [caseRow({ id: 'CASE-2026-0001', priority: 'Low' })];

    await expect(service.setCasePriority(sales, 'CASE-2026-0001', 'Urgent')).rejects.toThrow(/not a valid priority/i);
    expect((await repo.getCase('CASE-2026-0001'))?.priority).toBe('Low');
  });

  it('denies an outsider before validating the priority, so a junk value cannot leak that the case exists', async () => {
    const { repo, service } = makeService();
    repo.cases = [caseRow({ id: 'CASE-2026-0001', priority: 'Low' })];

    // 'Urgent' is not a valid priority - if validation ran before the access check, an
    // outsider would learn the case exists from a "not a valid priority" error instead of
    // a generic access error. Both conditions (denied user + invalid value) must be present
    // together for this to be exercised, which is exactly what the two existing tests
    // (each varying only one of the two) do not do.
    await expect(service.setCasePriority(outsider, 'CASE-2026-0001', 'Urgent')).rejects.toThrow(
      /do not have access/i
    );
    expect((await repo.getCase('CASE-2026-0001'))?.priority).toBe('Low');
  });

  it('allows a priority change on a closed case', async () => {
    const { repo, service } = makeService();
    repo.cases = [
      caseRow({
        id: 'CASE-2026-0001',
        priority: 'Low',
        outcome: 'Won',
        orderValue: 5000,
        wonCategories: ['Drives'],
        closedOn: '2026-08-01T00:00:00.000Z',
        assignee: ''
      })
    ];

    await service.setCasePriority(sales, 'CASE-2026-0001', 'High');

    expect((await repo.getCase('CASE-2026-0001'))?.priority).toBe('High');
  });

  it('denies a user who cannot see the case, without revealing that it exists', async () => {
    const { repo, service } = makeService();
    repo.cases = [caseRow({ id: 'CASE-2026-0001', priority: 'Low' })];

    await expect(service.setCasePriority(outsider, 'CASE-2026-0001', 'High')).rejects.toThrow(/do not have access/i);
    expect((await repo.getCase('CASE-2026-0001'))?.priority).toBe('Low');
  });
});
