# Ticket Response Attachments Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let someone attach documents (any type, up to 100 MB each, multiple per reassignment) to a ticket handover, stored only in Google Drive.

**Architecture:** 100 MB cannot pass through Vercel — its request-body limit is 4.5 MB and base64 inflates by a third. So the server creates a Drive **resumable upload session** and the browser sends bytes **directly to Google**. The server then independently verifies each uploaded file before writing anything, renames it to the naming convention, and commits the reassignment, note and attachment rows in the existing transaction.

**Tech Stack:** TypeScript, Next.js 15 App Router, `postgres.js`, `googleapis` (Drive v3), vitest, Playwright.

## Global Constraints

- **Design spec:** `docs/superpowers/specs/2026-08-14-case-attachments-design.md`. Read it before starting.
- **Reassigning with no attachments must behave byte-identically to today.** Same details string, same return value, same note handling. The existing `assignTicket` tests are the regression guard and must pass unchanged.
- **Never trust the client about what was uploaded.** The client reports Drive file ids; the server must independently verify each one exists, matches the declared size, and sits in our attachments folder — before any row is written.
- **The Drive file name is built server-side**, from data the server already holds. A client-supplied string must never become the stored name.
- **The attachments folder must be created programmatically.** The OAuth scope is `drive.file` (`src/app/api/admin/drive-setup/start/route.ts:8`), which reaches only files the app itself created. A hand-made folder is invisible to the app.
- **The OAuth access token must never reach the browser.** Only the resumable session URL does.
- **No MIME allow-list.** Any file type is permitted, per the owner's decision.
- **`src/server/drive/client.ts` imports `googleapis` via a dynamic `await import()` inside `driveApi()`**, deliberately — there is a comment explaining why it must never become a top-level import. Preserve that.
- **TDD is mandatory.** Every code change is preceded by a test run and *seen to fail* first.
- **No test may contact the real Google API.** Mock at the service boundary, as `src/server/drive/service.test.ts` and `src/server/drive/client.test.ts` already do.
- **Baseline that must not regress: 283 vitest tests and 22 Playwright tests currently pass.**
- Playwright needs env vars or the dev server will not boot:
  `$env:NEXT_PUBLIC_SUPABASE_URL="http://127.0.0.1:3999"; $env:NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY="dummy-key-for-e2e"; npx playwright test`
  **Never pipe Playwright through `tail` or `head`** — it masks the exit code and a failing run reports as success.
- **Client changes go through `docs/source-appscript/Index.html`**, regenerated with `node scripts/port-legacy-index.mjs`. **Never hand-edit `src/app/crm/legacy-full.generated.ts`.**
- **Never commit secrets.** Do not open, read, or echo `.env.local`.
- Run commands from the repo root: `D:\AutomationSystems\CRM\migrated-crm`. Windows; use the PowerShell tool.

---

## File Structure

| File | Responsibility | Change |
|---|---|---|
| `supabase/migrations/0010_case_attachments.sql` | The table | **Create** |
| `src/server/drive/client.ts` | Drive v3 wrapper | **Modify** — `createResumableSession`, `getFileMeta`, `listFileNamesInFolder` |
| `src/server/drive/client.test.ts` | Wrapper tests | **Modify** |
| `src/server/drive/attachments-folder.ts` | Resolve the attachments folder id from settings | **Create** |
| `src/server/cases/attachments.ts` | Naming, validation, verification — pure logic, no I/O | **Create** |
| `src/server/cases/attachments.test.ts` | Its tests | **Create** |
| `src/server/cases/repository.ts` | `logActivity` returns the new id; attachment row writes and reads | **Modify** |
| `src/server/cases/repository.test.ts` | Parity guard | **Modify** — cover `case_attachments` |
| `src/server/cases/service.ts` | `beginAttachmentUpload`; `assignTicket` extension; `getCase` output | **Modify** |
| `src/server/cases/service.test.ts` | Unit tests | **Modify** |
| `src/server/cases/rpc.ts` | Register the new RPC, extend the existing one | **Modify** |
| `docs/source-appscript/Index.html` | File picker, progress, cancel, rendering | **Modify** |
| `src/app/crm/legacy-app.test.ts` | Client tests | **Modify** |
| `tests/e2e/crm-smoke.spec.ts` | Browser coverage | **Modify** |

---

### Task 1: Create the attachments folder and record its id

The folder cannot be made by hand — `drive.file` scope only reaches what the app created. This task creates it once, programmatically, and stores its id in `settings` alongside the existing `GOOGLE_DRIVE_QUOTATIONS_FOLDER_ID`.

**Files:**
- Create: `scripts/create-attachments-folder.mjs`
- Create: `src/server/drive/attachments-folder.ts`
- Test: `src/server/drive/attachments-folder.test.ts`

**Interfaces:**
- Produces, used by Tasks 4 and 5:
  ```ts
  export async function getDriveAttachmentsFolderId(): Promise<string>;
  ```

- [ ] **Step 1: Write `attachments-folder.ts`**

Copy the shape of `src/server/drive/folder.ts` exactly — same query, same error style — changing only the settings key:

```ts
import { sql } from '../db/client';

const FOLDER_ID_SETTING_KEY = 'GOOGLE_DRIVE_ATTACHMENTS_FOLDER_ID';

export async function getDriveAttachmentsFolderId(): Promise<string> {
  const rows = (await sql`
    select value
    from public.settings
    where key = ${FOLDER_ID_SETTING_KEY}
    limit 1
  `) as Array<{ value: string | null }>;

  const folderId = rows[0]?.value?.trim();
  if (!folderId) {
    throw new Error('Google Drive attachments folder is not configured. Run the one-time setup first.');
  }
  return folderId;
}
```

Write a test mirroring whatever tests exist for `folder.ts`; if none exist, test that a missing or blank setting throws and a present one is returned trimmed, mocking `../db/client`.

- [ ] **Step 2: Write the one-time setup script**

`scripts/create-attachments-folder.mjs`. It must be **idempotent**: if `GOOGLE_DRIVE_ATTACHMENTS_FOLDER_ID` is already set in `settings`, print the existing id and exit without creating anything. Otherwise create a Drive folder named `AS CRM Case Attachments Testing` and upsert the id into `settings`.

Model it on `src/app/api/admin/drive-setup/callback/route.ts:63-72` for the folder creation, and on the existing scripts in `scripts/` for how they read `DATABASE_URL` and construct the Drive client. It needs `GOOGLE_DRIVE_CLIENT_ID`, `GOOGLE_DRIVE_CLIENT_SECRET`, `GOOGLE_DRIVE_REFRESH_TOKEN` and `DATABASE_URL` from the environment.

**Never print any secret.** Printing the created folder id is fine and expected.

- [ ] **Step 3: Run it**

```powershell
$env:DATABASE_URL = (Select-String -Path .env.local -Pattern '^DATABASE_URL=').Line.Substring(13).Trim('"')
$env:GOOGLE_DRIVE_CLIENT_ID = (Select-String -Path .env.local -Pattern '^GOOGLE_DRIVE_CLIENT_ID=').Line.Split('=',2)[1].Trim('"')
$env:GOOGLE_DRIVE_CLIENT_SECRET = (Select-String -Path .env.local -Pattern '^GOOGLE_DRIVE_CLIENT_SECRET=').Line.Split('=',2)[1].Trim('"')
$env:GOOGLE_DRIVE_REFRESH_TOKEN = (Select-String -Path .env.local -Pattern '^GOOGLE_DRIVE_REFRESH_TOKEN=').Line.Split('=',2)[1].Trim('"')
node scripts/create-attachments-folder.mjs
```

Expected: prints the new folder id. Run it a **second** time and confirm it reports the existing id rather than creating a duplicate.

- [ ] **Step 4: Verify**

Confirm the setting exists and the folder is real — query `settings` for the key, and list the folder's metadata via the Drive API to confirm its name and that it is a folder.

- [ ] **Step 5: Commit**

```bash
git add scripts/create-attachments-folder.mjs src/server/drive/attachments-folder.ts src/server/drive/attachments-folder.test.ts
git commit -m "feat(drive): create and resolve the case attachments folder

The drive.file scope reaches only folders the app itself created, so this
folder cannot be made by hand in the Drive UI. The script is idempotent."
```

---

### Task 2: Drive client — resumable sessions and file metadata

**Files:**
- Modify: `src/server/drive/client.ts` (the `DriveClient` type at lines 9-15, and the returned object)
- Test: `src/server/drive/client.test.ts`

**Interfaces:**
- Produces, used by Tasks 4 and 5:
  ```ts
  createResumableSession(input: {
    fileName: string;
    mimeType: string;
    sizeBytes: number;
    folderId: string;
  }): Promise<{ sessionUrl: string }>;

  getFileMeta(fileId: string): Promise<{
    id: string;
    name: string;
    size: number;
    mimeType: string;
    webViewLink: string;
    parents: string[];
  } | null>;

  listFileNamesInFolder(folderId: string): Promise<string[]>;
  ```
  `getFileMeta` returns `null` when the file does not exist or is not accessible — callers treat that as verification failure.

- [ ] **Step 1: Write the failing tests**

Extend `src/server/drive/client.test.ts`, following its existing `vi.mock('googleapis', ...)` structure. You will need to add mocks for `files.get` and for whatever HTTP call creates the session.

Creating a resumable session is **not** a `drive.files.create` call with a media body — it is a POST to
`https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&supportsAllDrives=true`
carrying the file metadata as JSON plus `X-Upload-Content-Type` and `X-Upload-Content-Length` headers, whose **`Location` response header is the session URL**.

Getting an access token from the existing OAuth2 client: `google.auth.OAuth2` exposes `getAccessToken()`. Read how `driveApi()` builds `oauth2Client` (lines 40-42) and reuse that construction rather than duplicating it.

Tests to write:
- Creates a session and returns the `Location` header as `sessionUrl`.
- Sends the declared size and content type as the `X-Upload-Content-*` headers.
- Puts the file in the requested folder (`parents`).
- Throws a clear error when Google returns no `Location` header.
- `getFileMeta` returns the parsed metadata for an existing file.
- `getFileMeta` returns `null` for a 404.
- `listFileNamesInFolder` returns names of non-trashed files in the folder.

**The access token must not appear in any returned value.** Add a test asserting the returned object contains only `sessionUrl`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/server/drive/client.test.ts`
Expected: FAIL — the three methods do not exist.

- [ ] **Step 3: Implement**

Add the three signatures to the `DriveClient` type and implement them in the returned object. Reuse the existing lazy `driveApi()` pattern; **keep the `googleapis` import dynamic** — read the comment at lines 33-37 before touching that function.

For `getFileMeta`, request fields `id, name, size, mimeType, webViewLink, parents` and coerce `size` (Drive returns it as a string) to a number. Return `null` on a 404 rather than throwing.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/server/drive/client.test.ts`, then `npm test`, then `npx tsc --noEmit`.

Adding methods to `DriveClient` will break any hand-built fake implementing that type. Fix each properly — **no `as any`, no casts, no loosening the type.** `src/server/drive/service.test.ts` has such a fake and needed exactly this fix once before.

- [ ] **Step 5: Commit**

```bash
git add src/server/drive/client.ts src/server/drive/client.test.ts src/server/drive/service.test.ts
git commit -m "feat(drive): resumable upload sessions and file metadata

100 MB cannot pass through Vercel's 4.5 MB request body limit, so the
browser uploads straight to Google. The server creates the session; only
the session URL crosses to the client, never the access token."
```

---

### Task 3: Attachment logic — naming, validation, verification

Pure functions, no I/O, so they can be tested exhaustively and cheaply.

**Files:**
- Create: `src/server/cases/attachments.ts`
- Create: `src/server/cases/attachments.test.ts`

**Interfaces:**
- Produces, used by Tasks 5:
  ```ts
  export const MAX_ATTACHMENT_BYTES = 100 * 1024 * 1024;
  export const MAX_ATTACHMENTS_PER_RESPONSE = 10;

  export type RequestedUpload = { fileName: string; mimeType: string; sizeBytes: number };

  export function sanitiseFileName(name: string): string;
  export function buildDriveName(input: {
    caseId: string;
    uploaderName: string;
    fileName: string;
    when: Date;
  }): string;
  export function disambiguate(name: string, existingNames: string[]): string;
  export function validateRequestedUploads(files: unknown): RequestedUpload[];
  ```

- [ ] **Step 1: Write the failing tests**

Cover at least:

- `sanitiseFileName` strips path separators (`/`, `\`), control characters, and leading dots; collapses whitespace; bounds length; and never returns an empty string (fall back to `attachment`).
- `buildDriveName` produces `CASE-2026-0004 - 2026-08-14 - Danish - site-drawing-revB.pdf`.
- `buildDriveName` uses the sanitised name, so a filename of `../../etc/passwd` cannot escape.
- `disambiguate` returns the name unchanged when unused, ` (2)` when taken, ` (3)` when both taken.
- `validateRequestedUploads` rejects: a non-array, an empty array, more than `MAX_ATTACHMENTS_PER_RESPONSE`, a file over `MAX_ATTACHMENT_BYTES`, a zero or negative size, a missing name.
- `validateRequestedUploads` accepts any mime type, including empty — no allow-list.
- The over-size error message names the limit in MB so a user can act on it.

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run src/server/cases/attachments.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement**

Write `src/server/cases/attachments.ts`. Keep it dependency-free and I/O-free.

Format the date as `YYYY-MM-DD` from the passed-in `Date` — **take the date as a parameter, do not call `new Date()` inside**, so the tests are deterministic.

- [ ] **Step 4: Verify the error message reaches users**

`src/server/rpc/errors.ts` allow-lists user-facing messages by regex; anything unmatched becomes a generic `Something went wrong.` at HTTP 500. Check your over-size and too-many messages against `USER_FACING_PATTERNS`. If they do not match, add a specific pattern and a test in `src/server/rpc/errors.test.ts` asserting the message survives with a 400-class status.

This has bitten twice in this repo. Do not skip it.

- [ ] **Step 5: Run and commit**

Run `npx vitest run src/server/cases/attachments.test.ts`, then `npm test`, then `npx tsc --noEmit`.

```bash
git add src/server/cases/attachments.ts src/server/cases/attachments.test.ts
git commit -m "feat(cases): attachment naming, validation and sanitisation

Names are built server-side from server-held data; a client-supplied
filename is sanitised and can never escape the folder or the convention."
```

---

### Task 4: Migration and repository

**Files:**
- Create: `supabase/migrations/0010_case_attachments.sql`
- Modify: `src/server/cases/repository.ts`
- Modify: `src/server/cases/service.ts` (types only)
- Modify: `src/server/cases/repository.test.ts`

**Interfaces:**
- Produces, used by Task 5:
  ```ts
  export type CaseAttachmentRow = {
    id: string;
    activityId: string;
    caseId: string;
    driveFileId: string;
    driveViewLink: string;
    fileName: string;
    mimeType: string;
    sizeBytes: number;
    uploadedBy: string;
    createdAt: string;
  };

  // on CaseRepository:
  logActivity(entry: CaseActivityLogEntry): Promise<string>;   // widened from Promise<void>, returns the new id
  createAttachments(rows: Array<Omit<CaseAttachmentRow, 'id' | 'createdAt'>>): Promise<void>;
  listAttachmentsByCase(caseId: string): Promise<CaseAttachmentRow[]>;
  ```

- [ ] **Step 1: Write the migration**

`supabase/migrations/0010_case_attachments.sql`:

```sql
-- Attachments on a ticket handover response. Files live in Google Drive; only
-- metadata is stored here.
--
-- NOTE: scripts/apply-migrations.mjs already wraps each file in a single
-- transaction (sql.begin), so this file must NOT issue its own BEGIN/COMMIT.

set local lock_timeout = '3s';

create table if not exists public.case_attachments (
  id uuid primary key default gen_random_uuid(),
  activity_id uuid not null references public.activity_log(id) on delete cascade,
  case_id text not null,
  drive_file_id text not null,
  drive_view_link text not null default '',
  file_name text not null default '',
  mime_type text not null default '',
  size_bytes bigint not null default 0,
  uploaded_by text references public.users(email),
  created_at timestamptz not null default now()
);

create index if not exists case_attachments_activity_id_idx on public.case_attachments(activity_id);
create index if not exists case_attachments_case_id_idx on public.case_attachments(case_id);

alter table public.case_attachments enable row level security;

do $$
begin
  if not exists (
    select 1 from information_schema.tables
     where table_schema = 'public' and table_name = 'case_attachments'
  ) then
    raise exception 'case_attachments was not created';
  end if;

  if not exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'case_attachments' and column_name = 'activity_id'
  ) then
    raise exception 'case_attachments.activity_id is missing';
  end if;
end $$;
```

**Check how the other tables declare RLS** in `0001_initial_schema.sql` — every table has a deny-all policy. Match that pattern exactly; do not leave the new table with RLS enabled but no policy if the convention is to add one explicitly.

- [ ] **Step 2: Dry-run**

```
node scripts/apply-migrations.mjs --through 0010 --dry-run
```
**Do not apply it.** Applying happens in Task 8.

- [ ] **Step 3: Write the failing repository tests**

Extend `src/server/cases/repository.test.ts` with parity guards for the new statements, mirroring the existing ones: the `createAttachments` INSERT column list must cover what `listAttachmentsByCase` selects, and the value count must match the column count.

Include the anti-vacuity assertion the existing guard has — if the regex stops matching, the test must fail rather than compare two empty lists.

- [ ] **Step 4: Implement**

Widen `logActivity` to return the inserted id — add `returning id` to its INSERT and return it. Widening `Promise<void>` to `Promise<string>` leaves the ~40 existing callers unaffected.

Add `createAttachments` (a single multi-row insert, not one query per file) and `listAttachmentsByCase`. Add all three to the `CaseRepository` type and to every in-memory fake.

**The fakes must match the real queries' semantics.** Fakes drifting from the SQL has produced vacuous tests twice in this codebase.

- [ ] **Step 5: Run and commit**

`npx vitest run src/server/cases/repository.test.ts`, then `npm test`, then `npx tsc --noEmit`.

```bash
git add supabase/migrations/0010_case_attachments.sql src/server/cases/repository.ts src/server/cases/repository.test.ts src/server/cases/service.ts src/server/cases/service.test.ts src/server/dashboard/service.test.ts src/server/integration/concurrency.test.ts src/server/integration/crm-flows.test.ts
git commit -m "feat(cases): case_attachments table and repository access

logActivity now returns the id it inserted, so attachments bind to the
exact reassignment that carried them."
```

---

### Task 5: Service — begin upload, verify, commit

The heart of the feature.

**Files:**
- Modify: `src/server/cases/service.ts` (`assignTicket` at line 569, `getCase` at 588)
- Modify: `src/server/cases/rpc.ts`
- Test: `src/server/cases/service.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 2, 3 and 4.
- Produces:
  - `beginAttachmentUpload(user, caseId, files)` → `Array<{ fileName: string; sessionUrl: string }>`
  - `assignTicket(user, caseId, who, note?, uploadedFileIds?)`
  - `getCase` returns `attachments` grouped by `activityId`, and each history entry carries its attachments.

- [ ] **Step 1: Write the failing tests**

Follow the fixture style already in `src/server/cases/service.test.ts` — `makeService()`, `caseRow()`, `sales`. Read the existing `assignTicket` tests first.

Required cases:

**Access and validation**
- `beginAttachmentUpload` throws for a user who cannot see the case, and creates no session.
- It throws for a closed case.
- It rejects a file over 100 MB before creating any session.
- It rejects more than the per-response maximum before creating any session.

**Verification — the three ways a client can lie**
- A reported file id that Drive says does not exist → nothing committed.
- A file whose actual size differs from the declared size → nothing committed.
- A file whose `parents` do not include our attachments folder → nothing committed. **This is the important one**: without it a client could attach any file the app can see.

**Commit path**
- A successful reassignment with two attachments writes one activity row and two attachment rows, both bound to that activity's id.
- The stored Drive name follows the convention and ignores any client-supplied name.
- Verification failure deletes the uploaded files best-effort.
- Transaction failure deletes the uploaded files and surfaces the **original** error, not the cleanup error.

**Unchanged behaviour**
- Reassigning with **no** attachments produces byte-identical results to today — same details string, same return value. This one matters most; it is the regression guard.

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run src/server/cases/service.test.ts`
Expected: FAIL — `beginAttachmentUpload` does not exist and `assignTicket` ignores its fifth argument.

- [ ] **Step 3: Implement**

`beginAttachmentUpload`: `loadVisibleCase` → reject if `row.outcome` → `validateRequestedUploads` → resolve the folder id → for each file, build the Drive name and create a session. Return only `{ fileName, sessionUrl }` pairs. **Never return the access token or the folder id.**

`assignTicket`: after the existing note validation and before `updateCase`, if `uploadedFileIds` is non-empty:
1. `getFileMeta` each id; reject if `null`, if `size` mismatches, or if `parents` excludes the attachments folder.
2. Rename each to its final disambiguated name.
3. Inside the existing transaction: `updateCase`, then `logActivity` capturing the returned id, then `createAttachments` bound to that id.
4. On any failure after upload, best-effort `deleteFile` each, then rethrow the **original** error.

Wrap the transaction the same way `uploadQuotation` does in `src/server/quotes/service.ts` — read that first; it already implements exactly this upload-then-transaction-then-cleanup shape and is the pattern to follow.

`getCase`: add `listAttachmentsByCase` to the existing `Promise.all` so it costs no extra wall-clock, and attach each history entry's attachments by `activityId`.

`rpc.ts`: register `api_beginAttachmentUpload`, and pass `args[3]` to `assignTicket`.

- [ ] **Step 4: Run and commit**

`npx vitest run src/server/cases/service.test.ts`, then `npm test`, then `npx tsc --noEmit`.

If a pre-existing `assignTicket` test fails, **stop and report** — this change must be invisible when no attachments are supplied.

```bash
git add src/server/cases/service.ts src/server/cases/service.test.ts src/server/cases/rpc.ts
git commit -m "feat(cases): attach documents to a ticket handover

The server verifies every reported file against Drive - existence, size,
and folder - before writing any row, so a client cannot fabricate an
attachment or point one at a file it should not reach."
```

---

### Task 6: Client — picker, progress, cancel, rendering

**Files:**
- Modify: `docs/source-appscript/Index.html` (the reassign modal ~line 1500, `doAssign` ~1528, history rendering ~1472, `renderCase` ~1403)
- Regenerate: `src/app/crm/legacy-full.generated.ts`
- Test: `src/app/crm/legacy-app.test.ts`

- [ ] **Step 1: Write the failing tests**

Mirror the harness in `src/app/crm/legacy-app.test.ts` — `mockRpc`, `workspace('L6')`, `render(createElement(CrmApp))`, `window.eval`. Read the existing handover-note tests first; they drive this exact modal.

Cover:
- Selecting files lists their names and sizes.
- Submitting calls `api_beginAttachmentUpload`, then uploads, then calls `api_assignTicket` with the resulting file ids as the fourth argument.
- A file over 100 MB is rejected client-side with a clear message and no RPC call.
- Submit is disabled while uploading.
- History renders attachment links; a response with no attachments renders exactly as before.
- Attachment names are escaped — a filename containing HTML must not render as markup. Assert `window.__AS_CRM_XSS__` is not set.

The browser upload itself must be stubbed — no test performs a real network PUT.

- [ ] **Step 2: Run to verify they fail**, then implement in `Index.html`

The upload is a `PUT` to the session URL with the file as the body. Use `XMLHttpRequest` rather than `fetch` — it exposes `upload.onprogress`, which `fetch` does not, and this file is written in the same ES5-compatible style throughout. Match that style.

`esc()` every interpolated value. This file has an XSS regression test precisely because this is where injection bugs live.

- [ ] **Step 3: Regenerate**

`node scripts/port-legacy-index.mjs`. If it throws, it names the anchor it could not find. **Never hand-edit the generated file.**

- [ ] **Step 4: Run and commit**

`npx vitest run src/app/crm/legacy-app.test.ts`, then `npm test`, then `npx tsc --noEmit`.

```bash
git add docs/source-appscript/Index.html src/app/crm/legacy-full.generated.ts src/app/crm/legacy-app.test.ts
git commit -m "feat(crm): attach documents when reassigning a ticket"
```

---

### Task 7: End-to-end coverage

**Files:** `tests/e2e/crm-smoke.spec.ts`

- [ ] **Step 1: Write the test**

Model it on the existing handover-note e2e test. Mock `api_beginAttachmentUpload` to return a fake session URL, intercept the `PUT` to that URL with `page.route`, then assert `api_assignTicket` received the file ids and that the attachment link renders.

Use Playwright's `setInputFiles` with a small temporary file — do not attempt a real 100 MB upload.

- [ ] **Step 2: Run**

```powershell
$env:NEXT_PUBLIC_SUPABASE_URL="http://127.0.0.1:3999"
$env:NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY="dummy-key-for-e2e"
npx playwright test
```

Expected: 23 passed. **Do not pipe through `tail` or `head`.**

- [ ] **Step 3: Commit**

---

### Task 8: Gate, migrate, deploy, verify

- [ ] **Step 1: Full local gate** — `npm run typecheck`, `npm test`, `npm run build`, plus Playwright with the env vars above. At least 283 vitest and 23 Playwright passing.

- [ ] **Step 2: Back up** — `node scripts/backup-database.mjs` then `node scripts/verify-backup.mjs backups/<file>.json`.

- [ ] **Step 3: Apply the migration** — `node scripts/apply-migrations.mjs --through 0010 --dry-run`, then without `--dry-run`.

**Migration goes before deploy.** Code that reads `case_attachments` would fail against a database without it.

- [ ] **Step 4: Merge and deploy**

```bash
git checkout main
git merge --no-ff feat/case-attachments
git push origin main
```

- [ ] **Step 5: Verify in production**

1. Reassign a ticket with **no** attachment. Must behave exactly as before.
2. Reassign with a small file. Confirm it appears in `AS CRM Case Attachments Testing`, named `<caseId> - <date> - <uploader> - <filename>`, and the link opens it.
3. Reassign with **two** files at once. Both must appear and both must link.
4. Try a file over 100 MB. Must be rejected clearly, with no partial upload and no reassignment.
5. Confirm the rows are right:

```sql
select a.case_id, a.file_name, a.size_bytes, a.uploaded_by, l.action
from public.case_attachments a
join public.activity_log l on l.id = a.activity_id
order by a.created_at desc
limit 10;
```

Every row must join to a `CASE_ASSIGN` activity. A row that does not means attachments are binding to the wrong activity.

- [ ] **Step 6: Update CONTEXT.md** and push.

**Rollback:** `git revert` the merge and push. Leave the table — it is additive, nothing else reads it, and dropping it under pressure is riskier than leaving it.

---

## Follow-ups deliberately excluded

1. **Reconciliation sweep for orphaned Drive files** left by abandoned uploads.
2. **Deleting or replacing** an attachment.
3. **Attaching documents outside a reassignment.**
4. **Virus scanning or a MIME allow-list.**
5. **Drive quota monitoring** — 537 GB free, ~5,300 files at the ceiling.
6. **The pre-existing ~3.3 MB ceiling on the quotation upload path**, which this work does not touch but which the same resumable mechanism would fix.
7. **The real-SQL integration test** deferred from the handover-notes work.
