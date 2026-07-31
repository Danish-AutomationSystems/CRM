# Google Drive Quotation Save Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a CRM user click "Save to Drive" on a quotation and get a copy pushed to a fixed Google Drive folder (`testing@automationsystems.org`), with a "View in Drive" link shown back in the CRM once saved.

**Architecture:** A new `src/server/drive/` module (OAuth2 client + upload service) reuses the existing `quoteService.getDownloadArtifact()` to get the same bytes already served for download, uploads them via the Drive API, and records the result on the `quotations` row. A new write RPC (`api_saveQuotationToDrive`) exposes it; a manual button in the legacy quote-viewer UI triggers it. One-time admin-gated setup routes (`/api/admin/drive-setup/*`) capture the OAuth refresh token and create the target folder.

**Tech Stack:** `googleapis` (Node client for Drive API v3 + OAuth2), existing Postgres/`postgres` tagged-template pattern, existing RPC registry, existing legacy-artifact dual-edit approach (source `Index.html` + hand-patched `legacy-full.generated.ts`, since the generator is currently broken — see `CONTEXT.md`).

## Global Constraints

- Reuse `quoteService.getDownloadArtifact(user, quoteNo, rev)` for artifact bytes — do not duplicate access-control or rendering logic (spec: "no new access-control logic is introduced").
- Drive OAuth scope is `drive.file` only (spec: narrowest viable scope).
- Folder name is exactly `AS CRM Quotations Testing` (spec, stakeholder-specified).
- File naming follows the legacy convention: `<quoteNo> R<rev> - <customerName> - <fileName>`.
- The `/api/admin/drive-setup/*` routes must be gated to L6 admins (`ensureAdmin`) and must refuse to run if `GOOGLE_DRIVE_REFRESH_TOKEN` is already set (spec: self-disabling).
- `docs/source-appscript/legacy-full.generated.ts` regeneration is blocked by a pre-existing, unrelated generator bug (documented in `CONTEXT.md`) — UI changes go into `docs/source-appscript/Index.html` (source of truth) **and** are hand-patched identically into the committed `src/app/crm/legacy-full.generated.ts`. Do not run `node scripts/port-legacy-index.mjs`.
- Never print `GOOGLE_DRIVE_CLIENT_SECRET` or `GOOGLE_DRIVE_REFRESH_TOKEN` in logs, responses other than the one-time callback page, or commits.
- Run `npm run typecheck && npm run test` after every task before committing.

---

### Task 1: Add `googleapis` dependency and the `quotations` Drive columns

**Files:**
- Modify: `package.json`
- Create: `supabase/migrations/0004_quotation_drive_link.sql`

**Interfaces:**
- Produces: `quotations.drive_file_id` (text), `drive_view_link` (text), `drive_saved_at` (timestamptz, nullable), `drive_saved_by` (text, nullable) — consumed by Task 2's repository changes.

- [ ] **Step 1: Install the dependency**

Run: `npm install googleapis`

Expected: `package.json` gains a `googleapis` entry under `dependencies`; `package-lock.json` updates.

- [ ] **Step 2: Write the migration**

```sql
alter table public.quotations
  add column if not exists drive_file_id text not null default '',
  add column if not exists drive_view_link text not null default '',
  add column if not exists drive_saved_at timestamptz,
  add column if not exists drive_saved_by text references public.users(email);
```

- [ ] **Step 3: Apply the migration**

Run: `node scripts/apply-migrations.mjs`
Expected: output lists `0004_quotation_drive_link.sql` as applied (or already-applied on a second run).

- [ ] **Step 4: Commit**

```bash
git add package.json package-lock.json supabase/migrations/0004_quotation_drive_link.sql
git commit -m "feat(drive): add googleapis dependency and quotations Drive columns"
```

---

### Task 2: Extend `QuoteRow` and the repository with Drive fields

**Files:**
- Modify: `src/server/quotes/service.ts:60-83` (the `QuoteRow` type)
- Modify: `src/server/quotes/repository.ts` (`QuoteDbRow` type, `toQuote`, `getQuote`, `listQuotesByQuoteNo`, `createQuote`, `updateQuote`)
- Test: `src/server/quotes/repository.ts` has no dedicated test file today (it's exercised via `service.test.ts` against a fake); add a focused test in `src/server/quotes/service.test.ts` instead, since that's where `FakeQuoteRepository` and the DI pattern already live.

**Interfaces:**
- Consumes: nothing new.
- Produces: `QuoteRow.driveFileId: string`, `QuoteRow.driveViewLink: string`, `QuoteRow.driveSavedAt: string`, `QuoteRow.driveSavedBy: string` — consumed by Task 4's `saveQuotationToDrive` and Task 5's `api_getQuotation` response.

- [ ] **Step 1: Write the failing test**

In `src/server/quotes/service.test.ts`, add near the other `updateQuote`-adjacent tests:

```ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/server/quotes/service.test.ts -t "persists Drive save fields"`
Expected: FAIL — TypeScript error or the pushed object rejected, since `QuoteRow` doesn't have `driveFileId`/etc. yet.

- [ ] **Step 3: Add the fields to `QuoteRow`**

In `src/server/quotes/service.ts`, extend the `QuoteRow` type (it currently ends `doc: string; pdf: string; createdBy: string; ...`):

```ts
export type QuoteRow = {
  quoteNo: string;
  rev: number;
  caseId: string;
  customerId: string;
  title: string;
  source: 'Generated' | 'External';
  fileName: string;
  uploadMimeType: string;
  uploadDataB64: string;
  templateId: string;
  templateName: string;
  status: 'Draft' | 'Sent' | 'Superseded';
  subtotal: number | '';
  taxPct: number | '';
  taxAmount: number | '';
  total: number | '';
  currency: string;
  validUntil: string;
  notes: string;
  doc: string;
  pdf: string;
  driveFileId: string;
  driveViewLink: string;
  driveSavedAt: string;
  driveSavedBy: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
};
```

- [ ] **Step 4: Update the repository's DB row type and mapper**

In `src/server/quotes/repository.ts`, extend `QuoteDbRow` (after `pdf_link: string | null;`):

```ts
  pdf_link: string | null;
  drive_file_id: string | null;
  drive_view_link: string | null;
  drive_saved_at: string | Date | null;
  drive_saved_by: string | null;
  created_by: string | null;
```

Update `toQuote` (after `pdf: row.pdf_link ?? '',`):

```ts
    pdf: row.pdf_link ?? '',
    driveFileId: row.drive_file_id ?? '',
    driveViewLink: row.drive_view_link ?? '',
    driveSavedAt: dateString(row.drive_saved_at),
    driveSavedBy: normalizeEmail(row.drive_saved_by ?? ''),
```

- [ ] **Step 5: Update the SELECT queries**

In `getQuote` and `listQuotesByQuoteNo`, extend the `select` column list (both currently end `..., doc_link, pdf_link, created_by, created_at, updated_at`):

```sql
select quote_no, rev, case_id, customer_id, title, source, file_name,
       upload_mime_type, coalesce(encode(upload_data, 'base64'), '') as upload_data_b64,
       template_id,
       template_name, status, subtotal, tax_pct, tax_amount, total, currency,
       valid_until, notes, doc_link, pdf_link, drive_file_id, drive_view_link,
       drive_saved_at, drive_saved_by, created_by, created_at, updated_at
```

Apply this same column list to both queries (`getQuote` and `listQuotesByQuoteNo`).

- [ ] **Step 6: Update `updateQuote`'s SET clause**

In `updateQuote`, after `pdf_link = ${row.pdf},`:

```sql
        doc_link = ${row.doc},
        pdf_link = ${row.pdf},
        drive_file_id = ${row.driveFileId},
        drive_view_link = ${row.driveViewLink},
        drive_saved_at = ${row.driveSavedAt || null},
        drive_saved_by = ${row.driveSavedBy ? normalizeEmail(row.driveSavedBy) : null},
        updated_at = ${row.updatedAt}
```

(`createQuote`'s INSERT does not need these columns — they default to `''`/`null` per the migration, and Drive-saving only ever happens after a quote already exists.)

- [ ] **Step 7: Run test to verify it passes**

Run: `npx vitest run src/server/quotes/service.test.ts`
Expected: PASS, all existing tests in this file still pass too (fields are additive).

- [ ] **Step 8: Run full typecheck**

Run: `npm run typecheck`
Expected: no errors (every other `QuoteRow` literal in tests/fixtures needs the four new fields — fix any that fail with the same empty-string/`.driveFileId: ''` pattern used in Step 1).

- [ ] **Step 9: Commit**

```bash
git add src/server/quotes/service.ts src/server/quotes/repository.ts src/server/quotes/service.test.ts
git commit -m "feat(drive): add Drive save fields to QuoteRow and repository"
```

---

### Task 3: Drive client module (OAuth2 + upload)

**Files:**
- Create: `src/server/drive/client.ts`
- Test: `src/server/drive/client.test.ts`

**Interfaces:**
- Produces: `export type DriveFileUpload = { fileName: string; mimeType: string; body: Buffer }`, `export type DriveClient = { uploadFile(input: DriveFileUpload, folderId: string): Promise<{ id: string; webViewLink: string }> }`, `export function createDriveClient(): DriveClient` — consumed by Task 4.

- [ ] **Step 1: Write the failing test**

```ts
// src/server/drive/client.test.ts
import { beforeEach, describe, expect, it, vi } from 'vitest';

const filesCreate = vi.fn();
const permissionsCreate = vi.fn();

vi.mock('googleapis', () => ({
  google: {
    auth: {
      OAuth2: vi.fn().mockImplementation(() => ({ setCredentials: vi.fn() }))
    },
    drive: vi.fn().mockImplementation(() => ({
      files: { create: filesCreate },
      permissions: { create: permissionsCreate }
    }))
  }
}));

describe('createDriveClient', () => {
  beforeEach(() => {
    filesCreate.mockReset();
    permissionsCreate.mockReset();
    process.env.GOOGLE_DRIVE_CLIENT_ID = 'test-client-id';
    process.env.GOOGLE_DRIVE_CLIENT_SECRET = 'test-client-secret';
    process.env.GOOGLE_DRIVE_REFRESH_TOKEN = 'test-refresh-token';
  });

  it('uploads a file and sets domain-shared read access', async () => {
    filesCreate.mockResolvedValue({ data: { id: 'file-123', webViewLink: 'https://drive.google.com/file/d/file-123/view' } });
    permissionsCreate.mockResolvedValue({ data: {} });

    const { createDriveClient } = await import('./client');
    const client = createDriveClient();
    const result = await client.uploadFile(
      { fileName: 'QTN-2026-0001 R0 - Acme Controls - quote.html', mimeType: 'text/html', body: Buffer.from('<html></html>') },
      'folder-abc'
    );

    expect(result).toEqual({ id: 'file-123', webViewLink: 'https://drive.google.com/file/d/file-123/view' });
    expect(filesCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        requestBody: { name: 'QTN-2026-0001 R0 - Acme Controls - quote.html', parents: ['folder-abc'] },
        fields: 'id, webViewLink'
      })
    );
    expect(permissionsCreate).toHaveBeenCalledWith(
      expect.objectContaining({ fileId: 'file-123', requestBody: expect.objectContaining({ type: 'domain', role: 'reader' }) })
    );
  });

  it('tolerates a permission-sharing failure and still returns the uploaded file', async () => {
    filesCreate.mockResolvedValue({ data: { id: 'file-456', webViewLink: 'https://drive.google.com/file/d/file-456/view' } });
    permissionsCreate.mockRejectedValue(new Error('Domain policy blocks link sharing.'));

    const { createDriveClient } = await import('./client');
    const client = createDriveClient();
    const result = await client.uploadFile(
      { fileName: 'file.html', mimeType: 'text/html', body: Buffer.from('x') },
      'folder-abc'
    );

    expect(result.id).toBe('file-456');
  });

  it('throws a clear error when required env vars are missing', async () => {
    delete process.env.GOOGLE_DRIVE_CLIENT_ID;
    const { createDriveClient } = await import('./client');
    expect(() => createDriveClient()).toThrow('GOOGLE_DRIVE_CLIENT_ID is not configured.');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/server/drive/client.test.ts`
Expected: FAIL with "Cannot find module './client'" (file doesn't exist yet).

- [ ] **Step 3: Write the implementation**

```ts
// src/server/drive/client.ts
import { Readable } from 'node:stream';

import { google } from 'googleapis';

export type DriveFileUpload = {
  fileName: string;
  mimeType: string;
  body: Buffer;
};

export type DriveClient = {
  uploadFile(input: DriveFileUpload, folderId: string): Promise<{ id: string; webViewLink: string }>;
};

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not configured.`);
  return value;
}

function createOAuth2Client() {
  const clientId = requireEnv('GOOGLE_DRIVE_CLIENT_ID');
  const clientSecret = requireEnv('GOOGLE_DRIVE_CLIENT_SECRET');
  const refreshToken = requireEnv('GOOGLE_DRIVE_REFRESH_TOKEN');
  const oauth2Client = new google.auth.OAuth2(clientId, clientSecret);
  oauth2Client.setCredentials({ refresh_token: refreshToken });
  return oauth2Client;
}

export function createDriveClient(): DriveClient {
  return {
    async uploadFile(input: DriveFileUpload, folderId: string) {
      const drive = google.drive({ version: 'v3', auth: createOAuth2Client() });

      const response = await drive.files.create({
        requestBody: { name: input.fileName, parents: [folderId] },
        media: { mimeType: input.mimeType, body: Readable.from(input.body) },
        fields: 'id, webViewLink'
      });

      const fileId = response.data.id;
      if (!fileId) throw new Error('Drive did not return a file id.');

      try {
        await drive.permissions.create({
          fileId,
          requestBody: {
            type: 'domain',
            domain: process.env.CRM_ALLOWED_DOMAIN || 'automationsystems.org',
            role: 'reader'
          }
        });
      } catch {
        // Some Workspace domains restrict link sharing - the file still
        // exists and the upload still succeeds either way (mirrors the
        // legacy Apps Script behavior at Code.gs:1722).
      }

      return { id: fileId, webViewLink: response.data.webViewLink ?? '' };
    }
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/server/drive/client.test.ts`
Expected: PASS, all 3 tests.

- [ ] **Step 5: Commit**

```bash
git add src/server/drive/client.ts src/server/drive/client.test.ts
git commit -m "feat(drive): add Drive API client with domain-shared upload"
```

---

### Task 4: Drive service (orchestration) + folder-ID lookup

**Files:**
- Create: `src/server/drive/folder.ts`
- Create: `src/server/drive/service.ts`
- Test: `src/server/drive/service.test.ts`

**Interfaces:**
- Consumes: `QuoteRepository`, `QuoteService['getDownloadArtifact']` (from `src/server/quotes/service.ts`), `DriveClient` (Task 3).
- Produces: `export function createDriveService(deps): { saveQuotationToDrive(user: CrmContext, quoteNo: string, rev: number): Promise<ReturnType<QuoteService['getQuotation']>> }` — consumed by Task 5's RPC registration.

- [ ] **Step 1: Write `folder.ts` (no test - trivial passthrough over an already-tested query pattern)**

```ts
// src/server/drive/folder.ts
import { sql } from '../db/client';

const FOLDER_ID_SETTING_KEY = 'GOOGLE_DRIVE_QUOTATIONS_FOLDER_ID';

export async function getDriveFolderId(): Promise<string> {
  const rows = (await sql`
    select value
    from public.settings
    where key = ${FOLDER_ID_SETTING_KEY}
    limit 1
  `) as Array<{ value: string | null }>;

  const folderId = rows[0]?.value?.trim();
  if (!folderId) {
    throw new Error('Google Drive folder is not configured. Run the one-time Drive setup first.');
  }
  return folderId;
}
```

- [ ] **Step 2: Write the failing test for the service**

```ts
// src/server/drive/service.test.ts
import { beforeEach, describe, expect, it } from 'vitest';

import type { CrmContext } from '../auth/context';
import { createQuoteService, type QuoteRepository } from '../quotes/service';
import { createDriveService } from './service';

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
      sei: '',
      remarks: '',
      status: 'Active',
      createdBy: 'sales@automationsystems.org',
      createdAt: '2026-07-01T00:00:00.000Z',
      updatedAt: '2026-07-01T00:00:00.000Z'
    });
    repo.handlers.push({ customerId: 'CUST-1', email: 'sales@automationsystems.org', assignedBy: 'sales@automationsystems.org', assignedAt: '2026-07-01T00:00:00.000Z' });
    repo.quotes.push(baseQuote());
  });

  it('uploads the quote artifact to Drive and records the result', async () => {
    const quoteService = createQuoteService(repo);
    const uploadFile = vi.fn().mockResolvedValue({ id: 'file-123', webViewLink: 'https://drive.google.com/file/d/file-123/view' });
    const driveService = createDriveService({
      quoteService,
      quoteRepository: repo,
      driveClient: { uploadFile },
      getFolderId: async () => 'folder-abc'
    });

    const result = await driveService.saveQuotationToDrive(sales, 'QTN-2026-0001', 0);

    expect(uploadFile).toHaveBeenCalledWith(
      expect.objectContaining({ fileName: expect.stringContaining('QTN-2026-0001 R0 - Acme Controls') }),
      'folder-abc'
    );
    expect(result.quote.driveViewLink).toBe('https://drive.google.com/file/d/file-123/view');

    const stored = await repo.getQuote('QTN-2026-0001', 0);
    expect(stored?.driveFileId).toBe('file-123');
    expect(stored?.driveSavedBy).toBe('sales@automationsystems.org');
    expect(stored?.driveSavedAt).not.toBe('');
  });

  it('rejects a customer the user cannot access, same as getDownloadArtifact would', async () => {
    const outsider: CrmContext = { ...sales, allowedTags: ['NCR'] };
    const quoteService = createQuoteService(repo);
    const driveService = createDriveService({
      quoteService,
      quoteRepository: repo,
      driveClient: { uploadFile: vi.fn() },
      getFolderId: async () => 'folder-abc'
    });

    await expect(driveService.saveQuotationToDrive(outsider, 'QTN-2026-0001', 0)).rejects.toThrow();
  });

  it('propagates a Drive upload failure without corrupting the quote row', async () => {
    const quoteService = createQuoteService(repo);
    const driveService = createDriveService({
      quoteService,
      quoteRepository: repo,
      driveClient: { uploadFile: vi.fn().mockRejectedValue(new Error('Drive quota exceeded.')) },
      getFolderId: async () => 'folder-abc'
    });

    await expect(driveService.saveQuotationToDrive(sales, 'QTN-2026-0001', 0)).rejects.toThrow('Drive quota exceeded.');
    const stored = await repo.getQuote('QTN-2026-0001', 0);
    expect(stored?.driveFileId).toBe('');
  });
});
```

Add `import { vi } from 'vitest';` to the existing import line at the top of the file.

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run src/server/drive/service.test.ts`
Expected: FAIL with "Cannot find module './service'".

- [ ] **Step 4: Write the implementation**

```ts
// src/server/drive/service.ts
import type { CrmContext } from '../auth/context';
import type { QuoteRepository, QuoteService } from '../quotes/service';
import type { DriveClient } from './client';

type DriveServiceDeps = {
  quoteService: QuoteService;
  quoteRepository: QuoteRepository;
  driveClient: DriveClient;
  getFolderId: () => Promise<string>;
};

function toBuffer(body: BodyInit): Buffer {
  if (typeof body === 'string') return Buffer.from(body, 'utf8');
  if (Buffer.isBuffer(body)) return body;
  return Buffer.from(body as ArrayBuffer);
}

function driveFileName(quoteNo: string, rev: number, customerName: string, baseFileName: string): string {
  return `${quoteNo} R${rev} - ${customerName} - ${baseFileName}`;
}

export function createDriveService(deps: DriveServiceDeps) {
  return {
    async saveQuotationToDrive(user: CrmContext, quoteNo: string, rev: number) {
      const artifact = await deps.quoteService.getDownloadArtifact(user, quoteNo, rev);
      const quote = await deps.quoteRepository.getQuote(quoteNo, rev);
      if (!quote) throw new Error(`Quotation ${quoteNo} R${rev} was not found.`);
      const customer = await deps.quoteRepository.getCustomer(quote.customerId);

      const folderId = await deps.getFolderId();
      const uploaded = await deps.driveClient.uploadFile(
        {
          fileName: driveFileName(quoteNo, rev, customer?.name ?? '', artifact.fileName),
          mimeType: artifact.mimeType,
          body: toBuffer(artifact.body)
        },
        folderId
      );

      await deps.quoteRepository.updateQuote(quoteNo, rev, {
        driveFileId: uploaded.id,
        driveViewLink: uploaded.webViewLink,
        driveSavedAt: new Date().toISOString(),
        driveSavedBy: user.email
      });

      return deps.quoteService.getQuotation(user, quoteNo, rev);
    }
  };
}

export type DriveService = ReturnType<typeof createDriveService>;
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run src/server/drive/service.test.ts`
Expected: PASS, all 3 tests.

- [ ] **Step 6: Run full unit suite and typecheck**

Run: `npm run typecheck && npm run test`
Expected: all pass, no regressions.

- [ ] **Step 7: Commit**

```bash
git add src/server/drive/folder.ts src/server/drive/service.ts src/server/drive/service.test.ts
git commit -m "feat(drive): add saveQuotationToDrive orchestration service"
```

---

### Task 5: Register the RPC and expose `driveViewLink` to the client

**Files:**
- Modify: `src/server/quotes/rpc.ts`
- Modify: `src/server/quotes/service.ts` (`getQuotation`'s return shape, around line 592-621)
- Modify: `src/server/rpc/api-parity.test.ts`

**Interfaces:**
- Consumes: `createDriveService` (Task 4), `createDriveClient` (Task 3), `getDriveFolderId` (Task 4), `quoteRepository` and `service` (already in `rpc.ts`).
- Produces: RPC `api_saveQuotationToDrive(quoteNo, rev)`, and `api_getQuotation`'s response gains `quote.driveViewLink: string` — consumed by Task 7's UI button.

- [ ] **Step 1: Add `driveViewLink` to `getQuotation`'s response**

In `src/server/quotes/service.ts`, inside `getQuotation`'s returned object, after `pdf: quote.pdf,`:

```ts
          doc: quote.doc,
          pdf: quote.pdf,
          driveViewLink: quote.driveViewLink,
```

- [ ] **Step 2: Register the RPC**

In `src/server/quotes/rpc.ts`, add the imports and registration:

```ts
import { registerRpc } from '../rpc/registry';
import { createDriveClient } from '../drive/client';
import { getDriveFolderId } from '../drive/folder';
import { createDriveService } from '../drive/service';
import { quoteRepository } from './repository';
import { createQuoteService } from './service';

const service = createQuoteService(quoteRepository);
const driveService = createDriveService({
  quoteService: service,
  quoteRepository,
  driveClient: createDriveClient(),
  getFolderId: getDriveFolderId
});

// ... existing registerRpc calls unchanged ...

registerRpc(
  'api_saveQuotationToDrive',
  ({ args, context }) => driveService.saveQuotationToDrive(context, String(args[0] ?? ''), Number(args[1] ?? 0)),
  { read: false }
);
```

Note: `createDriveClient()` is called once at module load time, same lifecycle as `createQuoteService(quoteRepository)` on the line above it — it reads env vars lazily only when `uploadFile` is actually invoked (Task 3's `createOAuth2Client()` runs inside `uploadFile`, not at `createDriveClient()` construction time), so this does not throw at import time even before Drive credentials exist.

- [ ] **Step 3: Update the API-parity test's allowlist**

In `src/server/rpc/api-parity.test.ts`, update the first test:

```ts
  it('keeps every legacy UI-called api_* function registered in the Vercel RPC registry', () => {
    const codeGs = readFileSync(join(root, 'docs/source-appscript/Code.gs'), 'utf8');
    const indexHtml = readFileSync(join(root, 'docs/source-appscript/Index.html'), 'utf8');

    const sourceApis = appScriptApis(codeGs);
    const uiApis = uiCalledApis(indexHtml);
    const registeredApis = listRegisteredRpcs();

    // Capabilities added after the migration that never existed in the
    // legacy Apps Script server - not expected to appear in Code.gs.
    const intentionallyNew = ['api_saveQuotationToDrive'];
    const legacyUiApis = uiApis.filter((api) => !intentionallyNew.includes(api));

    expect(uiApis.length).toBeGreaterThan(0);
    expect(sourceApis).toEqual(expect.arrayContaining(legacyUiApis));
    expect(uiApis.filter((api) => !hasRpc(api))).toEqual([]);
    expect(registeredApis).toEqual(expect.arrayContaining(uiApis));
  });
```

- [ ] **Step 4: Run the parity test**

Run: `npx vitest run src/server/rpc/api-parity.test.ts`
Expected: FAIL at this point — `uiApis` doesn't include `api_saveQuotationToDrive` yet (no UI call exists until Task 7), so this test should currently still PASS as-is with zero new UI calls. Confirm it passes now; it becomes the safety net once Task 7 adds the UI call.

- [ ] **Step 5: Run full suite**

Run: `npm run typecheck && npm run test`
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add src/server/quotes/rpc.ts src/server/quotes/service.ts src/server/rpc/api-parity.test.ts
git commit -m "feat(drive): register api_saveQuotationToDrive RPC"
```

---

### Task 6: One-time admin Drive-setup routes

**Files:**
- Create: `src/app/api/admin/drive-setup/start/route.ts`
- Create: `src/app/api/admin/drive-setup/callback/route.ts`
- Modify: `src/middleware.ts`

**Interfaces:**
- Consumes: `getRequestContext` (`src/server/auth/context.ts`), `ensureAdmin` (`src/server/auth/access.ts`), `sql` (`src/server/db/client.ts`), `normalizeRpcError` (`src/server/rpc/errors.ts`).
- Produces: two admin-gated HTTP routes, not consumed by any other task — this is the manual one-time credential-capture flow.

- [ ] **Step 1: Protect the routes in middleware**

In `src/middleware.ts`, change:

```ts
const PROTECTED_PREFIXES = ['/crm', '/api/rpc'];
```

to:

```ts
const PROTECTED_PREFIXES = ['/crm', '/api/rpc', '/api/admin'];
```

- [ ] **Step 2: Write the start route**

```ts
// src/app/api/admin/drive-setup/start/route.ts
import { NextResponse } from 'next/server';
import { google } from 'googleapis';

import { getRequestContext } from '../../../../../server/auth/context';
import { ensureAdmin } from '../../../../../server/auth/access';
import { normalizeRpcError } from '../../../../../server/rpc/errors';

const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.file';

export async function GET(request: Request): Promise<NextResponse> {
  if (process.env.GOOGLE_DRIVE_REFRESH_TOKEN) {
    return NextResponse.json(
      { error: 'Drive is already configured. Remove GOOGLE_DRIVE_REFRESH_TOKEN to re-run setup.' },
      { status: 409 }
    );
  }

  try {
    const context = await getRequestContext(request);
    ensureAdmin(context);
  } catch (error) {
    const rpcError = normalizeRpcError(error);
    return NextResponse.json({ error: rpcError.message }, { status: rpcError.status });
  }

  const clientId = process.env.GOOGLE_DRIVE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_DRIVE_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    return NextResponse.json(
      { error: 'GOOGLE_DRIVE_CLIENT_ID / GOOGLE_DRIVE_CLIENT_SECRET are not configured.' },
      { status: 500 }
    );
  }

  const redirectUri = new URL('/api/admin/drive-setup/callback', request.url).toString();
  const oauth2Client = new google.auth.OAuth2(clientId, clientSecret, redirectUri);
  const authUrl = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: [DRIVE_SCOPE]
  });

  return NextResponse.redirect(authUrl);
}
```

- [ ] **Step 3: Write the callback route**

```ts
// src/app/api/admin/drive-setup/callback/route.ts
import { NextResponse } from 'next/server';
import { google } from 'googleapis';

import { getRequestContext } from '../../../../../server/auth/context';
import { ensureAdmin } from '../../../../../server/auth/access';
import { normalizeRpcError } from '../../../../../server/rpc/errors';
import { sql } from '../../../../../server/db/client';

export async function GET(request: Request): Promise<NextResponse> {
  if (process.env.GOOGLE_DRIVE_REFRESH_TOKEN) {
    return NextResponse.json(
      { error: 'Drive is already configured. Remove GOOGLE_DRIVE_REFRESH_TOKEN to re-run setup.' },
      { status: 409 }
    );
  }

  try {
    const context = await getRequestContext(request);
    ensureAdmin(context);
  } catch (error) {
    const rpcError = normalizeRpcError(error);
    return NextResponse.json({ error: rpcError.message }, { status: rpcError.status });
  }

  const url = new URL(request.url);
  const code = url.searchParams.get('code');
  if (!code) {
    return NextResponse.json({ error: 'Missing authorization code from Google.' }, { status: 400 });
  }

  const clientId = process.env.GOOGLE_DRIVE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_DRIVE_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    return NextResponse.json(
      { error: 'GOOGLE_DRIVE_CLIENT_ID / GOOGLE_DRIVE_CLIENT_SECRET are not configured.' },
      { status: 500 }
    );
  }

  const redirectUri = new URL('/api/admin/drive-setup/callback', request.url).toString();
  const oauth2Client = new google.auth.OAuth2(clientId, clientSecret, redirectUri);

  let refreshToken: string | null | undefined;
  try {
    const { tokens } = await oauth2Client.getToken(code);
    refreshToken = tokens.refresh_token;
    oauth2Client.setCredentials(tokens);
  } catch {
    return NextResponse.json({ error: 'Failed to exchange the authorization code for tokens.' }, { status: 502 });
  }

  if (!refreshToken) {
    return NextResponse.json(
      {
        error:
          'Google did not return a refresh token. Revoke prior access at https://myaccount.google.com/permissions for this app, then try again.'
      },
      { status: 502 }
    );
  }

  const drive = google.drive({ version: 'v3', auth: oauth2Client });
  const folder = await drive.files.create({
    requestBody: { name: 'AS CRM Quotations Testing', mimeType: 'application/vnd.google-apps.folder' },
    fields: 'id'
  });

  const folderId = folder.data.id;
  if (!folderId) {
    return NextResponse.json({ error: 'Drive did not return a folder id.' }, { status: 502 });
  }

  await sql`
    insert into public.settings (key, value)
    values ('GOOGLE_DRIVE_QUOTATIONS_FOLDER_ID', ${folderId})
    on conflict (key) do update set value = excluded.value
  `;

  return new NextResponse(
    `<!doctype html><html><body style="font-family:monospace;padding:24px;white-space:pre-wrap">Drive folder "AS CRM Quotations Testing" created (id: ${folderId}) and saved to settings.

Add this ONE remaining env var to Vercel, then redeploy:

GOOGLE_DRIVE_REFRESH_TOKEN=${refreshToken}

This page will not show this value again - copy it now.</body></html>`,
    { headers: { 'content-type': 'text/html; charset=utf-8' } }
  );
}
```

- [ ] **Step 4: Typecheck and build**

Run: `npm run typecheck && npm run build`
Expected: both succeed; the build output lists two new dynamic routes under `/api/admin/drive-setup/*`.

- [ ] **Step 5: Commit**

```bash
git add src/app/api/admin/drive-setup/start/route.ts src/app/api/admin/drive-setup/callback/route.ts src/middleware.ts
git commit -m "feat(drive): add one-time admin-gated Drive OAuth setup routes"
```

---

### Task 7: Legacy UI button ("Save to Drive" / "View in Drive")

**Files:**
- Modify: `docs/source-appscript/Index.html` (around line 1817-1821, inside `mQuoteViewer`, plus a new `saveQuoteToDrive` function near `mQuoteViewer`)
- Modify: `src/app/crm/legacy-full.generated.ts` (hand-patched identically — generator is not run, see Global Constraints)
- Modify: `src/app/crm/legacy-app.test.ts`

**Interfaces:**
- Consumes: `api_saveQuotationToDrive` RPC (Task 5), `quote.driveViewLink` field (Task 5).
- Produces: nothing consumed by later tasks — this is the UI-facing surface.

- [ ] **Step 1: Write the failing vitest test**

In `src/app/crm/legacy-app.test.ts`, add a new test inside the existing `describe('legacy CRM full client', ...)` block (near the other `mQuoteViewer`-adjacent coverage — search for `api_getQuotation` usage in the e2e-style RPC mocks in this file for the exact payload shape already used elsewhere, e.g. the `does not execute customer names...` test's `mockRpc` pattern):

```ts
  test('saving a quotation to Drive replaces the button with a working link', async () => {
    let saveCalls = 0;
    mockRpc((fn) => {
      if (fn === 'api_workspace') return workspace('L6');
      if (fn === 'api_listCases') return [];
      if (fn === 'api_getQuotation') {
        return {
          quote: {
            quoteNo: 'QTN-2026-0001',
            rev: 0,
            caseId: 'CASE-2026-0001',
            title: 'Panel upgrade quote',
            source: 'Generated',
            fileName: '',
            templateId: '',
            templateName: 'Standard',
            status: 'Draft',
            subtotal: 100,
            taxPct: 18,
            taxAmount: 18,
            total: 118,
            currency: 'INR',
            validUntil: '',
            notes: '',
            doc: '/api/download/quote/QTN-2026-0001/0?format=html',
            pdf: '/api/download/quote/QTN-2026-0001/0?format=html',
            driveViewLink: saveCalls > 0 ? 'https://drive.google.com/file/d/file-123/view' : '',
            by: 'Admin User',
            date: '2026-07-29'
          },
          customer: { id: 'CUST-2026-0001', name: 'Acme Controls' },
          blocks: [],
          revisions: [{ rev: 0, status: 'Draft', date: '2026-07-29', total: 118 }]
        };
      }
      if (fn === 'api_saveQuotationToDrive') {
        saveCalls += 1;
        return { ok: true };
      }
      throw new Error(`Unexpected RPC ${fn}`);
    });

    render(createElement(CrmApp));
    await screen.findByRole('heading', { name: 'Overview' });
    window.eval('mQuoteViewer("QTN-2026-0001", 0)');

    const saveButton = await screen.findByRole('button', { name: 'Save to Drive' });
    saveButton.click();

    expect(await screen.findByRole('link', { name: 'View in Drive' })).toHaveAttribute(
      'href',
      'https://drive.google.com/file/d/file-123/view'
    );
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/app/crm/legacy-app.test.ts -t "saving a quotation to Drive"`
Expected: FAIL — no "Save to Drive" button exists yet.

- [ ] **Step 3: Edit `Index.html`**

Rather than rewriting the existing doc/pdf buttons block (whose escaping is easy to
get subtly wrong when mirrored into the generated artifact in Step 4), **insert**
two small self-contained additions at two verified-unique anchor points. Both
anchors were confirmed unique (`grep -c` = 1) in both `Index.html` and the
generated artifact before writing this plan.

Anchor 1 — immediately before the line `if(d.revisions.length>1){` (this line
appears exactly once in `Index.html`), insert:

```html
    html += '<div style="margin-top:8px;display:flex;gap:10px;flex-wrap:wrap">'+
      (q.driveViewLink
        ? '<a class="btn ghost sm" href="'+esc(q.driveViewLink)+'" target="_blank" rel="noopener">View in Drive</a>'
        : '<button class="btn ghost sm" id="driveSaveBtn" onclick="saveQuoteToDrive(\''+esc(quoteNo)+'\','+rev+')">Save to Drive</button>')+
      '</div>';
```

Anchor 2 — immediately before the line `function genDoc(quoteNo, rev){` (this
line appears exactly once in `Index.html`, right after `mQuoteViewer`'s closing
`}`), insert:

```js
function saveQuoteToDrive(quoteNo, rev){
  var btn = el('driveSaveBtn');
  if(btn){ btn.disabled = true; btn.textContent = 'Saving…'; }
  gs('api_saveQuotationToDrive', quoteNo, rev).then(function(){
    mQuoteViewer(quoteNo, rev);
  }).catch(function(e){
    if(btn){ btn.disabled = false; btn.textContent = 'Save to Drive'; }
    oops(e);
  });
}
```

- [ ] **Step 4: Hand-patch the frozen generated artifact with the same two insertions**

Since `legacy-full.generated.ts` stores the whole script as one escaped
single-line string, do this with a script that inserts at the same two
anchors by `indexOf`/`slice` — never by hand-retyping escaped text (verified
during planning: hand-transcribing the surrounding text's exact backslash
escaping is error-prone and silently produces a zero-match replacement).
Both anchor strings below were confirmed to occur exactly once in the current
`src/app/crm/legacy-full.generated.ts`.

```js
// scratch script - run with: node <path-to-script>.mjs, then delete it (not committed)
import fs from 'node:fs';

const path = 'src/app/crm/legacy-full.generated.ts';
const s = fs.readFileSync(path, 'utf8');

const anchor1 = 'if(d.revisions.length>1){';
const anchor2 = 'function genDoc(quoteNo, rev){';

for (const anchor of [anchor1, anchor2]) {
  const count = s.split(anchor).length - 1;
  if (count !== 1) throw new Error(`Expected exactly 1 occurrence of ${JSON.stringify(anchor)}, found ${count}`);
}

const driveButtonHtml =
  "html += '<div style=\\\"margin-top:8px;display:flex;gap:10px;flex-wrap:wrap\\\">'+" +
  "(q.driveViewLink?'<a class=\\\"btn ghost sm\\\" href=\\\"'+esc(q.driveViewLink)+'\\\" target=\\\"_blank\\\" rel=\\\"noopener\\\">View in Drive</a>':" +
  "'<button class=\\\"btn ghost sm\\\" id=\\\"driveSaveBtn\\\" onclick=\\\"saveQuoteToDrive('+jsArg(quoteNo)+','+rev+')\\\">Save to Drive</button>')+'</div>';\\n    ";

const saveQuoteToDriveFn =
  "function saveQuoteToDrive(quoteNo, rev){\\n" +
  "  var btn = el('driveSaveBtn');\\n" +
  "  if(btn){ btn.disabled = true; btn.textContent = 'Saving…'; }\\n" +
  "  gs('api_saveQuotationToDrive', quoteNo, rev).then(function(){\\n" +
  "    mQuoteViewer(quoteNo, rev);\\n" +
  "  }).catch(function(e){\\n" +
  "    if(btn){ btn.disabled = false; btn.textContent = 'Save to Drive'; }\\n" +
  "    oops(e);\\n" +
  "  });\\n" +
  "}\\n";

const withButton = s.replace(anchor1, driveButtonHtml + anchor1);
const withFn = withButton.replace(anchor2, saveQuoteToDriveFn + anchor2);

fs.writeFileSync(path, withFn);
console.log('Patched. Bytes added:', withFn.length - s.length);
```

Note: this script uses `jsArg(quoteNo)` (not `esc(quoteNo)+`-with-manual-quotes)
in the generated version's onclick attribute, matching the escaping helper the
generator already introduces elsewhere in this file for inline-handler
arguments (see `function jsArg(v)` defined earlier in the same file) — safer
than hand-building the quoted string the way the `Index.html` source version
does, since `jsArg` is already proven correct in this codebase for exactly
this purpose (see `CONTEXT.md`'s "generated legacy UI code uses escaped JS
argument helpers to prevent inline handler injection").

After running the script, verify with:

```bash
grep -c "saveQuoteToDrive" src/app/crm/legacy-full.generated.ts
```

Expected: `1` (the whole file is one line, so `grep -c` counts matching
*lines*, not occurrences — confirm occurrence count instead with
`node -e "console.log(require('fs').readFileSync('src/app/crm/legacy-full.generated.ts','utf8').split('saveQuoteToDrive').length - 1)"`,
expecting `2` (the function name appears once in its own declaration and once
in the button's `onclick`, and nowhere else).

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run src/app/crm/legacy-app.test.ts`
Expected: PASS, all tests including the new one.

- [ ] **Step 6: Run the API-parity test**

Run: `npx vitest run src/server/rpc/api-parity.test.ts`
Expected: PASS — `api_saveQuotationToDrive` now appears in `uiApis` (from the new `gs('api_saveQuotationToDrive', ...)` call in `Index.html`), is in the `intentionallyNew` allowlist (Task 5), and `hasRpc('api_saveQuotationToDrive')` is true (Task 5's registration).

- [ ] **Step 7: Run the forbidden-copy test explicitly**

Run: `npx vitest run src/app/crm/legacy-app.test.ts -t "does not retain Apps Script runtime references"`
Expected: PASS — "Save to Drive" / "View in Drive" do not match the forbidden-phrase regex.

- [ ] **Step 8: Run full suite and build**

Run: `npm run typecheck && npm run test && npm run build`
Expected: all pass.

- [ ] **Step 9: Commit**

```bash
git add docs/source-appscript/Index.html src/app/crm/legacy-full.generated.ts src/app/crm/legacy-app.test.ts
git commit -m "feat(drive): add Save to Drive / View in Drive button to quote viewer"
```

---

### Task 8: E2E coverage

**Files:**
- Modify: `tests/e2e/crm-smoke.spec.ts`

**Interfaces:**
- Consumes: existing `setUpAuthenticatedSession` helper, `customerDetailPayload`/`caseSummary` fixtures already in this file.

- [ ] **Step 1: Write the test**

Add near the other quote-related tests, reusing the existing `rpcData`/`setUpAuthenticatedSession` pattern in this file:

```ts
test('saving a quotation to Drive shows a working View in Drive link', async ({ context, page }) => {
  test.skip(
    !isFakeSupabaseConfigured(),
    `Set NEXT_PUBLIC_SUPABASE_URL=${fakeSupabaseUrl} and NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY to a dummy value to run the mocked-auth shell smoke test.`
  );

  let driveSaved = false;
  await setUpAuthenticatedSession(context, page);
  await page.route('**/api/rpc', async (route) => {
    const body = route.request().postDataJSON() as { fn: string; args?: unknown[] };
    if (body.fn === 'api_saveQuotationToDrive') {
      driveSaved = true;
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, data: { ok: true } }) });
      return;
    }
    if (body.fn === 'api_getQuotation') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          ok: true,
          data: {
            customer: { id: 'CUST-2026-0001', name: 'Acme Controls' },
            quote: {
              quoteNo: 'QTN-2026-0001',
              rev: 0,
              caseId: 'CASE-2026-0001',
              title: 'Panel upgrade quote',
              source: 'Generated',
              fileName: '',
              templateId: '',
              templateName: 'Standard',
              status: 'Sent',
              subtotal: 101695,
              taxPct: 18,
              taxAmount: 18305,
              total: 120000,
              currency: 'INR',
              validUntil: '2026-08-29',
              notes: '',
              doc: '/api/download/quote/QTN-2026-0001/0?format=html',
              pdf: '/api/download/quote/QTN-2026-0001/0?format=html',
              driveViewLink: driveSaved ? 'https://drive.google.com/file/d/file-123/view' : '',
              by: 'Playwright Admin',
              date: '2026-07-29'
            },
            blocks: [{ title: 'Items', headers: ['Item', 'Amount'], rows: [['Panel upgrade', '120000']] }],
            revisions: [{ rev: 0, status: 'Sent', date: '2026-07-29', total: 120000 }]
          }
        })
      });
      return;
    }
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, data: rpcData(body.fn) }) });
  });

  await page.goto('/crm/cases');
  await page.getByText('Panel upgrade').first().click();
  await page.getByTestId('crm-route').getByRole('button', { name: 'Open' }).click();

  await page.getByRole('button', { name: 'Save to Drive' }).click();
  await expect(page.getByRole('link', { name: 'View in Drive' })).toHaveAttribute(
    'href',
    'https://drive.google.com/file/d/file-123/view'
  );
});
```

- [ ] **Step 2: Run it**

Run:
```powershell
$env:NEXT_PUBLIC_SUPABASE_URL='http://127.0.0.1:3999'
$env:NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY='dummy-anon-key'
npx playwright test crm-smoke -g "Save to Drive"
```
Expected: PASS.

- [ ] **Step 3: Run the full e2e suite once more to confirm no regressions**

Run (same env vars as above): `npx playwright test --workers=1`
Expected: all tests pass.

- [ ] **Step 4: Commit**

```bash
git add tests/e2e/crm-smoke.spec.ts
git commit -m "test(drive): add e2e coverage for Save to Drive / View in Drive"
```

---

### Task 9: Documentation and final verification

**Files:**
- Modify: `CONTEXT.md`
- Modify: `.env.example` (already has placeholders from this session - confirm they're present, no change needed if so)

**Interfaces:** none - documentation only.

- [ ] **Step 1: Update `CONTEXT.md`**

Add a new dated entry under "Current Production Status" documenting: what was built (module list, RPC name, DB columns, admin setup routes), that credentials are already in Vercel env vars (`GOOGLE_DRIVE_CLIENT_ID`, `GOOGLE_DRIVE_CLIENT_SECRET` — confirm `GOOGLE_DRIVE_REFRESH_TOKEN` status depending on whether the one-time setup has been run by the time this task executes), the folder name (`AS CRM Quotations Testing`) and its `public.settings` key (`GOOGLE_DRIVE_QUOTATIONS_FOLDER_ID`), and a pointer to the deferred "full legacy revival" scope (real Google Doc templates + Docs API merge-fill + Drive PDF export) as ready-to-pick-up future work per the spec.

- [ ] **Step 2: Run the full verification suite**

Run: `npm run typecheck && npm run test && npm run build`
Expected: all green.

- [ ] **Step 3: Commit**

```bash
git add CONTEXT.md
git commit -m "docs: record Google Drive quotation save feature in CONTEXT.md"
```

- [ ] **Step 4: If the one-time OAuth setup has not yet been run, tell the project owner**

Report back: "Everything is deployed. To finish setup, sign in as an L6 admin at `https://crm.automationsystems.info/api/admin/drive-setup/start`, approve the consent screen as `testing@automationsystems.org`, then copy the printed `GOOGLE_DRIVE_REFRESH_TOKEN` into Vercel env vars and redeploy."
