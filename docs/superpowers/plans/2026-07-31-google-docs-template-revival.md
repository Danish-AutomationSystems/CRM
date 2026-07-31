# Legacy Quotation Template Revival Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restore 100% legacy quotation behaviour — real Google Doc templates listed live from a Drive folder, merge-filled via the Docs API (including BOQ tables), exported to a real PDF via Drive, with both files stored in the Quotations Drive folder and linked on the quote row.

**Architecture:** All Docs API *request construction* lives in pure, network-free functions (`src/server/drive/template-merge.ts`) tested against hand-built Docs API JSON fixtures. Two thin API wrappers (`DriveClient` extensions, new `DocsClient`) are the only code touching Google. `generateQuoteDoc` becomes an orchestrator wiring them together. This mirrors the existing `DriveClient`/`DriveService` split already proven in this codebase.

**Tech Stack:** `googleapis` (Drive v3 + Docs v1), existing Postgres/`postgres` tagged templates, existing RPC registry, existing frozen-artifact dual-edit discipline.

## Global Constraints

- **Never run `node scripts/port-legacy-index.mjs`** — the generator is broken (documented in `CONTEXT.md`). UI changes are dual-edited: `docs/source-appscript/Index.html` (source of truth) **and** a script-based insertion patch into `src/app/crm/legacy-full.generated.ts`.
- `googleapis` must stay **dynamically imported** (`await import('googleapis')`) inside functions in `src/server/drive/*` — never a top-level import there. `src/server/quotes/rpc.ts` is on the hot `/api/rpc` path. (The `src/app/api/admin/drive-setup/*` routes are separate bundles and keep their static import.)
- `createDriveClient()` / `createDocsClient()` validate env vars **eagerly on call**; callers on the RPC path must receive them as **lazy factories** (`getDriveClient: createDriveClient`), never pre-built at module scope.
- Merge-field names must match legacy **exactly**: `{{QUOTE_NO}} {{REV}} {{DATE}} {{CUSTOMER_NAME}} {{CUSTOMER_ADDRESS}} {{CONTACT_NAME}} {{TITLE}} {{VALID_UNTIL}} {{NOTES}} {{TAX_PCT}} {{SUBTOTAL}} {{TAX_AMOUNT}} {{TOTAL}} {{CURRENCY}} {{COMPANY}} {{PREPARED_BY}}` plus the `{{BOQ_TABLE}}` structural marker.
- Drive folder names: Quotations = `AS CRM Quotations Testing` (already exists), Templates = `AS CRM Templates Testing` (new).
- Settings keys: `GOOGLE_DRIVE_QUOTATIONS_FOLDER_ID` (exists), `GOOGLE_DRIVE_TEMPLATES_FOLDER_ID` (new).
- Run `npm run typecheck && npm run test` before every commit. Never `git add -A`.

### Docs API index rules (load-bearing — get these wrong and documents corrupt)

1. Within one `batchUpdate`, requests apply **sequentially** and every insertion **shifts all later indices**.
2. Therefore, to place items A,B,C in order at one index N, issue the inserts in **reverse** (C, then B, then A — each at N).
3. Therefore, to fill many already-existing cells, issue `insertText` in **descending index order**.
4. `insertTable` creates cells each containing one empty paragraph; the API's `batchUpdate` reply does **not** return per-cell indices. You must re-`documents.get()` and read `table.tableRows[].tableCells[].content[].startIndex`.

---

### Task 1: Pure Docs API request builders (`template-merge.ts`)

**Files:**
- Create: `src/server/drive/template-merge.ts`
- Test: `src/server/drive/template-merge.test.ts`

**Interfaces:**
- Consumes: nothing (pure module, no imports beyond types it declares itself).
- Produces, all consumed by Task 7:
  - `export type DocsRequest = Record<string, unknown>;`
  - `export type MergeFields = Record<string, string>;`
  - `export type BoqBlockInput = { title: string; headers: string[]; rows: string[][] };`
  - `export type TotalsInput = { currency: string; subtotal: string; taxPct: string; taxAmount: string; total: string };`
  - `export type MarkerLocation = { startIndex: number; endIndex: number };`
  - `export type DocsDocument = { body?: { content?: unknown[] } };`
  - `export function buildMergeFieldRequests(fields: MergeFields): DocsRequest[]`
  - `export function locateMarker(doc: DocsDocument, marker: string): MarkerLocation | null`
  - `export function buildStructureRequests(marker: MarkerLocation, blocks: BoqBlockInput[], totals: TotalsInput): DocsRequest[]`
  - `export function collectTables(doc: DocsDocument): Array<{ startIndex: number; cellStartIndices: number[] }>`
  - `export function buildCellFillRequests(tables: Array<{ startIndex: number; cellStartIndices: number[] }>, tableValues: string[][]): DocsRequest[]`

- [ ] **Step 1: Write the failing tests**

```ts
// src/server/drive/template-merge.test.ts
import { describe, expect, it } from 'vitest';

import {
  buildCellFillRequests,
  buildMergeFieldRequests,
  buildStructureRequests,
  collectTables,
  locateMarker,
  type DocsDocument
} from './template-merge';

function docWithParagraph(text: string, startIndex = 1): DocsDocument {
  return {
    body: {
      content: [
        { startIndex: 0, endIndex: 1, sectionBreak: {} },
        {
          startIndex,
          endIndex: startIndex + text.length + 1,
          paragraph: {
            elements: [
              {
                startIndex,
                endIndex: startIndex + text.length,
                textRun: { content: text }
              }
            ]
          }
        }
      ]
    }
  };
}

describe('buildMergeFieldRequests', () => {
  it('emits one matchCase replaceAllText per field', () => {
    const requests = buildMergeFieldRequests({ '{{QUOTE_NO}}': 'QTN-2026-0001', '{{REV}}': 'R0' });

    expect(requests).toEqual([
      { replaceAllText: { containsText: { text: '{{QUOTE_NO}}', matchCase: true }, replaceText: 'QTN-2026-0001' } },
      { replaceAllText: { containsText: { text: '{{REV}}', matchCase: true }, replaceText: 'R0' } }
    ]);
  });

  it('replaces an empty value with an empty string rather than skipping the field', () => {
    expect(buildMergeFieldRequests({ '{{NOTES}}': '' })).toEqual([
      { replaceAllText: { containsText: { text: '{{NOTES}}', matchCase: true }, replaceText: '' } }
    ]);
  });
});

describe('locateMarker', () => {
  it('finds the marker range inside a text run', () => {
    const doc = docWithParagraph('{{BOQ_TABLE}}', 10);
    expect(locateMarker(doc, '{{BOQ_TABLE}}')).toEqual({ startIndex: 10, endIndex: 23 });
  });

  it('finds a marker embedded in surrounding text', () => {
    const doc = docWithParagraph('AB{{BOQ_TABLE}}', 10);
    expect(locateMarker(doc, '{{BOQ_TABLE}}')).toEqual({ startIndex: 12, endIndex: 25 });
  });

  it('returns null when the marker is absent', () => {
    expect(locateMarker(docWithParagraph('no marker here'), '{{BOQ_TABLE}}')).toBeNull();
  });
});

describe('buildStructureRequests', () => {
  const marker = { startIndex: 40, endIndex: 53 };
  const totals = { currency: 'INR', subtotal: '1,000.00', taxPct: '18', taxAmount: '180.00', total: '1,180.00' };

  it('deletes the marker first, then inserts in reverse so document order is title, table, totals', () => {
    const requests = buildStructureRequests(
      marker,
      [{ title: 'Main panel BOQ', headers: ['Item', 'Qty'], rows: [['Contactor', '4']] }],
      totals
    );

    expect(requests[0]).toEqual({ deleteContentRange: { range: { startIndex: 40, endIndex: 53 } } });
    // Reverse order: totals table, then the block's table, then the block's title.
    expect(requests[1]).toEqual({ insertTable: { rows: 3, columns: 2, location: { index: 40 } } });
    expect(requests[2]).toEqual({ insertTable: { rows: 2, columns: 2, location: { index: 40 } } });
    expect(requests[3]).toEqual({ insertText: { text: 'Main panel BOQ\n', location: { index: 40 } } });
    expect(requests).toHaveLength(4);
  });

  it('omits the title insert when a block has no title', () => {
    const requests = buildStructureRequests(marker, [{ title: '', headers: ['Item'], rows: [] }], totals);
    expect(requests.some((r) => 'insertText' in r)).toBe(false);
  });

  it('sizes each block table as headers plus rows', () => {
    const requests = buildStructureRequests(
      marker,
      [{ title: '', headers: ['A', 'B', 'C'], rows: [['1', '2', '3'], ['4', '5', '6']] }],
      totals
    );
    expect(requests).toContainEqual({ insertTable: { rows: 3, columns: 3, location: { index: 40 } } });
  });
});

describe('collectTables', () => {
  it('reads each table cell start index in row-major order', () => {
    const doc: DocsDocument = {
      body: {
        content: [
          {
            startIndex: 40,
            table: {
              tableRows: [
                { tableCells: [{ content: [{ startIndex: 43 }] }, { content: [{ startIndex: 46 }] }] },
                { tableCells: [{ content: [{ startIndex: 49 }] }, { content: [{ startIndex: 52 }] }] }
              ]
            }
          }
        ]
      }
    };

    expect(collectTables(doc)).toEqual([{ startIndex: 40, cellStartIndices: [43, 46, 49, 52] }]);
  });

  it('returns an empty list for a document with no tables', () => {
    expect(collectTables(docWithParagraph('text'))).toEqual([]);
  });
});

describe('buildCellFillRequests', () => {
  it('emits insertText in descending index order so earlier indices stay valid', () => {
    const tables = [{ startIndex: 40, cellStartIndices: [43, 46, 49, 52] }];
    const requests = buildCellFillRequests(tables, [['Item', 'Qty', 'Contactor', '4']]);

    expect(requests).toEqual([
      { insertText: { text: '4', location: { index: 52 } } },
      { insertText: { text: 'Contactor', location: { index: 49 } } },
      { insertText: { text: 'Qty', location: { index: 46 } } },
      { insertText: { text: 'Item', location: { index: 43 } } }
    ]);
  });

  it('skips empty cell values so no zero-length insert is sent', () => {
    const tables = [{ startIndex: 40, cellStartIndices: [43, 46] }];
    expect(buildCellFillRequests(tables, [['', 'Qty']])).toEqual([
      { insertText: { text: 'Qty', location: { index: 46 } } }
    ]);
  });

  it('ignores tables with no matching value list rather than throwing', () => {
    const tables = [{ startIndex: 40, cellStartIndices: [43] }, { startIndex: 60, cellStartIndices: [63] }];
    expect(buildCellFillRequests(tables, [['A']])).toEqual([{ insertText: { text: 'A', location: { index: 43 } } }]);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/server/drive/template-merge.test.ts`
Expected: FAIL — "Cannot find module './template-merge'".

- [ ] **Step 3: Implement**

```ts
// src/server/drive/template-merge.ts

// Pure Docs API request builders. No network, no googleapis import - every
// function here takes plain JSON in and returns plain JSON out, so the whole
// merge pipeline is unit-testable against hand-built fixtures.

export type DocsRequest = Record<string, unknown>;
export type MergeFields = Record<string, string>;
export type BoqBlockInput = { title: string; headers: string[]; rows: string[][] };
export type TotalsInput = {
  currency: string;
  subtotal: string;
  taxPct: string;
  taxAmount: string;
  total: string;
};
export type MarkerLocation = { startIndex: number; endIndex: number };
export type DocsDocument = { body?: { content?: unknown[] } };
export type TableLocation = { startIndex: number; cellStartIndices: number[] };

export function buildMergeFieldRequests(fields: MergeFields): DocsRequest[] {
  return Object.entries(fields).map(([placeholder, value]) => ({
    replaceAllText: {
      containsText: { text: placeholder, matchCase: true },
      replaceText: value
    }
  }));
}

type ParagraphElement = { startIndex?: number; textRun?: { content?: string } };
type StructuralElement = {
  startIndex?: number;
  paragraph?: { elements?: ParagraphElement[] };
  table?: { tableRows?: Array<{ tableCells?: Array<{ content?: Array<{ startIndex?: number }> }> }> };
};

function structuralElements(doc: DocsDocument): StructuralElement[] {
  return (doc.body?.content ?? []) as StructuralElement[];
}

export function locateMarker(doc: DocsDocument, marker: string): MarkerLocation | null {
  for (const element of structuralElements(doc)) {
    for (const paragraphElement of element.paragraph?.elements ?? []) {
      const content = paragraphElement.textRun?.content;
      if (typeof content !== 'string') continue;
      const offset = content.indexOf(marker);
      if (offset < 0) continue;
      const runStart = paragraphElement.startIndex ?? 0;
      return { startIndex: runStart + offset, endIndex: runStart + offset + marker.length };
    }
  }
  return null;
}

export function buildStructureRequests(
  marker: MarkerLocation,
  blocks: BoqBlockInput[],
  totals: TotalsInput
): DocsRequest[] {
  const at = marker.startIndex;

  // The marker text is removed first so the inserts below land exactly where
  // it stood. Everything after this is emitted in REVERSE document order:
  // each insert at the same index pushes previously-inserted content further
  // down, so emitting last-first yields first-first in the final document.
  const requests: DocsRequest[] = [
    { deleteContentRange: { range: { startIndex: marker.startIndex, endIndex: marker.endIndex } } },
    { insertTable: { rows: 3, columns: 2, location: { index: at } } }
  ];

  for (const block of [...blocks].reverse()) {
    requests.push({
      insertTable: { rows: block.headers.length ? block.rows.length + 1 : 0, columns: block.headers.length, location: { index: at } }
    });
    if (block.title) {
      requests.push({ insertText: { text: `${block.title}\n`, location: { index: at } } });
    }
  }

  return requests;
}

export function collectTables(doc: DocsDocument): TableLocation[] {
  const tables: TableLocation[] = [];
  for (const element of structuralElements(doc)) {
    const rows = element.table?.tableRows;
    if (!rows) continue;
    const cellStartIndices: number[] = [];
    for (const row of rows) {
      for (const cell of row.tableCells ?? []) {
        const start = cell.content?.[0]?.startIndex;
        if (typeof start === 'number') cellStartIndices.push(start);
      }
    }
    tables.push({ startIndex: element.startIndex ?? 0, cellStartIndices });
  }
  return tables;
}

export function buildCellFillRequests(tables: TableLocation[], tableValues: string[][]): DocsRequest[] {
  const inserts: Array<{ index: number; text: string }> = [];

  tables.forEach((table, tableIndex) => {
    const values = tableValues[tableIndex];
    if (!values) return;
    table.cellStartIndices.forEach((index, cellIndex) => {
      const text = values[cellIndex];
      if (!text) return;
      inserts.push({ index, text });
    });
  });

  // Descending index order: inserting text shifts every later index, so the
  // highest index must be written first for the rest to stay valid.
  return inserts
    .sort((a, b) => b.index - a.index)
    .map(({ index, text }) => ({ insertText: { text, location: { index } } }));
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run src/server/drive/template-merge.test.ts`
Expected: PASS (all cases).

- [ ] **Step 5: Commit**

```bash
git add src/server/drive/template-merge.ts src/server/drive/template-merge.test.ts
git commit -m "feat(docs): add pure Docs API request builders for template merge"
```

---

### Task 2: Drive client extensions + templates-folder lookup

**Files:**
- Modify: `src/server/drive/client.ts`
- Create: `src/server/drive/template-folder.ts`
- Modify: `src/server/drive/client.test.ts`

**Interfaces:**
- Produces, consumed by Tasks 6 and 7:
  - `DriveClient` gains: `listDocsInFolder(folderId: string): Promise<Array<{ id: string; name: string }>>`, `copyFile(fileId: string, name: string, folderId: string): Promise<{ id: string; webViewLink: string }>`, `exportPdf(fileId: string): Promise<Buffer>`, `shareDomainReadable(fileId: string): Promise<void>`
  - `export async function getDriveTemplatesFolderId(): Promise<string>` from `template-folder.ts`

- [ ] **Step 1: Write the failing tests**

Append to `src/server/drive/client.test.ts`'s existing mock setup — extend the existing `vi.mock('googleapis', ...)` factory so `drive()` also returns `files.list`, `files.copy`, and `files.export` mocks alongside the existing `files.create`/`permissions.create`. Declare them next to the existing `filesCreate`/`permissionsCreate` consts and reset them in `beforeEach`, exactly matching that file's existing style.

```ts
  it('lists only Google Docs in the given folder, newest name order', async () => {
    filesList.mockResolvedValue({ data: { files: [{ id: 'tpl-1', name: 'Standard' }] } });

    const { createDriveClient } = await import('./client');
    const result = await createDriveClient().listDocsInFolder('folder-tpl');

    expect(result).toEqual([{ id: 'tpl-1', name: 'Standard' }]);
    expect(filesList).toHaveBeenCalledWith(
      expect.objectContaining({
        q: "'folder-tpl' in parents and mimeType='application/vnd.google-apps.document' and trashed=false",
        fields: 'files(id, name)',
        orderBy: 'name'
      })
    );
  });

  it('returns an empty list when the folder has no documents', async () => {
    filesList.mockResolvedValue({ data: {} });
    const { createDriveClient } = await import('./client');
    expect(await createDriveClient().listDocsInFolder('folder-tpl')).toEqual([]);
  });

  it('copies a template into the target folder', async () => {
    filesCopy.mockResolvedValue({ data: { id: 'copy-1', webViewLink: 'https://drive.google.com/file/d/copy-1/view' } });

    const { createDriveClient } = await import('./client');
    const result = await createDriveClient().copyFile('tpl-1', 'QTN-2026-0001-R0 - Acme', 'folder-out');

    expect(result).toEqual({ id: 'copy-1', webViewLink: 'https://drive.google.com/file/d/copy-1/view' });
    expect(filesCopy).toHaveBeenCalledWith(
      expect.objectContaining({
        fileId: 'tpl-1',
        requestBody: { name: 'QTN-2026-0001-R0 - Acme', parents: ['folder-out'] },
        fields: 'id, webViewLink'
      })
    );
  });

  it('throws when a copy returns no file id', async () => {
    filesCopy.mockResolvedValue({ data: {} });
    const { createDriveClient } = await import('./client');
    await expect(createDriveClient().copyFile('tpl-1', 'x', 'folder-out')).rejects.toThrow('Drive did not return a file id.');
  });

  it('exports a document to PDF bytes', async () => {
    filesExport.mockResolvedValue({ data: new Uint8Array([37, 80, 68, 70]).buffer });

    const { createDriveClient } = await import('./client');
    const pdf = await createDriveClient().exportPdf('copy-1');

    expect(Buffer.isBuffer(pdf)).toBe(true);
    expect(pdf.subarray(0, 4).toString('latin1')).toBe('%PDF');
    expect(filesExport).toHaveBeenCalledWith(
      { fileId: 'copy-1', mimeType: 'application/pdf' },
      { responseType: 'arraybuffer' }
    );
  });

  it('tolerates a sharing failure on shareDomainReadable', async () => {
    permissionsCreate.mockRejectedValue(new Error('Domain policy blocks link sharing.'));
    const { createDriveClient } = await import('./client');
    await expect(createDriveClient().shareDomainReadable('copy-1')).resolves.toBeUndefined();
  });
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/server/drive/client.test.ts`
Expected: FAIL — the new methods don't exist on `DriveClient`.

- [ ] **Step 3: Implement the client extensions**

In `src/server/drive/client.ts`, extend the `DriveClient` type and the returned object. Factor the repeated `await import('googleapis')` + OAuth setup into one local helper inside `createDriveClient`'s closure so the lazy-import rule holds and there is exactly one place constructing the Drive handle:

```ts
export type DriveClient = {
  uploadFile(input: DriveFileUpload, folderId: string): Promise<{ id: string; webViewLink: string }>;
  listDocsInFolder(folderId: string): Promise<Array<{ id: string; name: string }>>;
  copyFile(fileId: string, name: string, folderId: string): Promise<{ id: string; webViewLink: string }>;
  exportPdf(fileId: string): Promise<Buffer>;
  shareDomainReadable(fileId: string): Promise<void>;
};
```

Inside `createDriveClient()`, after the three `requireEnv` calls, add:

```ts
  async function driveApi() {
    // Lazy import: this module is reachable from the hot /api/rpc path.
    const { google } = await import('googleapis');
    const oauth2Client = new google.auth.OAuth2(clientId, clientSecret);
    oauth2Client.setCredentials({ refresh_token: refreshToken });
    return google.drive({ version: 'v3', auth: oauth2Client });
  }

  async function shareDomainReadable(fileId: string): Promise<void> {
    const drive = await driveApi();
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
      // Some Workspace domains restrict link sharing - the file still exists
      // and the operation still succeeds (mirrors legacy Code.gs:1722).
    }
  }
```

Rewrite `uploadFile` to use `driveApi()` and `shareDomainReadable()` rather than its own inline copies (behaviour identical — the existing tests must still pass unchanged), then add:

```ts
    async listDocsInFolder(folderId: string) {
      const drive = await driveApi();
      const response = await drive.files.list({
        q: `'${folderId}' in parents and mimeType='application/vnd.google-apps.document' and trashed=false`,
        fields: 'files(id, name)',
        orderBy: 'name'
      });
      return (response.data.files ?? [])
        .map((file) => ({ id: String(file.id ?? ''), name: String(file.name ?? '') }))
        .filter((file) => file.id && file.name);
    },

    async copyFile(fileId: string, name: string, folderId: string) {
      const drive = await driveApi();
      const response = await drive.files.copy({
        fileId,
        requestBody: { name, parents: [folderId] },
        fields: 'id, webViewLink'
      });
      const copyId = response.data.id;
      if (!copyId) throw new Error('Drive did not return a file id.');
      return { id: copyId, webViewLink: response.data.webViewLink ?? '' };
    },

    async exportPdf(fileId: string) {
      const drive = await driveApi();
      const response = await drive.files.export(
        { fileId, mimeType: 'application/pdf' },
        { responseType: 'arraybuffer' }
      );
      return Buffer.from(response.data as ArrayBuffer);
    },

    shareDomainReadable,
```

- [ ] **Step 4: Write `template-folder.ts`**

```ts
// src/server/drive/template-folder.ts
import { sql } from '../db/client';

const TEMPLATES_FOLDER_SETTING_KEY = 'GOOGLE_DRIVE_TEMPLATES_FOLDER_ID';

export async function getDriveTemplatesFolderId(): Promise<string> {
  const rows = (await sql`
    select value
    from public.settings
    where key = ${TEMPLATES_FOLDER_SETTING_KEY}
    limit 1
  `) as Array<{ value: string | null }>;

  const folderId = rows[0]?.value?.trim();
  if (!folderId) {
    throw new Error('Google Drive templates folder is not configured. Run the one-time Drive setup first.');
  }
  return folderId;
}
```

- [ ] **Step 5: Run tests**

Run: `npx vitest run src/server/drive/client.test.ts`
Expected: PASS — all pre-existing `uploadFile` tests plus the new ones.

- [ ] **Step 6: Commit**

```bash
git add src/server/drive/client.ts src/server/drive/client.test.ts src/server/drive/template-folder.ts
git commit -m "feat(drive): add copy/export/list operations and templates-folder lookup"
```

---

### Task 3: Docs API client (`docs.ts`)

**Files:**
- Create: `src/server/drive/docs.ts`
- Test: `src/server/drive/docs.test.ts`

**Interfaces:**
- Produces, consumed by Tasks 4 and 7:
  - `export type DocsClient = { getDocument(documentId: string): Promise<DocsDocument>; batchUpdate(documentId: string, requests: DocsRequest[]): Promise<void>; }`
  - `export function createDocsClient(): DocsClient`

- [ ] **Step 1: Write the failing tests**

```ts
// src/server/drive/docs.test.ts
import { beforeEach, describe, expect, it, vi } from 'vitest';

const documentsGet = vi.fn();
const documentsBatchUpdate = vi.fn();

vi.mock('googleapis', () => ({
  google: {
    auth: { OAuth2: vi.fn().mockImplementation(() => ({ setCredentials: vi.fn() })) },
    docs: vi.fn().mockImplementation(() => ({
      documents: { get: documentsGet, batchUpdate: documentsBatchUpdate }
    }))
  }
}));

describe('createDocsClient', () => {
  beforeEach(() => {
    documentsGet.mockReset();
    documentsBatchUpdate.mockReset();
    process.env.GOOGLE_DRIVE_CLIENT_ID = 'test-client-id';
    process.env.GOOGLE_DRIVE_CLIENT_SECRET = 'test-client-secret';
    process.env.GOOGLE_DRIVE_REFRESH_TOKEN = 'test-refresh-token';
  });

  it('fetches a document by id', async () => {
    documentsGet.mockResolvedValue({ data: { body: { content: [] } } });

    const { createDocsClient } = await import('./docs');
    const doc = await createDocsClient().getDocument('doc-1');

    expect(doc).toEqual({ body: { content: [] } });
    expect(documentsGet).toHaveBeenCalledWith({ documentId: 'doc-1' });
  });

  it('sends batched requests', async () => {
    documentsBatchUpdate.mockResolvedValue({ data: {} });
    const requests = [{ insertText: { text: 'x', location: { index: 1 } } }];

    const { createDocsClient } = await import('./docs');
    await createDocsClient().batchUpdate('doc-1', requests);

    expect(documentsBatchUpdate).toHaveBeenCalledWith({ documentId: 'doc-1', requestBody: { requests } });
  });

  it('skips the API call entirely when there are no requests', async () => {
    const { createDocsClient } = await import('./docs');
    await createDocsClient().batchUpdate('doc-1', []);
    expect(documentsBatchUpdate).not.toHaveBeenCalled();
  });

  it('throws a clear error when required env vars are missing', async () => {
    delete process.env.GOOGLE_DRIVE_CLIENT_ID;
    const { createDocsClient } = await import('./docs');
    expect(() => createDocsClient()).toThrow('GOOGLE_DRIVE_CLIENT_ID is not configured.');
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/server/drive/docs.test.ts`
Expected: FAIL — "Cannot find module './docs'".

- [ ] **Step 3: Implement**

```ts
// src/server/drive/docs.ts
import type { DocsDocument, DocsRequest } from './template-merge';

export type DocsClient = {
  getDocument(documentId: string): Promise<DocsDocument>;
  batchUpdate(documentId: string, requests: DocsRequest[]): Promise<void>;
};

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not configured.`);
  return value;
}

export function createDocsClient(): DocsClient {
  // Validated eagerly, same contract as createDriveClient - callers on the
  // RPC path must pass this factory lazily, never call it at module scope.
  const clientId = requireEnv('GOOGLE_DRIVE_CLIENT_ID');
  const clientSecret = requireEnv('GOOGLE_DRIVE_CLIENT_SECRET');
  const refreshToken = requireEnv('GOOGLE_DRIVE_REFRESH_TOKEN');

  async function docsApi() {
    // Lazy import: reachable from the hot /api/rpc path.
    const { google } = await import('googleapis');
    const oauth2Client = new google.auth.OAuth2(clientId, clientSecret);
    oauth2Client.setCredentials({ refresh_token: refreshToken });
    return google.docs({ version: 'v1', auth: oauth2Client });
  }

  return {
    async getDocument(documentId: string) {
      const docs = await docsApi();
      const response = await docs.documents.get({ documentId });
      return (response.data ?? {}) as DocsDocument;
    },

    async batchUpdate(documentId: string, requests: DocsRequest[]) {
      if (!requests.length) return;
      const docs = await docsApi();
      await docs.documents.batchUpdate({ documentId, requestBody: { requests } });
    }
  };
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run src/server/drive/docs.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/server/drive/docs.ts src/server/drive/docs.test.ts
git commit -m "feat(docs): add Docs API client wrapper"
```

---

### Task 4: OAuth scope + templates folder + starter template seeding

**Files:**
- Modify: `src/app/api/admin/drive-setup/start/route.ts`
- Modify: `src/app/api/admin/drive-setup/callback/route.ts`

**Interfaces:**
- Consumes: nothing from other tasks (these routes keep their own static `googleapis` import — separate bundle).
- Produces: `public.settings` key `GOOGLE_DRIVE_TEMPLATES_FOLDER_ID`, and a seeded starter template Doc in that folder. Consumed operationally by Task 6 at runtime.

- [ ] **Step 1: Add the Docs scope to the start route**

In `src/app/api/admin/drive-setup/start/route.ts`, replace the single-scope constant and its use:

```ts
const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.file';
const DOCS_SCOPE = 'https://www.googleapis.com/auth/documents';
```

and change `scope: [DRIVE_SCOPE]` to `scope: [DRIVE_SCOPE, DOCS_SCOPE]`.

- [ ] **Step 2: Create the templates folder and seed the starter template in the callback route**

In `src/app/api/admin/drive-setup/callback/route.ts`, after the existing Quotations-folder creation and its `folderId` null-check, and before the existing `insert into public.settings` statement, add:

```ts
  const templatesFolder = await drive.files.create({
    requestBody: { name: 'AS CRM Templates Testing', mimeType: 'application/vnd.google-apps.folder' },
    fields: 'id'
  });
  const templatesFolderId = templatesFolder.data.id;
  if (!templatesFolderId) {
    return NextResponse.json({ error: 'Drive did not return a templates folder id.' }, { status: 502 });
  }

  const starterFile = await drive.files.create({
    requestBody: {
      name: 'Quotation Template - Standard',
      mimeType: 'application/vnd.google-apps.document',
      parents: [templatesFolderId]
    },
    fields: 'id'
  });
  const starterId = starterFile.data.id;
  if (!starterId) {
    return NextResponse.json({ error: 'Drive did not return a starter template id.' }, { status: 502 });
  }

  // Body text mirrors the legacy createStarterTemplate_ (Code.gs:165),
  // including every merge placeholder generateQuoteDoc fills in.
  const starterBody = [
    '{{COMPANY}}',
    'Industrial Automation | Control & Distribution Panels | Energy Management',
    '',
    'QUOTATION',
    'Quote No: {{QUOTE_NO}}    Rev: {{REV}}    Date: {{DATE}}',
    '',
    'To: {{CUSTOMER_NAME}}',
    '{{CUSTOMER_ADDRESS}}',
    'Kind Attn: {{CONTACT_NAME}}',
    '',
    'Subject: {{TITLE}}',
    '',
    'Dear Sir / Madam,',
    'Thank you for your enquiry. We are pleased to submit our offer as per the details below.',
    '',
    '{{BOQ_TABLE}}',
    '',
    'Notes: {{NOTES}}',
    '',
    'Terms & Conditions',
    'Prices: In {{CURRENCY}}, ex-works Ludhiana unless stated otherwise.',
    'Taxes: GST @ {{TAX_PCT}}% included as shown above.',
    'Validity: This offer is valid until {{VALID_UNTIL}}.',
    'Delivery & payment: As mutually agreed at the time of order.',
    '',
    'We look forward to your valued order.',
    '',
    'For {{COMPANY}}',
    '{{PREPARED_BY}}'
  ].join('\n');

  const docsApi = google.docs({ version: 'v1', auth: oauth2Client });
  await docsApi.documents.batchUpdate({
    documentId: starterId,
    requestBody: { requests: [{ insertText: { text: starterBody, location: { index: 1 } } }] }
  });
```

Then extend the existing settings write to persist both folder ids:

```ts
  await sql`
    insert into public.settings (key, value)
    values
      ('GOOGLE_DRIVE_QUOTATIONS_FOLDER_ID', ${folderId}),
      ('GOOGLE_DRIVE_TEMPLATES_FOLDER_ID', ${templatesFolderId})
    on conflict (key) do update set value = excluded.value
  `;
```

And update the success HTML body to mention both folders — change the first line to:

```ts
    `<!doctype html><html><body style="font-family:monospace;padding:24px;white-space:pre-wrap">Drive folders created and saved to settings:
  Quotations: AS CRM Quotations Testing (id: ${folderId})
  Templates:  AS CRM Templates Testing (id: ${templatesFolderId}) - seeded with "Quotation Template - Standard"
```

leaving the rest of that template literal (the env var line and the copy-it-now warning) exactly as-is.

- [ ] **Step 3: Verify**

Run: `npm run typecheck && npm run build`
Expected: both succeed; build output still lists `/api/admin/drive-setup/start` and `/api/admin/drive-setup/callback`.

- [ ] **Step 4: Commit**

```bash
git add src/app/api/admin/drive-setup/start/route.ts src/app/api/admin/drive-setup/callback/route.ts
git commit -m "feat(drive): request Docs scope and seed the templates folder during setup"
```

---

### Task 5: Hide the redundant Save-to-Drive button for Drive-hosted generated quotes

**Files:**
- Modify: `docs/source-appscript/Index.html`
- Modify: `src/app/crm/legacy-full.generated.ts` (script-based patch — generator must not run)
- Modify: `src/app/crm/legacy-app.test.ts`

**Interfaces:** none consumed or produced by other tasks — UI-only.

- [ ] **Step 1: Write the failing test**

In `src/app/crm/legacy-app.test.ts`, inside the existing top-level `describe('legacy CRM full client', ...)`, add a test modelled exactly on the existing "saving a quotation to Drive replaces the button with a working link" test (reuse its `mockRpc` shape and its `window.eval(saveButton.getAttribute('onclick') ?? '')` convention):

```ts
  test('hides Save to Drive for generated quotes already hosted in Drive', async () => {
    mockRpc((fn) => {
      if (fn === 'api_workspace') return workspace('L6');
      if (fn === 'api_getQuotation') {
        return {
          quote: {
            quoteNo: 'QTN-2026-0001',
            rev: 0,
            caseId: 'CASE-2026-0001',
            title: 'Panel upgrade quote',
            source: 'Generated',
            fileName: '',
            templateId: 'tpl-1',
            templateName: 'Standard',
            status: 'Draft',
            subtotal: 100,
            taxPct: 18,
            taxAmount: 18,
            total: 118,
            currency: 'INR',
            validUntil: '',
            notes: '',
            doc: 'https://drive.google.com/file/d/doc-1/view',
            pdf: 'https://drive.google.com/file/d/pdf-1/view',
            driveViewLink: '',
            by: 'Admin User',
            date: '2026-07-29'
          },
          customer: { id: 'CUST-2026-0001', name: 'Acme Controls' },
          blocks: [],
          revisions: [{ rev: 0, status: 'Draft', date: '2026-07-29', total: 118 }]
        };
      }
      throw new Error(`Unexpected RPC ${fn}`);
    });

    render(createElement(CrmApp));
    await screen.findByRole('heading', { name: 'Overview' });
    window.eval('mQuoteViewer("QTN-2026-0001", 0)');

    expect(await screen.findByRole('link', { name: 'Download document' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Save to Drive' })).not.toBeInTheDocument();
  });
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/app/crm/legacy-app.test.ts -t "hides Save to Drive"`
Expected: FAIL — the button is still rendered.

- [ ] **Step 3: Edit `Index.html`**

Find this exact expression inside `mQuoteViewer` (it currently occurs once, around line 1823):

```js
      (q.driveViewLink
        ? '<a class="btn ghost sm" href="'+esc(q.driveViewLink)+'" target="_blank" rel="noopener">View in Drive</a>'
        : '<button class="btn ghost sm" id="driveSaveBtn" onclick="saveQuoteToDrive(\''+esc(quoteNo)+'\','+rev+')">Save to Drive</button>')+
```

Replace it with:

```js
      (q.driveViewLink
        ? '<a class="btn ghost sm" href="'+esc(q.driveViewLink)+'" target="_blank" rel="noopener">View in Drive</a>'
        : (driveHosted(q) ? '' : '<button class="btn ghost sm" id="driveSaveBtn" onclick="saveQuoteToDrive(\''+esc(quoteNo)+'\','+rev+')">Save to Drive</button>'))+
```

Then insert this helper immediately before the line `function saveQuoteToDrive(quoteNo, rev){` (that line occurs exactly once):

```js
function driveHosted(q){
  // Generated quotes produced by the template pipeline already live in the
  // Drive quotations folder - doc/pdf ARE Drive links, so a separate
  // "Save to Drive" step would just duplicate the file. Older quotes whose
  // doc/pdf still point at the local download endpoint keep the button.
  var link = String((q && (q.doc || q.pdf)) || '');
  return q && q.source === 'Generated' && link.indexOf('drive.google.com') > -1;
}
```

- [ ] **Step 4: Patch the frozen generated artifact**

Write a throwaway Node script (run it, then delete it — do not commit it) that inserts at two anchors, each verified to occur exactly once. Do **not** hand-retype escaped text; insert only.

```js
// scratch-patch.mjs - run with: node scratch-patch.mjs, then delete this file
import fs from 'node:fs';

const path = 'src/app/crm/legacy-full.generated.ts';
const s = fs.readFileSync(path, 'utf8');

const buttonAnchor = "'<button class=\\\"btn ghost sm\\\" id=\\\"driveSaveBtn\\\"";
const fnAnchor = 'function saveQuoteToDrive(quoteNo, rev){';

for (const anchor of [buttonAnchor, fnAnchor]) {
  const count = s.split(anchor).length - 1;
  if (count !== 1) throw new Error(`Expected exactly 1 occurrence of ${JSON.stringify(anchor)}, found ${count}`);
}

// 1. Gate the existing button expression behind driveHosted(q).
const patched1 = s.replace(buttonAnchor, `(driveHosted(q) ? '' : ${buttonAnchor}`);

// 2. Close the ternary at the end of that same button expression. The button
//    string ends with the literal `Save to Drive</button>'` followed by `)`.
const buttonTail = "Save to Drive</button>')";
if (patched1.split(buttonTail).length - 1 !== 1) {
  throw new Error('Expected exactly 1 occurrence of the button tail');
}
const patched2 = patched1.replace(buttonTail, "Save to Drive</button>'))");

// 3. Insert the helper before saveQuoteToDrive.
const helper =
  'function driveHosted(q){\\n' +
  '  var link = String((q && (q.doc || q.pdf)) || \'\');\\n' +
  '  return q && q.source === \'Generated\' && link.indexOf(\'drive.google.com\') > -1;\\n' +
  '}\\n';

const patched3 = patched2.replace(fnAnchor, helper + fnAnchor);

fs.writeFileSync(path, patched3);
console.log('Patched. Bytes added:', patched3.length - s.length);
```

Then verify the artifact still parses and contains the helper exactly once:

```bash
node -e "const s=require('fs').readFileSync('src/app/crm/legacy-full.generated.ts','utf8');const m='export const legacyAppScript = \"';const a=s.indexOf(m)+m.length;const b=s.lastIndexOf('\";');const script=JSON.parse('\"'+s.slice(a,b)+'\"');new Function(script);console.log('syntax OK, driveHosted count:', script.split('function driveHosted').length-1)"
```

Expected: `syntax OK, driveHosted count: 1`. If it throws, STOP and report — do not hand-repair escaped text.

- [ ] **Step 5: Run tests**

Run: `npx vitest run src/app/crm/legacy-app.test.ts`
Expected: PASS — the new test plus every pre-existing one (notably the earlier "saving a quotation to Drive replaces the button with a working link" test, whose fixture has no `doc`/`pdf` Drive links and so must still show the button).

- [ ] **Step 6: Commit**

```bash
git add docs/source-appscript/Index.html src/app/crm/legacy-full.generated.ts src/app/crm/legacy-app.test.ts
git commit -m "feat(drive): hide redundant Save to Drive for Drive-hosted generated quotes"
```

---

### Task 6: List templates from the Drive folder

**Files:**
- Modify: `src/server/quotes/service.ts` (the `QuoteRepository` type + `listTemplates`)
- Modify: `src/server/quotes/repository.ts` (remove the settings-backed implementation)
- Modify: `src/server/quotes/rpc.ts`
- Modify: `src/server/quotes/service.test.ts`

**Interfaces:**
- Consumes: `DriveClient.listDocsInFolder` (Task 2), `getDriveTemplatesFolderId` (Task 2).
- Produces: `createQuoteService(repo, deps?)` gains an optional second parameter `{ listTemplates?: () => Promise<Array<{ id: string; name: string }>> }`, consumed by Task 7's wiring in `rpc.ts`.

- [ ] **Step 1: Write the failing test**

In `src/server/quotes/service.test.ts`, add:

```ts
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
```

Ensure `vi` is imported in that file (add it to the existing `vitest` import if absent).

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/server/quotes/service.test.ts -t "lists templates from the injected"`
Expected: FAIL — `createQuoteService` takes one argument.

- [ ] **Step 3: Implement**

In `src/server/quotes/service.ts`:

1. Remove `listTemplates(): Promise<Array<{ id: string; name: string }>>;` from the `QuoteRepository` type (Drive, not Postgres, is the source now).
2. Add above `createQuoteService`:

```ts
export type QuoteServiceDeps = {
  listTemplates?: () => Promise<Array<{ id: string; name: string }>>;
};
```

3. Change the signature to `export function createQuoteService(repo: QuoteRepository, deps: QuoteServiceDeps = {})`.
4. Add a local helper just inside it:

```ts
  async function loadTemplates(): Promise<Array<{ id: string; name: string }>> {
    if (!deps.listTemplates) return [];
    return deps.listTemplates();
  }
```

5. Replace the body of `listTemplates` with:

```ts
    async listTemplates(_user: CrmContext) {
      return (await loadTemplates()).sort((a, b) => a.name.localeCompare(b.name));
    },
```

6. In `createQuotation`, replace `const templates = await repo.listTemplates();` with `const templates = await loadTemplates();` (the surrounding `templateName` lookup is unchanged).

In `src/server/quotes/repository.ts`: delete the whole `listTemplates()` method (its `QUOTE_TEMPLATES` settings read is now dead code).

In `src/server/quotes/service.test.ts`: delete `FakeQuoteRepository`'s `listTemplates` method (it no longer implements part of the interface).

- [ ] **Step 4: Wire the real source in `rpc.ts`**

In `src/server/quotes/rpc.ts`, add imports and pass the dependency — note `createDriveClient` stays a **lazy call inside the closure**, never invoked at module scope:

```ts
import { getDriveTemplatesFolderId } from '../drive/template-folder';
```

and change the service construction to:

```ts
const service = createQuoteService(quoteRepository, {
  listTemplates: async () => {
    const folderId = await getDriveTemplatesFolderId();
    return createDriveClient().listDocsInFolder(folderId);
  }
});
```

(`createDriveClient` is already imported in this file for the Drive service.)

- [ ] **Step 5: Run tests**

Run: `npm run typecheck && npm run test`
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add src/server/quotes/service.ts src/server/quotes/repository.ts src/server/quotes/rpc.ts src/server/quotes/service.test.ts
git commit -m "feat(quotes): list quotation templates from the Drive templates folder"
```

---

### Task 7: Real `generateQuoteDoc` — copy, merge, tables, PDF export

**Files:**
- Modify: `src/server/quotes/service.ts`
- Modify: `src/server/quotes/repository.ts` (add `listContacts`)
- Modify: `src/server/quotes/rpc.ts`
- Modify: `src/server/quotes/service.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 1, 2, 3, 6.
- Produces: `generateQuoteDoc` returning `{ doc: { url }, pdf: { url } }` with real Drive links; `QuoteRepository.listContacts`.

- [ ] **Step 1: Write the failing test**

Three preparatory edits to `src/server/quotes/service.test.ts` first:

1. Add `contacts: Array<{ name: string; designation: string }> = [];` as a field on `FakeQuoteRepository`, plus `async listContacts(): Promise<Array<{ name: string; designation: string }>> { return this.contacts; }`.
2. Change the existing `makeService()` helper to accept and forward deps — every existing call site keeps working unchanged:
   ```ts
   function makeService(deps: QuoteServiceDeps = {}) {
     // ...unchanged body...
     return { repo, service: createQuoteService(repo, deps) };
   }
   ```
   (import `type QuoteServiceDeps` from `./service` alongside the existing imports).
3. Add `vi` to the existing `vitest` import.

Then add a `describe('generateQuoteDoc', ...)` block. Note the fixtures already in this file: `customer()` is `CUST-0001` / "Alpha Panels" / address "Industrial Area" / area "Ludhiana", and `makeQuote()` is `QTN-2026-0001` R0 with `templateId: 'tpl-standard'`, subtotal 1000, taxPct 18, taxAmount 180, total 1180, currency INR — so the expected merged address is `"Industrial Area, Ludhiana"` and the expected copy name is `"QTN-2026-0001-R0 - Alpha Panels"`.

```ts
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
      shareDomainReadable: vi.fn().mockResolvedValue(undefined)
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
    const { repo, service } = makeService();
    seedGenerated(repo);

    await expect(service.generateQuoteDoc(sales, 'QTN-2026-0001', 0)).rejects.toThrow('not configured');
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/server/quotes/service.test.ts -t "generateQuoteDoc"`
Expected: FAIL.

- [ ] **Step 3: Add `listContacts` to the repository**

In `src/server/quotes/service.ts`, add to the `QuoteRepository` type:

```ts
  listContacts(customerId: string): Promise<Array<{ name: string; designation: string }>>;
```

In `src/server/quotes/repository.ts`, add the implementation (mirrors the customers repository's existing contact query):

```ts
  async listContacts(customerId: string): Promise<Array<{ name: string; designation: string }>> {
    const rows = (await this.db`
      select name, designation
      from public.contacts
      where customer_id = ${customerId}
      order by name asc
    `) as Array<{ name: string; designation: string | null }>;

    return rows.map((row) => ({ name: row.name, designation: row.designation ?? '' }));
  }
```

- [ ] **Step 4: Extend `QuoteServiceDeps` and implement `generateQuoteDoc`**

In `src/server/quotes/service.ts`, extend the deps type added in Task 6:

```ts
export type QuoteServiceDeps = {
  listTemplates?: () => Promise<Array<{ id: string; name: string }>>;
  getDriveClient?: () => DriveClient;
  getDocsClient?: () => DocsClient;
  getQuotationsFolderId?: () => Promise<string>;
};
```

with these imports at the top of the file:

```ts
import type { DriveClient } from '../drive/client';
import type { DocsClient } from '../drive/docs';
import {
  buildCellFillRequests,
  buildMergeFieldRequests,
  buildStructureRequests,
  collectTables,
  locateMarker
} from '../drive/template-merge';
```

Add a money formatter next to the existing helpers (matches legacy `fmtMoney_`):

```ts
function fmtMoney(value: number | ''): string {
  return Number(value || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
```

Replace the whole body of `generateQuoteDoc` with:

```ts
    async generateQuoteDoc(user: CrmContext, quoteNo: string, rev: number) {
      const { quote, customer } = await loadQuote(repo, user, quoteNo, rev);
      if (quote.source === 'External') {
        throw new Error('This quotation was uploaded as an external file - there is no template to generate from.');
      }
      if (!quote.templateId) throw new Error('This quotation has no template selected. Create a revision and pick a template.');
      if (!deps.getDriveClient || !deps.getDocsClient || !deps.getQuotationsFolderId) {
        throw new Error('Google Drive is not configured. Run the one-time Drive setup first.');
      }

      const [blocks, contacts, users] = await Promise.all([
        repo.listBoqBlocks(quoteNo, rev),
        repo.listContacts(quote.customerId),
        repo.listUsers()
      ]);
      const idx = userIndex(users);
      const contact = contacts[0];
      const baseName = `${quoteNo}-R${rev} - ${customer.name}`;

      const drive = deps.getDriveClient();
      const docsClient = deps.getDocsClient();
      const folderId = await deps.getQuotationsFolderId();

      // 1. Copy the template into the quotations folder.
      const copy = await drive.copyFile(quote.templateId, baseName, folderId);

      // 2. Merge every scalar placeholder (matches legacy Code.gs:1808-1826).
      await docsClient.batchUpdate(
        copy.id,
        buildMergeFieldRequests({
          '{{QUOTE_NO}}': quote.quoteNo,
          '{{REV}}': `R${quote.rev}`,
          '{{DATE}}': today(),
          '{{CUSTOMER_NAME}}': customer.name,
          '{{CUSTOMER_ADDRESS}}': [customer.address, customer.area].filter((part) => part.trim()).join(', '),
          '{{CONTACT_NAME}}': contact ? `${contact.name}${contact.designation ? ` (${contact.designation})` : ''}` : '-',
          '{{TITLE}}': quote.title,
          '{{VALID_UNTIL}}': quote.validUntil || '30 days from date of offer',
          '{{NOTES}}': quote.notes || '-',
          '{{TAX_PCT}}': String(quote.taxPct),
          '{{SUBTOTAL}}': fmtMoney(quote.subtotal),
          '{{TAX_AMOUNT}}': fmtMoney(quote.taxAmount),
          '{{TOTAL}}': fmtMoney(quote.total),
          '{{CURRENCY}}': quote.currency,
          '{{COMPANY}}': DEFAULT_SETTINGS.COMPANY,
          '{{PREPARED_BY}}': `${nameOf(idx, quote.createdBy)} (${normalizeEmail(quote.createdBy)})`
        })
      );

      // 3. Locate the structural marker and insert the BOQ + totals tables.
      const marker = locateMarker(await docsClient.getDocument(copy.id), '{{BOQ_TABLE}}');
      if (!marker) {
        throw new Error('This template has no {{BOQ_TABLE}} placeholder - add one where the BOQ should appear.');
      }

      const totals = {
        currency: quote.currency,
        subtotal: fmtMoney(quote.subtotal),
        taxPct: String(quote.taxPct),
        taxAmount: fmtMoney(quote.taxAmount),
        total: fmtMoney(quote.total)
      };
      await docsClient.batchUpdate(copy.id, buildStructureRequests(marker, blocks, totals));

      // 4. Re-read the document for the new tables' real cell indices, then
      //    fill them. Table order matches insertion order: BOQ blocks, totals.
      const tables = collectTables(await docsClient.getDocument(copy.id));
      const tableValues = [
        ...blocks.map((block) => [...block.headers, ...block.rows.flat()]),
        [
          'Subtotal',
          `${totals.currency} ${totals.subtotal}`,
          `GST @ ${totals.taxPct}%`,
          `${totals.currency} ${totals.taxAmount}`,
          'Total',
          `${totals.currency} ${totals.total}`
        ]
      ];
      await docsClient.batchUpdate(copy.id, buildCellFillRequests(tables, tableValues));

      // 5. Export to PDF via Drive's native conversion and store it alongside.
      const pdfBytes = await drive.exportPdf(copy.id);
      const pdf = await drive.uploadFile(
        { fileName: `${baseName}.pdf`, mimeType: 'application/pdf', body: pdfBytes },
        folderId
      );

      await drive.shareDomainReadable(copy.id);

      await repo.updateQuote(quote.quoteNo, quote.rev, {
        doc: copy.webViewLink,
        pdf: pdf.webViewLink,
        updatedAt: nowIso()
      });
      await repo.logActivity({
        action: 'QUOTE_PDF',
        entity: `${quoteNo} R${rev}`,
        customerId: quote.customerId,
        details: baseName,
        who: normalizeEmail(user.email)
      });

      return { doc: { url: copy.webViewLink }, pdf: { url: pdf.webViewLink } };
    },
```

(`uploadFile` already applies domain sharing to the PDF it creates, so only the Doc copy needs the explicit `shareDomainReadable` call.)

- [ ] **Step 4b: Make the generation errors user-visible**

`normalizeRpcError` collapses any message not matching `USER_FACING_PATTERNS` into a generic 500 "Something went wrong." None of `generateQuoteDoc`'s guard messages match today (this is a pre-existing gap for the two older guards, and would be a new one for the placeholder guard) — so every one of them would reach the user as an opaque 500. In `src/server/rpc/errors.ts`, extend the array:

```ts
  /denied/i,
  /not configured/i,
  /template/i,
  /placeholder/i,
  /external file/i
];
```

All three new patterns fall through to the default `bad_request` (400) branch, matching how `/invalid/i` and `/required/i` already behave. Add a covering test to `src/server/rpc/errors.test.ts` if that file exists; if it does not, add these assertions to the existing `describe` in `src/server/rpc/registry.test.ts`:

```ts
  it('surfaces quotation-generation guard messages instead of a generic 500', () => {
    for (const message of [
      'This quotation has no template selected. Create a revision and pick a template.',
      'This template has no {{BOQ_TABLE}} placeholder - add one where the BOQ should appear.',
      'This quotation was uploaded as an external file - there is no template to generate from.'
    ]) {
      const rpcError = normalizeRpcError(new Error(message));
      expect(rpcError.status).toBe(400);
      expect(rpcError.message).toBe(message);
    }
  });
```

(import `normalizeRpcError` from `./errors` in that file if it is not already imported).

- [ ] **Step 5: Wire the real clients in `rpc.ts`**

In `src/server/quotes/rpc.ts`, add `import { createDocsClient } from '../drive/docs';` and `import { getDriveFolderId } from '../drive/folder';`, then extend the service construction (keeping every factory lazy):

```ts
const service = createQuoteService(quoteRepository, {
  listTemplates: async () => {
    const folderId = await getDriveTemplatesFolderId();
    return createDriveClient().listDocsInFolder(folderId);
  },
  getDriveClient: createDriveClient,
  getDocsClient: createDocsClient,
  getQuotationsFolderId: getDriveFolderId
});
```

- [ ] **Step 6: Run tests**

Run: `npm run typecheck && npm run test`
Expected: all pass.

- [ ] **Step 7: Commit**

```bash
git add src/server/quotes/service.ts src/server/quotes/repository.ts src/server/quotes/rpc.ts src/server/quotes/service.test.ts
git commit -m "feat(quotes): generate real Google Doc + PDF from templates via the Docs API"
```

---

### Task 8: E2E coverage

**Files:**
- Modify: `tests/e2e/crm-smoke.spec.ts`

**Interfaces:** consumes the existing `setUpAuthenticatedSession` helper and `rpcData` fallback pattern already in this file.

- [ ] **Step 1: Write the test**

```ts
test('generating a quotation surfaces real Drive document links and hides Save to Drive', async ({ context, page }) => {
  test.skip(
    !isFakeSupabaseConfigured(),
    `Set NEXT_PUBLIC_SUPABASE_URL=${fakeSupabaseUrl} and NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY to a dummy value to run the mocked-auth shell smoke test.`
  );

  let generated = false;
  await setUpAuthenticatedSession(context, page);
  await page.route('**/api/rpc', async (route) => {
    const body = route.request().postDataJSON() as { fn: string };
    if (body.fn === 'api_generateQuoteDoc') {
      generated = true;
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          ok: true,
          data: {
            doc: { url: 'https://drive.google.com/file/d/doc-1/view' },
            pdf: { url: 'https://drive.google.com/file/d/pdf-1/view' }
          }
        })
      });
      return;
    }
    if (body.fn === 'api_getQuotation') {
      const base = rpcData('api_getQuotation') as { quote: Record<string, unknown> };
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          ok: true,
          data: {
            ...base,
            quote: {
              ...base.quote,
              status: 'Draft',
              driveViewLink: '',
              doc: generated ? 'https://drive.google.com/file/d/doc-1/view' : '',
              pdf: generated ? 'https://drive.google.com/file/d/pdf-1/view' : ''
            }
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

  await page.getByRole('button', { name: /Generate download/ }).click();

  await expect(page.getByRole('link', { name: 'Download document' })).toHaveAttribute(
    'href',
    'https://drive.google.com/file/d/doc-1/view'
  );
  await expect(page.getByRole('link', { name: 'Download PDF' })).toHaveAttribute(
    'href',
    'https://drive.google.com/file/d/pdf-1/view'
  );
  await expect(page.getByRole('button', { name: 'Save to Drive' })).toHaveCount(0);
});
```

- [ ] **Step 2: Run it**

```powershell
$env:NEXT_PUBLIC_SUPABASE_URL='http://127.0.0.1:3999'
$env:NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY='dummy-anon-key'
npx playwright test crm-smoke -g "generating a quotation" --workers=1
```
Expected: PASS.

- [ ] **Step 3: Run the whole e2e suite**

Run (same env): `npx playwright test --workers=1`
Expected: all pass.

- [ ] **Step 4: Commit**

```bash
git add tests/e2e/crm-smoke.spec.ts
git commit -m "test(quotes): e2e coverage for Drive-hosted generated quotation links"
```

---

### Task 9: Documentation and final verification

**Files:**
- Modify: `CONTEXT.md`

- [ ] **Step 1: Update `CONTEXT.md`**

Add a dated entry under "Current Production Status" in the same style as the existing entries, covering: the new `template-merge.ts`/`docs.ts`/`template-folder.ts` modules and the pure-function split; `listTemplates` now reading live from the `AS CRM Templates Testing` Drive folder (settings key `GOOGLE_DRIVE_TEMPLATES_FOLDER_ID`) instead of the removed `QUOTE_TEMPLATES` settings row; `generateQuoteDoc` now producing a real Doc + real PDF in the Quotations folder; the four Docs API index rules from this plan's Global Constraints (they are the non-obvious knowledge a future maintainer needs); and that "Save to Drive" is now hidden for Drive-hosted generated quotes but unchanged for uploaded ones.

Under "Pending/manual", add: **the OAuth refresh token must be regenerated** — the Docs scope is new, existing tokens lack it. The project owner must delete `GOOGLE_DRIVE_REFRESH_TOKEN` from Vercel, redeploy, visit `/api/admin/drive-setup/start` as an L6 admin, approve as `testing@automationsystems.org`, then set the new token and redeploy. Note that this also recreates the folders and reseeds the starter template.

- [ ] **Step 2: Full verification**

Run: `npm run typecheck && npm run test && npm run build`
Expected: all green.

- [ ] **Step 3: Commit**

```bash
git add CONTEXT.md
git commit -m "docs: record the legacy quotation template revival"
```
