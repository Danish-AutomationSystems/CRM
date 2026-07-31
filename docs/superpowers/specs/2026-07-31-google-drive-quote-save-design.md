# Google Drive Quotation Save — Design Spec (2026-07-31)

## Context

The legacy Apps Script CRM saved every quotation (generated and uploaded) into a
Google Drive folder, giving the team a durable, shareable copy outside the
CRM database. During the Vercel/Supabase migration this was intentionally
dropped ("Google Drive upload is intentionally not part of the current
migrated version" — a recorded product decision) and quotations became
download-only, served straight from Postgres.

The project owner wants this restored: a way to push a copy of a
quotation into a Google Drive folder under a specific company Google
account (`testing@automationsystems.org`), triggered manually from the CRM.

## What the legacy version actually did (for context, not being rebuilt now)

`api_generateQuoteDoc` in `docs/source-appscript/Code.gs` never used a
third-party PDF library. It:

1. Copied a real Google Doc **template** (containing merge fields like
   `{{QUOTE_NO}}`, `{{CUSTOMER_NAME}}`, `{{BOQ_TABLE}}`) into the Drive
   output folder.
2. Merge-filled it via the Docs API (`body.replaceText`), and
   programmatically inserted BOQ/totals tables at the `{{BOQ_TABLE}}`
   placeholder.
3. Exported that Doc to a real PDF using Drive's native Doc→PDF export
   (`file.getAs('application/pdf')`) — no external PDF renderer at all.
4. Saved both the Doc copy and the PDF into the Drive output folder, set
   to domain-shared view-only, and recorded both links on the quote row.

This pipeline was fully dropped during migration — `api_listTemplates`
today reads a flat JSON `{id, name}` label list from `public.settings`,
not real Google Docs, and quote generation (`src/server/quotes/render.ts`)
produces a fixed-layout HTML file (served with `mimeType: 'text/html'`
regardless of the "Download PDF" button label — there is no real PDF
conversion anywhere in the current stack).

## Decision: scope for this task

**Drive-save only, as-is.** Save whatever the app already produces —
the generated HTML file for generated quotes, or the original uploaded
bytes/mimetype for uploaded quotes (which are frequently real PDFs
already) — into a Drive folder. Quote generation/rendering itself is
unchanged.

**Full legacy revival (real Google Doc templates, Docs API merge-fill,
Drive-native PDF export) is explicitly deferred**, not built as part of
this task. It is recorded here and in `CONTEXT.md` as ready-to-scope
follow-up work, since it would reuse the same Drive credentials and
`src/server/drive/` module this task establishes. Trigger for picking it
up: explicit request from the project owner's manager/stakeholder.

## Requirements (from stakeholder decisions during brainstorming)

- Trigger: **manual button**, not automatic on every generate/upload.
- Auth: **one-time setup**, not per-user. Any CRM user (any email) can
  trigger a save; the server always writes as a single fixed Google
  identity (`testing@automationsystems.org`), never impersonating the
  clicking user.
- Auth mechanism: **direct OAuth 2.0 refresh token** for
  `testing@automationsystems.org`, obtained via a one-time consent flow.
  Not domain-wide delegation (no Workspace super-admin dependency).
- OAuth client: a **new, dedicated** Google Cloud OAuth client
  (`AS-CRM-DRIVE`), separate from the existing `AS-WEBAPP` sign-in client
  — Supabase mediates sign-in and never exposes a Google refresh token to
  our code, so a direct-to-Google exchange is required regardless; a
  dedicated client keeps blast radius contained.
- Scope: `https://www.googleapis.com/auth/drive.file` (access limited to
  files/folders this app itself creates — not the full Drive).
- Folder: one flat folder, name **"AS CRM Quotations Testing"**, no
  per-customer subfolders. Legacy file-naming convention preserved:
  `<quoteNo> R<rev> - <customerName> - <fileName>`.
- Visibility: once saved, the CRM shows a **"View in Drive" link** back to
  the file (matching the legacy `DocLink`/`PdfLink` UX), not a silent
  backend-only copy.

## Architecture

### New module: `src/server/drive/`

- `client.ts` — constructs an authenticated `drive_v3.Drive` instance
  using `googleapis`'s `google.auth.OAuth2`, configured from three env
  vars: `GOOGLE_DRIVE_CLIENT_ID`, `GOOGLE_DRIVE_CLIENT_SECRET`,
  `GOOGLE_DRIVE_REFRESH_TOKEN`. The client library handles access-token
  refresh transparently on each call.
- `service.ts` — `saveQuotationToDrive(user, quoteNo, rev)`:
  1. Reuses the **existing** `quoteService.getDownloadArtifact(user,
     quoteNo, rev)` — already handles both generated-HTML and
     uploaded-file cases, and already enforces the same customer-access
     check (`ensureFull`) as every other quote RPC. No new access-control
     logic is introduced.
  2. Resolves the target Drive folder ID from `public.settings` (key
     `GOOGLE_DRIVE_QUOTATIONS_FOLDER_ID`), matching the existing pattern
     used for `QUOTE_TEMPLATES`.
  3. Uploads the artifact via `drive.files.create` (multipart: metadata +
     media body), names it per the legacy convention.
  4. Sets the file to domain-shared view-only (mirrors legacy
     `setSharing(DriveApp.Access.DOMAIN_WITH_LINK, ...VIEW)`), tolerating
     failure the same way legacy did (some Workspace domains restrict
     link sharing — catch and continue, the file still exists and is
     still reachable by anyone with direct folder access).
  5. Persists `drive_file_id`, `drive_view_link`, `drive_saved_at`,
     `drive_saved_by` on the `quotations` row.
  6. Returns the updated quote payload (same shape as `api_getQuotation`)
     so the client can re-render immediately.

### RPC

`src/server/quotes/rpc.ts` gains:
```ts
registerRpc(
  'api_saveQuotationToDrive',
  ({ args, context }) => service.saveQuotationToDrive(context, String(args[0] ?? ''), Number(args[1] ?? 0)),
  { read: false }
);
```
Same registration pattern as every other write RPC in this file.

### Database

New migration `supabase/migrations/0004_quotation_drive_link.sql`:
```sql
alter table public.quotations
  add column if not exists drive_file_id text,
  add column if not exists drive_view_link text,
  add column if not exists drive_saved_at timestamptz,
  add column if not exists drive_saved_by text;
```
All nullable — existing quotations are simply "not yet saved to Drive."

### UI

`docs/source-appscript/Index.html`'s `mQuoteViewer` (around line 1817,
next to the existing "Open Google Doc"/"Open PDF"/"Open uploaded file"
buttons) gains a button that is either:
- **"Save to Drive"** (calls `api_saveQuotationToDrive`, shows a
  "Saving…" disabled state, then either re-renders the viewer showing
  the link, or surfaces an error toast via the existing `oops()` helper)
  when `drive_view_link` is empty, or
- **"View in Drive ↗"** (a plain link, `target="_blank"`) when it is set.

Since the legacy-artifact regeneration pipeline is currently broken (a
pre-existing, unrelated bug documented in `CONTEXT.md` — running
`scripts/port-legacy-index.mjs` today produces invalid JavaScript), this
UI change is applied via the same dual-edit approach used earlier this
session for the cache-invalidation fix: edit `Index.html` (the source of
truth, for auditability) **and** hand-apply the identical, minimal change
directly to the committed `src/app/crm/legacy-full.generated.ts`. The
generator is not run.

## One-time credential setup (manual, human-in-the-loop)

1. Google Cloud Console, same project as `AS-WEBAPP`: enable the Google
   Drive API.
2. Create a new OAuth client `AS-CRM-DRIVE` (Web application type),
   redirect URI `http://localhost:53682/oauth/callback` (used only for
   the one-time local token-capture script below; nothing public-facing
   needs it afterward).
3. Client ID/Secret go into `.env.local` (git-ignored) and Vercel
   production env vars — never pasted into chat or committed, per the
   project's existing security rules.
4. A short-lived local script (`scripts/drive-oauth-setup.mjs`, deleted
   or left inert after use — not part of the running app) starts a
   throwaway local HTTP server on `localhost:53682`, opens/prints the
   Google consent URL (scope `drive.file`) for `testing@automationsystems.org`
   to approve, captures the resulting `code` via the local redirect,
   exchanges it server-side for a refresh token, and creates the "AS CRM
   Quotations Testing" Drive folder, printing its folder ID.
5. The project owner adds `GOOGLE_DRIVE_REFRESH_TOKEN` to Vercel env vars
   and the printed folder ID gets stored via
   `update public.settings set value = '<folder-id>' where key = 'GOOGLE_DRIVE_QUOTATIONS_FOLDER_ID'`
   (or an equivalent seed step) — not hardcoded, matching the
   `QUOTE_TEMPLATES` pattern.

## Error handling

Drive failures (expired/revoked token, quota, network) propagate through
the existing normalized RPC error path (`src/server/rpc/errors.ts`) — the
same mechanism every other write RPC already uses. The client surfaces
them via the existing `oops()` toast helper; no new error UI is
introduced. The button remains clickable again after a failure (no
persistent "in progress" lock), so retry is just "click again."

## Testing

- `src/server/drive/service.test.ts` (new): unit tests the upload flow
  against a mocked `drive_v3.Drive`-shaped dependency (injected the same
  way `quoteRepository` is injected into `createQuoteService` — no real
  network calls), covering: successful save populates all four DB
  columns and returns a link; access-denied customer throws the same
  error `getDownloadArtifact` would; a Drive API failure surfaces as a
  normalized RPC error and does not corrupt existing quote data.
- `src/app/crm/legacy-app.test.ts`: extend with a case driving
  `mQuoteViewer` through a mocked `api_saveQuotationToDrive` success and
  failure, asserting the button becomes a link / shows an error toast.
- `tests/e2e/crm-smoke.spec.ts`: one authenticated test mocking
  `api_saveQuotationToDrive`, clicking the button, asserting the "View in
  Drive" link appears with the expected `href`.
- No test ever calls the real Google API — all Drive interaction is
  mocked at the service boundary, consistent with how Supabase/Postgres
  access is already mocked in this test suite.

## Explicitly not built in this task

- Real Google Doc templates / Docs API merge-fill / Drive-native PDF
  export (the "full legacy revival" deferred scope above).
- Per-customer Drive subfolders.
- Automatic (non-manual) saving.
- Any change to how quotations are generated, rendered, or downloaded
  today — this task is additive only.
