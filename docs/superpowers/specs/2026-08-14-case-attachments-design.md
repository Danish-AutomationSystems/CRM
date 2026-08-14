# Ticket Response Attachments — Design Spec (2026-08-14)

## Context

Reassigning a ticket can already carry an optional internal handover note
(`docs/superpowers/specs/2026-08-14-ticket-handover-notes-design.md`). The project
owner wants documents attachable to that same response — any file type, up to
**100 MB**, stored only in Google Drive, in a folder separate from quotations.

## The constraint that shapes everything

The existing upload path sends files as base64 inside the JSON-RPC body. **Vercel's
serverless request-body limit is 4.5 MB**, and base64 inflates by 1.33×, so the real
ceiling on that path is roughly **3.3 MB**. (This is also why the existing quotation
upload, whose UI claims 8 MB, is expected to fail above ~3.3 MB — an open, separately
recorded issue.)

100 MB is about 30× beyond what that mechanism can carry. It is not a tuning problem;
the mechanism has to change.

**Solution: Google Drive resumable upload sessions.** The server creates an upload
session and hands the browser a session URL; the browser sends the bytes **directly to
Google**. Nothing traverses Vercel, so the body limit does not apply. Resumable also
means a dropped connection part-way through a 100 MB upload resumes rather than
restarting.

## Decisions

Taken during brainstorming with the project owner:

| # | Decision | Notes |
|---|---|---|
| 1 | Max **100 MB** per file, any type. | Owner's requirement. No MIME allow-list. |
| 2 | Attachments are added **only while reassigning**, alongside the handover note. | Owner's choice. I raised that this blocks the modal on a multi-minute upload and leaves no way to attach a document without reassigning; the owner accepted both. |
| 3 | **Multiple** files per reassignment. | Owner's choice. Requires its own table rather than a column. |
| 4 | Drive name: `<caseId> - <YYYY-MM-DD> - <uploader> - <original filename>`. | Owner's choice from three candidates. |
| 5 | Files live in a **new, separate** Drive folder from quotations. | Owner's requirement. |
| 6 | The upload completes **before** the reassignment commits. | Consistent with the quotation upload's fail-fast behaviour, already approved. A failed upload means no reassignment. |
| 7 | Attachments are **immutable**, like the notes. | Controller decision; the activity log is append-only everywhere else. |

## The folder, and why it cannot be created by hand

The app's OAuth scope is `https://www.googleapis.com/auth/drive.file`
(`src/app/api/admin/drive-setup/start/route.ts:8`), which grants access **only to files
and folders the application itself created**. A folder created manually in the Drive UI
would be invisible to the CRM — unwritable and unlistable.

So the folder is created programmatically, exactly as `AS CRM Quotations Testing` was
(`src/app/api/admin/drive-setup/callback/route.ts:63`), named
**`AS CRM Case Attachments Testing`**, with its id stored in `public.settings` under
`GOOGLE_DRIVE_ATTACHMENTS_FOLDER_ID`.

Measured headroom on `testing@automationsystems.org`: **537 GB free** of 1650 GB — about
5,300 files at the 100 MB ceiling.

## Architecture

### Upload flow

```
Browser                        Server                          Google Drive
  |-- begin(caseId, files) ------>|                                  |
  |                               |-- loadVisibleCase (access check)  |
  |                               |-- validate count/size/name        |
  |                               |-- create resumable session ------>|
  |<-- session URLs --------------|<-- session URLs ------------------|
  |                                                                   |
  |========== bytes, direct, chunked, resumable ====================>|
  |                                                                   |
  |-- commit(caseId, who, note, [fileIds]) -->|                       |
  |                               |-- verify each file --------------->|
  |                               |   (exists? size? our folder?)      |
  |                               |-- rename to convention             |
  |                               |-- transaction: reassign + note + attachment rows
```

Two RPCs replace one:

- `api_beginAttachmentUpload(caseId, files[])` — access-checked, validates, returns one
  resumable session URL per file. Writes nothing.
- `api_assignTicket(caseId, who, note, uploadedFileIds[])` — the existing RPC, extended.
  Verifies, renames, then runs the existing transaction.

**The server never trusts the client's account of what was uploaded.** The client reports
file ids; the server independently fetches each file's metadata from Drive and checks it
exists, matches the declared size, and sits in our attachments folder. A client cannot
fabricate an attachment row or point one at an arbitrary Drive file.

### Why the session is created server-side

Creating the session requires an OAuth access token, which must never reach the browser.
The session URL that *is* returned is a bearer capability scoped to writing one file into
one folder, and it is short-lived. That exposure is inherent to direct-to-Drive uploads
and is the reason the access check runs before a session is ever created.

### Data

New migration `0010_case_attachments.sql`:

```sql
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
```
plus indexes on `activity_id` and `case_id`.

`activity_log.id` is already a `uuid primary key` (`0001_initial_schema.sql:182`), so
attachments bind to the exact reassignment that carried them.

`logActivity` on the cases repository widens from `Promise<void>` to `Promise<string>`,
returning the inserted id. Widening a return type leaves the ~40 existing callers
unaffected, and the other three `logActivity` implementations are untouched.

### Naming

Built **server-side**, from data the server already holds — never from a client-supplied
string:

```
CASE-2026-0004 - 2026-08-14 - Danish - site-drawing-revB.pdf
```

The original filename is sanitised (path separators and control characters stripped,
length bounded). If that exact name already exists in the folder, a ` (2)` suffix
disambiguates.

### Failure handling

| Fails at | Outcome |
|---|---|
| Access check or validation | Nothing created; no session issued. |
| Upload (browser → Drive) | Orphan or partial file in Drive; **nothing written to the database**. The reassignment does not happen. |
| Verification | Nothing committed. Uploaded files are deleted best-effort. |
| Transaction | Rolls back; uploaded files deleted best-effort. If that delete also fails, the **original** transaction error surfaces, not the cleanup error. |
| Rename after commit | Cosmetic only. Logged. The request still succeeds. |

An abandoned upload (user closes the tab mid-transfer) leaves a file in the folder with no
database row. It is identifiable by having no `case_attachments` row referencing it. A
reconciliation sweep is **out of scope** and recorded as a follow-up.

### Client

The reassign modal gains a file picker (multiple), a list of chosen files with sizes, a
per-file progress bar, and a cancel button. Submit is disabled while uploading. Files
upload first; only when all succeed does the reassignment RPC fire.

Rendering: attachments appear beneath their handover note in case history, and beneath the
"Latest handover note" card, each as a link to its Drive file.

All client changes go through `docs/source-appscript/Index.html` and are regenerated with
`node scripts/port-legacy-index.mjs`. `src/app/crm/legacy-full.generated.ts` is never
hand-edited.

## Testing

- Session creation is access-checked: a user who cannot see the case gets no session.
- Over-limit files are rejected before any session is created.
- Verification rejects a file id that does not exist, is the wrong size, or lives outside
  our folder — the three ways a client could lie.
- A failed verification writes nothing and deletes what was uploaded.
- Reassigning with no attachments behaves **byte-identically** to today.
- Names follow the convention and are built server-side; a client-supplied name cannot
  influence the stored name.
- Duplicate names get the disambiguating suffix.
- The transaction-failure path deletes the uploaded files and surfaces the original error.
- Client: multiple selection, progress, cancel, and submit disabled mid-upload.

Every Drive interaction is mocked at the service boundary. No test contacts the real
Google API.

### Column-parity guard

`case_attachments` gets the same INSERT/SELECT parity guard as `quotations` and
`activity_log`, for the reason recorded in those specs: a column silently missing from an
INSERT is a defect class this codebase has already shipped once.

## Known risks

1. **The reassign modal blocks on the upload.** Accepted per decision 2. A 100 MB file on
   a slow connection could hold the modal for minutes.
2. **Session URLs are bearer capabilities.** Short-lived and issued only after the access
   check, but real.
3. **Orphaned files** from abandoned uploads accumulate with no automatic cleanup.
4. **No virus or content scanning.** Any file type is permitted per decision 1. Google
   Drive applies its own scanning; the CRM adds none, and files are linked rather than
   served by us.
5. **Drive storage is finite** — 537 GB, roughly 5,300 files at the ceiling. No quota
   monitoring is built.

## Explicitly out of scope

- Attaching documents anywhere other than a reassignment.
- Deleting or replacing an attachment after the fact.
- A reconciliation sweep for orphaned Drive files.
- Virus scanning, content inspection, or a MIME allow-list.
- Drive quota monitoring or alerting.
- Fixing the pre-existing ~3.3 MB ceiling on the *quotation* upload path, which is a
  separate recorded issue.
