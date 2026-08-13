# Drive-First Quotation Upload Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make uploaded quotation files go straight to Google Drive instead of being stored as `bytea` inside the Postgres `quotations` row.

**Architecture:** The Drive filename needs `quoteNo` and `rev`, which are allocated *inside* the database transaction. Rather than hold a transaction open across a slow Google API call, we upload the file to Drive first under a provisional name, run the existing transaction unmodified (writing the Drive ids, leaving the blob column empty), then rename the Drive file after commit. Drive failure aborts before any database write; transaction failure triggers a best-effort Drive cleanup; rename failure is cosmetic and never fails the request.

**Tech Stack:** TypeScript, Next.js 15 App Router, `postgres.js`, `googleapis` (Drive v3), vitest, Playwright.

## Global Constraints

- **Design spec:** `docs/superpowers/specs/2026-08-13-quotation-drive-first-upload-design.md`. Read it before starting.
- **No database migration.** `drive_file_id`, `drive_view_link`, `drive_saved_at`, `drive_saved_by` already exist (migration `0004`). Do not write a new migration.
- **Do not drop or stop reading `quotations.upload_data`.** This phase only stops *writing* it. Removing the column is a separate later phase.
- **TDD is mandatory.** Every code change is preceded by a test that is *run and seen to fail* first.
- **Baseline that must not regress: 240 vitest tests and 21 Playwright tests currently pass.** Any reduction stops the work.
- **Never contact the real Google API from a test.** Drive is mocked at the service boundary, matching `src/server/drive/service.test.ts` and `src/server/drive/client.test.ts`.
- **Do not touch:** the transaction body's allocation logic (`allocateQuoteRevision`, `supersedePrevious`, `createAutoCase`), generated-quotation rendering, `src/server/cases/`, `src/server/customers/`, `src/server/dashboard/`, or any existing migration.
- **Never commit secrets.** No database URL, refresh token, or client secret in any file or commit message.
- Run commands from the repo root: `D:\AutomationSystems\CRM\migrated-crm`.

---

## File Structure

| File | Responsibility | Change |
|---|---|---|
| `src/server/drive/client.ts` | Raw Drive v3 wrapper | **Modify** — add `renameFile` and `deleteFile` to the `DriveClient` type and implementation |
| `src/server/drive/client.test.ts` | Unit tests for the wrapper | **Modify** — cover the two new methods |
| `src/server/quotes/service.ts` | Quote business logic | **Modify** — `uploadQuotation` sequencing; `externalArtifact` error |
| `src/server/quotes/service.test.ts` | Unit tests for quote logic | **Modify** — upload success and all four failure branches |
| `src/server/drive/service.ts` | Manual "Save to Drive" action | **Modify** — guard against uploading the placeholder stub |
| `src/server/drive/service.test.ts` | Unit tests for that action | **Modify** — cover the guard |
| `src/app/crm/legacy-app.test.ts` | Client-side viewer tests | **Modify** — assert the viewer renders "View in Drive" and no download button |
| `tests/e2e/crm-smoke.spec.ts` | Browser smoke tests | **Not changed** — run unmodified as a regression gate (Task 6 explains why) |

`docs/source-appscript/Index.html` is expected to need **no change** (Task 5 verifies this rather than assuming it).

---

### Task 1: Add `renameFile` and `deleteFile` to the Drive client

The Drive client currently exposes `uploadFile`, `listDocsInFolder`, `copyFile`, `exportPdf`, `shareDomainReadable`. The new upload flow needs two more primitives: rename (step 3 of the sequence) and delete (orphan cleanup).

**Files:**
- Modify: `src/server/drive/client.ts` (the `DriveClient` type at lines 9-15, and the returned object)
- Test: `src/server/drive/client.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: two new methods on the exported `DriveClient` type, used by Tasks 3 and 4:
  ```ts
  renameFile(fileId: string, name: string): Promise<void>;
  deleteFile(fileId: string): Promise<void>;
  ```

- [ ] **Step 1: Write the failing tests**

Add these two tests inside the existing `describe('createDriveClient', ...)` block in `src/server/drive/client.test.ts`, just before the final closing `});`:

```ts
  it('renames a file', async () => {
    filesUpdate.mockResolvedValue({ data: { id: 'file-123' } });

    const { createDriveClient } = await import('./client');
    await createDriveClient().renameFile('file-123', 'QTN-2026-0001 R0 - Acme Controls - offer.pdf');

    expect(filesUpdate).toHaveBeenCalledWith({
      fileId: 'file-123',
      requestBody: { name: 'QTN-2026-0001 R0 - Acme Controls - offer.pdf' }
    });
  });

  it('deletes a file', async () => {
    filesDelete.mockResolvedValue({ data: {} });

    const { createDriveClient } = await import('./client');
    await createDriveClient().deleteFile('file-123');

    expect(filesDelete).toHaveBeenCalledWith({ fileId: 'file-123' });
  });
```

These need two new mock functions. At the top of the file, next to the existing `const filesCreate = vi.fn();` declarations, add:

```ts
const filesUpdate = vi.fn();
const filesDelete = vi.fn();
```

Register them on the mocked Drive object — change the existing `files:` line inside `vi.mock('googleapis', ...)` to:

```ts
      files: {
        create: filesCreate,
        list: filesList,
        copy: filesCopy,
        export: filesExport,
        update: filesUpdate,
        delete: filesDelete
      },
```

And reset them in `beforeEach`, next to the existing resets:

```ts
    filesUpdate.mockReset();
    filesDelete.mockReset();
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/server/drive/client.test.ts`
Expected: FAIL. Both new tests error with something like `client.renameFile is not a function` / `client.deleteFile is not a function`.

- [ ] **Step 3: Write the minimal implementation**

In `src/server/drive/client.ts`, add the two signatures to the `DriveClient` type:

```ts
export type DriveClient = {
  uploadFile(input: DriveFileUpload, folderId: string): Promise<{ id: string; webViewLink: string }>;
  listDocsInFolder(folderId: string): Promise<Array<{ id: string; name: string }>>;
  copyFile(fileId: string, name: string, folderId: string): Promise<{ id: string; webViewLink: string }>;
  exportPdf(fileId: string): Promise<Buffer>;
  shareDomainReadable(fileId: string): Promise<void>;
  renameFile(fileId: string, name: string): Promise<void>;
  deleteFile(fileId: string): Promise<void>;
};
```

Then add the two implementations to the returned object, after `shareDomainReadable`:

```ts
    async renameFile(fileId: string, name: string) {
      const drive = await driveApi();
      await drive.files.update({ fileId, requestBody: { name } });
    },

    async deleteFile(fileId: string) {
      const drive = await driveApi();
      await drive.files.delete({ fileId });
    },
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/server/drive/client.test.ts`
Expected: PASS, all tests in the file.

- [ ] **Step 5: Commit**

```bash
git add src/server/drive/client.ts src/server/drive/client.test.ts
git commit -m "feat(drive): add renameFile and deleteFile to the Drive client

The Drive-first upload flow uploads under a provisional name and renames
after the transaction commits, and deletes the file if the transaction
rolls back. Neither primitive existed yet."
```

---

### Task 2: Make the quote service accept a Drive uploader

`uploadQuotation` currently has no way to reach Drive. `createQuoteService` already takes a `deps` object carrying `getDriveClient` and `getQuotationsFolderId` (used by `generateQuoteDoc`), and `src/server/quotes/rpc.ts` already wires both in. This task adds no new wiring — it only confirms, with a test, that `uploadQuotation` fails clearly when Drive is not configured, which is the precondition for Task 3.

**Files:**
- Modify: `src/server/quotes/service.ts` (`uploadQuotation`, which begins around line 537)
- Test: `src/server/quotes/service.test.ts`

**Interfaces:**
- Consumes: the existing `QuoteServiceDeps` type from `src/server/quotes/service.ts`:
  ```ts
  export type QuoteServiceDeps = {
    listTemplates?: () => Promise<Array<{ id: string; name: string }>>;
    getDriveClient?: () => DriveClient;
    getDocsClient?: () => DocsClient;
    getQuotationsFolderId?: () => Promise<string>;
  };
  ```
- Produces: `uploadQuotation` now throws when `deps.getDriveClient` or `deps.getQuotationsFolderId` is absent. Tasks 3 and 4 rely on both being present.

- [ ] **Step 1: Write the failing test**

Add to `src/server/quotes/service.test.ts`, inside the same `describe` block that holds the other `uploadQuotation` tests:

```ts
  it('refuses to upload a quotation when Drive is not configured', async () => {
    const repo = new FakeQuoteRepository();
    seedCustomerAndCase(repo);
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
```

`seedCustomerAndCase(repo)` is whatever helper the neighbouring `uploadQuotation` tests already use to populate `repo.customers` / `repo.cases` / `repo.handlers`. Read the existing tests around line 351 of that file and reuse the identical setup — do not invent a new one.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/server/quotes/service.test.ts -t "Drive is not configured"`
Expected: FAIL. The upload currently succeeds, so `rejects.toThrow` fails with something like "promise resolved instead of rejecting".

- [ ] **Step 3: Write the minimal implementation**

In `src/server/quotes/service.ts`, inside `uploadQuotation`, immediately after the existing size check:

```ts
      if (dataB64.length > 11_000_000) throw new Error('That file is too large - please keep uploads under about 8 MB.');
```

add:

```ts
      if (!deps.getDriveClient || !deps.getQuotationsFolderId) {
        throw new Error('Google Drive is not configured. Run the one-time Drive setup first.');
      }
```

That wording matches the message `generateQuoteDoc` already uses for the same condition — keep it identical so users see one consistent message.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/server/quotes/service.test.ts`
Expected: PASS, every test in the file.

- [ ] **Step 5: Commit**

```bash
git add src/server/quotes/service.ts src/server/quotes/service.test.ts
git commit -m "feat(quotes): require Drive configuration before accepting an upload

Precondition for storing uploaded quotations in Drive rather than in the
database. Matches the message generateQuoteDoc already uses."
```

---

### Task 3: Upload to Drive before the transaction; stop writing the blob

The core change. Replaces the body of `uploadQuotation`'s storage step.

**Files:**
- Modify: `src/server/quotes/service.ts` (`uploadQuotation`)
- Test: `src/server/quotes/service.test.ts`

**Interfaces:**
- Consumes: `renameFile` / `deleteFile` from Task 1; the Drive guard from Task 2.
- Produces: after this task, a successful upload writes a quote row with `uploadDataB64: ''`, `pdf: ''`, and populated `driveFileId` / `driveViewLink` / `driveSavedAt` / `driveSavedBy`. Task 5 and Task 6 depend on that row shape.

- [ ] **Step 1: Write the failing tests**

Add to `src/server/quotes/service.test.ts`. Define a small Drive stub near the other test helpers:

```ts
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
        async uploadFile(input, folderId) {
          calls.uploaded.push({ fileName: input.fileName, folderId, body: input.body });
          if (overrides.upload) return overrides.upload(input, folderId);
          return { id: 'drive-file-1', webViewLink: 'https://drive.google.com/file/d/drive-file-1/view' };
        },
        async renameFile(fileId, name) {
          calls.renamed.push({ fileId, name });
          if (overrides.rename) return overrides.rename(fileId, name);
        },
        async deleteFile(fileId) {
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
```

Then the five behaviour tests:

```ts
  it('stores an uploaded quotation in Drive and not in the database', async () => {
    const repo = new FakeQuoteRepository();
    seedCustomerAndCase(repo);
    const { deps, calls } = fakeDriveDeps();
    const service = createQuoteService(repo, deps);

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
    expect(calls.uploaded[0].fileName).toBe('Acme Controls - vendor-offer.pdf');
  });

  it('renames the Drive file to the full convention after the transaction commits', async () => {
    const repo = new FakeQuoteRepository();
    seedCustomerAndCase(repo);
    const { deps, calls } = fakeDriveDeps();
    const service = createQuoteService(repo, deps);

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
      { fileId: 'drive-file-1', name: `${result.quoteNo} R${result.rev} - Acme Controls - vendor-offer.pdf` }
    ]);
  });

  it('writes nothing to the database when the Drive upload fails', async () => {
    const repo = new FakeQuoteRepository();
    seedCustomerAndCase(repo);
    const { deps } = fakeDriveDeps({
      upload: async () => {
        throw new Error('Drive quota exceeded.');
      }
    });
    const service = createQuoteService(repo, deps);

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
    const repo = new FakeQuoteRepository();
    seedCustomerAndCase(repo);
    const { deps, calls } = fakeDriveDeps();
    const service = createQuoteService(repo, deps);
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
    const repo = new FakeQuoteRepository();
    seedCustomerAndCase(repo);
    const { deps } = fakeDriveDeps({
      remove: async () => {
        throw new Error('drive delete failed');
      }
    });
    const service = createQuoteService(repo, deps);
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
    const repo = new FakeQuoteRepository();
    seedCustomerAndCase(repo);
    const { deps } = fakeDriveDeps({
      rename: async () => {
        throw new Error('drive rename failed');
      }
    });
    const service = createQuoteService(repo, deps);

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
```

Note: `'Acme Controls'` must match whatever customer name `seedCustomerAndCase` actually sets. Read the existing helper and use its real value in all six tests.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/server/quotes/service.test.ts`
Expected: FAIL. The new tests fail because the upload still writes `uploadDataB64` and never calls Drive.

- [ ] **Step 3: Write the minimal implementation**

In `src/server/quotes/service.ts`, inside `uploadQuotation`:

First, after the Drive guard added in Task 2 and after `fileName` / `uploadMimeType` are computed, upload to Drive **before** `return repo.withTransaction(...)`:

```ts
      const folderId = await deps.getQuotationsFolderId();
      const drive = deps.getDriveClient();
      const uploaded = await drive.uploadFile(
        {
          fileName: `${customer.name} - ${fileName}`,
          mimeType: uploadMimeType,
          body: Buffer.from(dataB64, 'base64')
        },
        folderId
      );
```

Then wrap the existing transaction so a rollback cleans up the orphan. Replace `return repo.withTransaction(async (tx) => {` with:

```ts
      let committed: { quoteNo: string; rev: number; caseId: string };
      try {
        committed = await repo.withTransaction(async (tx) => {
```

and at the end of the transaction callback, keep the existing `return { quoteNo: allocation.quoteNo, rev: allocation.rev, caseId };` then close with:

```ts
        });
      } catch (error) {
        // The database rolled back, so the Drive file is now unreferenced.
        // Best effort only: if this delete also fails we still surface the
        // original database error, because that is the one the user needs.
        try {
          await drive.deleteFile(uploaded.id);
        } catch {
          // Leaves one orphan file in the folder. No data loss, no database
          // impact. Identifiable by its missing "<quoteNo> R<rev>" prefix.
        }
        throw error;
      }

      // Cosmetic only - the row and the link are already correct, so a rename
      // failure must not fail an otherwise complete upload.
      try {
        await drive.renameFile(
          uploaded.id,
          `${committed.quoteNo} R${committed.rev} - ${customer.name} - ${fileName}`
        );
      } catch {
        // Intentionally ignored.
      }

      return committed;
```

Finally, change the row written by `createQuote` so it stores the Drive ids and no blob. Replace these lines:

```ts
          uploadDataB64: dataB64,
```
with:
```ts
          uploadDataB64: '',
```

and replace:
```ts
          pdf: downloadUrl,
          driveFileId: '',
          driveViewLink: '',
          driveSavedAt: '',
          driveSavedBy: '',
```
with:
```ts
          pdf: '',
          driveFileId: uploaded.id,
          driveViewLink: uploaded.webViewLink,
          driveSavedAt: now,
          driveSavedBy: normalizeEmail(user.email),
```

The `downloadUrl` local is now unused — delete its declaration (`const downloadUrl = quoteDownloadUrl(allocation.quoteNo, allocation.rev, '');`). If `quoteDownloadUrl` has no other caller in the file, leave the import in place only if it is still used elsewhere; otherwise remove it so `typecheck` stays clean.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/server/quotes/service.test.ts`
Expected: PASS, every test in the file.

Then run the whole suite: `npm test`
Expected: PASS. Some pre-existing upload tests may assert on `uploadDataB64` or the old `pdf` download URL. If one fails, read it: it is asserting the *old* intended behaviour and should be updated to the new expectation. Do not weaken an assertion that is testing something unrelated.

- [ ] **Step 5: Commit**

```bash
git add src/server/quotes/service.ts src/server/quotes/service.test.ts
git commit -m "feat(quotes): store uploaded quotations in Drive, not in the database

Uploads the file to Drive under a provisional name before opening the
transaction, so no transaction is ever held open across a Google API call.
The existing transaction is unchanged apart from the row it writes. After
commit the file is renamed to the full convention.

Drive failure means nothing is written to the database at all. A rolled
back transaction triggers a best-effort delete of the orphaned Drive file,
and if that delete also fails the original database error is still what
surfaces. A failed rename is cosmetic and does not fail the request."
```

---

### Task 4: Stop serving a placeholder stub for Drive-hosted uploads

`externalArtifact` returns a fabricated HTML stub when a quote has no stored bytes. Every new upload now has no stored bytes, so that stub would be served for all of them — and `saveQuotationToDrive` would happily upload the stub to Drive.

**Files:**
- Modify: `src/server/quotes/service.ts` (`externalArtifact`, around line 422)
- Modify: `src/server/drive/service.ts` (`saveQuotationToDrive`, around line 34)
- Test: `src/server/quotes/service.test.ts`, `src/server/drive/service.test.ts`

**Interfaces:**
- Consumes: the row shape produced by Task 3 (`uploadDataB64 === ''`, `driveViewLink` populated).
- Produces: no new exports. `getDownloadArtifact` now throws for a blob-less External quote.

- [ ] **Step 1: Write the failing tests**

In `src/server/quotes/service.test.ts`:

```ts
  it('refuses to build a download artifact for a Drive-hosted upload', async () => {
    const repo = new FakeQuoteRepository();
    seedCustomerAndCase(repo);
    const { deps } = fakeDriveDeps();
    const service = createQuoteService(repo, deps);

    const result = await service.uploadQuotation(sales, {
      customerId: 'CUST-0001',
      caseId: 'CASE-2026-0001',
      title: 'Vendor offer',
      fileName: 'vendor-offer.pdf',
      dataB64: Buffer.from('x').toString('base64'),
      total: 100,
      status: 'Sent'
    });

    await expect(service.getDownloadArtifact(sales, result.quoteNo, result.rev)).rejects.toThrow(
      /stored in Google Drive/
    );
  });
```

In `src/server/drive/service.test.ts`, following the setup style already used in that file:

```ts
  it('refuses to save an already Drive-hosted upload back to Drive', async () => {
    // Build the service exactly as the existing tests in this file do, with a
    // quote whose source is 'External', uploadDataB64 is '' and driveFileId is
    // already set.
    await expect(driveService.saveQuotationToDrive(sales, 'QTN-2026-0001', 0)).rejects.toThrow(
      /already stored in Google Drive/
    );
  });
```

Read the existing tests in `src/server/drive/service.test.ts` and construct `driveService` and the stored quote with the same fixtures they use. Do not introduce a second, parallel fixture style.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/server/quotes/service.test.ts src/server/drive/service.test.ts`
Expected: FAIL. Both currently resolve rather than reject — the first returns the HTML stub, the second uploads it.

- [ ] **Step 3: Write the minimal implementation**

In `src/server/quotes/service.ts`, replace the fallback branch of `externalArtifact`:

```ts
function externalArtifact(quote: QuoteRow, customer: QuoteCustomerRow): QuoteDownloadArtifact {
  if (quote.uploadDataB64) {
    return {
      fileName: cleanUploadFileName(quote.fileName),
      mimeType: cleanMimeType(quote.uploadMimeType),
      body: Buffer.from(quote.uploadDataB64, 'base64')
    };
  }

  throw new Error('This quotation is stored in Google Drive - use the "View in Drive" link to open it.');
}
```

The `customer` parameter becomes unused. Remove it from the signature and from every call site in the file so `typecheck` and lint stay clean.

In `src/server/drive/service.ts`, add a guard at the top of `saveQuotationToDrive`, before the `getDownloadArtifact` call:

```ts
    async saveQuotationToDrive(user: CrmContext, quoteNo: string, rev: number) {
      const existing = await deps.quoteRepository.getQuote(quoteNo, rev);
      if (!existing) throw new Error(`Quotation ${quoteNo} R${rev} was not found.`);
      if (existing.source === 'External' && !existing.uploadDataB64) {
        throw new Error(`Quotation ${quoteNo} R${rev} is already stored in Google Drive.`);
      }

      const artifact = await deps.quoteService.getDownloadArtifact(user, quoteNo, rev);
      ...
```

The function already fetches the quote a few lines below (`const quote = await deps.quoteRepository.getQuote(quoteNo, rev);`). Reuse `existing` instead of fetching twice, and delete the duplicate fetch and its now-redundant not-found check.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/server/quotes/service.test.ts src/server/drive/service.test.ts`
Expected: PASS.

Then: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/server/quotes/service.ts src/server/drive/service.ts src/server/drive/service.test.ts src/server/quotes/service.test.ts
git commit -m "fix(quotes): stop serving a placeholder stub for Drive-hosted uploads

externalArtifact fabricated an HTML stub whenever a quote had no stored
bytes. Every upload now has no stored bytes, so that stub would be served
for all of them, and Save to Drive would upload the stub itself."
```

---

### Task 5: Confirm the viewer renders correctly, without assuming

The spec predicts `docs/source-appscript/Index.html` needs no change, because `mQuoteViewer` already hides the download row when `doc` and `pdf` are both empty (Index.html line 1924) and already renders "View in Drive" when `driveViewLink` is set (line 1930). This task proves that with a test rather than trusting the reading.

**Files:**
- Test: `src/app/crm/legacy-app.test.ts`
- Modify **only if the test proves it necessary**: `docs/source-appscript/Index.html`

**Interfaces:**
- Consumes: the row shape produced by Task 3, surfaced through `api_getQuotation`.
- Produces: nothing consumed by later tasks.

- [ ] **Step 1: Write the test**

Add this to `src/app/crm/legacy-app.test.ts`, directly after the existing test named `'saving a quotation to Drive replaces the button with a working link'` (around line 340). It reuses that test's exact harness — `mockRpc`, `workspace('L6')`, `render(createElement(CrmApp))`, and `window.eval` to open the modal.

```ts
  test('a Drive-hosted upload shows only a View in Drive link', async () => {
    mockRpc((fn) => {
      if (fn === 'api_workspace') return workspace('L6');
      if (fn === 'api_listCases') return [];
      if (fn === 'api_getQuotation') {
        return {
          quote: {
            quoteNo: 'QTN-2026-0001',
            rev: 0,
            caseId: 'CASE-2026-0001',
            title: 'Vendor offer',
            source: 'External',
            fileName: 'vendor-offer.pdf',
            templateId: '',
            templateName: '',
            status: 'Sent',
            subtotal: '',
            taxPct: '',
            taxAmount: '',
            total: 100,
            currency: 'INR',
            validUntil: '',
            notes: '',
            doc: '',
            pdf: '',
            driveViewLink: 'https://drive.google.com/file/d/drive-file-1/view',
            by: 'Admin User',
            date: '2026-08-13'
          },
          customer: { id: 'CUST-2026-0001', name: 'Acme Controls' },
          blocks: [],
          revisions: [{ rev: 0, status: 'Sent', date: '2026-08-13', total: 100 }]
        };
      }
      throw new Error(`Unexpected RPC ${fn}`);
    });

    render(createElement(CrmApp));
    await screen.findByRole('heading', { name: 'Overview' });
    window.eval('mQuoteViewer("QTN-2026-0001", 0)');

    expect(await screen.findByRole('link', { name: 'View in Drive' })).toHaveAttribute(
      'href',
      'https://drive.google.com/file/d/drive-file-1/view'
    );

    const body = document.getElementById('mbody')?.innerHTML ?? '';
    expect(body).not.toContain('Download uploaded file');
    expect(body).not.toContain('Save to Drive');
  });
```

**Fixture warning.** An earlier session lost significant time to this exact file. `mQuoteViewer` issues several RPCs; if `mockRpc` does not answer *every* one, the modal renders empty and the failure looks like a product bug rather than a fixture gap. The `throw new Error(\`Unexpected RPC ${fn}\`)` line is what tells you which one is missing — if `#mbody` comes back empty, read that error before touching any product code.

- [ ] **Step 2: Run the test**

Run: `npx vitest run src/app/crm/legacy-app.test.ts -t "Drive-hosted upload"`

Expected: **PASS on the first run.** That is the whole point of this task — it confirms the existing client already does the right thing with the new row shape, so no client change is needed.

If it FAILS, the spec's prediction was wrong. Only then: fix `docs/source-appscript/Index.html`, regenerate with `node scripts/port-legacy-index.mjs`, and re-run. **Never hand-edit `src/app/crm/legacy-full.generated.ts`** — it is generated, and a hand edit will be silently overwritten by the next generator run.

- [ ] **Step 3: Run the whole vitest suite**

Run: `npm test`

Expected: PASS. Watch specifically for the existing `'saving a quotation to Drive replaces the button with a working link'` test — it uses a `Generated` quote with `doc`/`pdf` set, so Task 3 and Task 4 should not have affected it. If it broke, a change leaked beyond the External upload path; investigate rather than adjusting that test.

- [ ] **Step 4: Commit**

```bash
git add src/app/crm/legacy-app.test.ts
git commit -m "test(crm): pin viewer behaviour for Drive-hosted uploads

The client already hides the download row when doc and pdf are both empty
and already renders the Drive link, so no client change was needed. This
locks that in, so a later change cannot silently strand uploaded
quotations with no way to open them."
```

---

### Task 6: Confirm the existing end-to-end suite still passes

**Scope note, read this first.** An earlier draft of this plan called for new Playwright tests driving the upload modal. That was overreach and has been removed deliberately. `tests/e2e/crm-smoke.spec.ts` is a shell-and-routing smoke suite — every test in it asserts on route containers and navigation, and none drives a modal workflow. Driving a real file picker through it would mean new fixture machinery for one flow whose logic is already fully covered by Task 3's unit tests and whose rendering is covered by Task 5.

So this task adds **no new e2e test**. It uses the existing suite as a regression gate, which is what it is good at.

**Files:** none changed.

**Interfaces:**
- Consumes: everything from Tasks 1-5.
- Produces: nothing.

- [ ] **Step 1: Run the full Playwright suite**

Run: `npx playwright test`

Expected: **21 passed**, matching the baseline exactly.

**Do not pipe this command through `tail` or `head`.** Doing so masks Playwright's exit code, and a failing run then reports as success. That has already produced one false green in this repo.

- [ ] **Step 2: If anything fails, diagnose before changing anything**

The changes in this plan touch only the External upload path. A shell or routing test failing means something leaked well beyond that path. Read the failure and find the cause — do not adjust the test to make it pass.

- [ ] **Step 3: No commit**

Nothing changed, so there is nothing to commit. Proceed to Task 7.

---

### Task 7: Full gate, deploy, verify in production

**Files:** none changed unless a gate fails.

- [ ] **Step 1: Run the complete local gate**

Run each, in order, and require all four to pass:

```bash
npm run typecheck
npm test
npx playwright test
npm run build
```

Expected: `typecheck` clean, **at least 240 vitest tests passing**, **at least 21 Playwright tests passing**, build succeeds. A lower count than the baseline means a test was deleted rather than updated — investigate before continuing.

- [ ] **Step 2: Back up the database**

```bash
node scripts/backup-database.mjs
node scripts/verify-backup.mjs
```

The free tier takes no automatic backups, so this is the only restore point. The backup contains the full customer dataset in plaintext — it belongs in the gitignored `backups/` directory and must never be committed.

- [ ] **Step 3: Merge and deploy**

```bash
git checkout main
git merge --no-ff feat/drive-first-quotation-upload
git push origin main
```

Vercel deploys `main` automatically. Wait for the deployment to report ready before verifying.

- [ ] **Step 4: Verify in production**

Three checks, all required:

1. Upload a real quotation file through the live CRM. It must succeed.
2. Open the Drive folder `AS CRM Quotations Testing` (account `testing@automationsystems.org`). The file must be there, named `<quoteNo> R<rev> - <customer> - <filename>`. The "View in Drive" link in the CRM must open it.
3. Confirm nothing was written to the database blob column:

```sql
select count(*) as total, count(upload_data) as with_blob from public.quotations;
```

Expected: `with_blob = 0`. **If it is not 0, stop and revert** — the change did not take effect and blobs are still accumulating.

- [ ] **Step 5: Measure the real upload size limit and report it**

Spec risk 3: the client allows 8 MB, but Vercel's documented serverless request-body limit is 4.5 MB and base64 inflates by 1.33×, implying a real ceiling near 3.3 MB.

Upload a ~5 MB file in production and record what actually happens. Report the observed limit and the exact error. **Do not fix it in this plan** — if the limit is confirmed, raise it as a separate one-line change so users get a clear message instead of an opaque `413`.

- [ ] **Step 6: Update CONTEXT.md**

Record: uploaded quotations now live in Drive; `quotations.upload_data` is written no longer but still exists; phase 2 (dropping the column) is outstanding; and the measured result of Step 5.

```bash
git add CONTEXT.md
git commit -m "docs: record Drive-first quotation storage in the project context"
git push origin main
```

**Rollback at any point:** `git revert` the merge commit and push. There is no schema change to undo — the column still exists, so reverted code simply resumes writing to it.

---

## Follow-ups deliberately excluded from this plan

Each needs its own spec and plan. Recorded here so they are not lost:

1. **Phase 2 — drop `quotations.upload_data`.** Remove every SQL reference, then a migration to drop the column. Only after this phase is proven in production.
2. **The case-list N+1** (`src/server/cases/service.ts:623`). Becomes the binding constraint at roughly 300-500 cases. Reuses the existing `getCustomersByIds()`.
3. **Move the Drive folder to a Workspace Shared Drive.** Files currently sit in `testing@automationsystems.org`'s personal My Drive; if that account is deleted, every quotation link breaks.
4. **The upload size limit**, pending the Step 5 measurement.
5. **SQL-side filtering and pagination** for the customer and case lists — the change that reaches 100+ users.
