# Full Legacy Quotation Template Revival — Design Spec (2026-07-31)

## Context

The Drive quotation-save feature (shipped earlier today) deliberately deferred
"full legacy revival": real Google Doc templates, Docs API merge-fill, and
Drive-native PDF export for *generated* quotations. Today, `api_generateQuoteDoc`
is a placeholder — it just points `doc`/`pdf` at the same local HTML download
URL already used elsewhere. Templates are a flat, unseeded JSON array in
`public.settings` (`QUOTE_TEMPLATES`) with no admin UI and no real content
behind them — right now the "Template" dropdown on "New quotation" shows "No
templates found," blocking generated-quote creation entirely.

The project owner wants this fully restored to 100% legacy parity: real
Google Doc templates, discoverable from a real Drive folder (exactly like
the old Apps Script version), merge-filled via the Docs API, exported to a
real PDF via Drive's native Doc→PDF conversion — with proper multi-template
support (anyone can add a template by dropping a Doc into the Drive folder,
no code change).

## What the legacy version did (recap, verified against `Code.gs` earlier this session)

- `api_listTemplates()` (`Code.gs:1531`): enumerates every `MimeType.GOOGLE_DOCS`
  file in a fixed "Templates" Drive folder.
- `createStarterTemplate_()` (`Code.gs:165`): built one starter Doc via
  `DocumentApp`, with placeholders `{{COMPANY}}`, `{{QUOTE_NO}}`, `{{REV}}`,
  `{{DATE}}`, `{{CUSTOMER_NAME}}`, `{{CUSTOMER_ADDRESS}}`, `{{CONTACT_NAME}}`,
  `{{TITLE}}`, `{{VALID_UNTIL}}`, `{{BOQ_TABLE}}`, `{{NOTES}}`, `{{TAX_PCT}}`,
  `{{CURRENCY}}`, `{{PREPARED_BY}}`, plus static terms-and-conditions copy.
- `api_generateQuoteDoc()` (`Code.gs:1786`): copies the selected template into
  the Quotations output folder, opens it as a `Document`, does
  `body.replaceText(pattern, value)` for every merge field, finds the
  `{{BOQ_TABLE}}` paragraph via `body.findText(...)`, inserts a heading +
  table per BOQ block plus a totals table at that location via
  `body.insertTable(index, data)` (a 2D string array — `DocumentApp` fills
  cell text automatically), removes the placeholder paragraph, saves, then
  exports the saved Doc to PDF via `copyFile.getAs('application/pdf')` (pure
  Drive-level conversion, no separate rendering engine), and stores both
  files' Drive URLs on the quote row.

## What we're building

### Template management (mirrors legacy exactly)

- A new Drive folder, **"AS CRM Templates Testing"**, created during the
  one-time OAuth setup (the callback route already creates the Quotations
  folder in that same flow — extend it to also create this one and seed a
  starter template Doc inside it).
- `api_listTemplates()` is rewritten to call `drive.files.list()` filtered to
  `mimeType = 'application/vnd.google-apps.document'` and `parents` = the
  Templates folder ID (read from `public.settings`, same pattern as
  `GOOGLE_DRIVE_QUOTATIONS_FOLDER_ID`), replacing the current flat-JSON
  `QUOTE_TEMPLATES` settings read entirely. `templateId`/`templateName` on a
  quote row become real Drive file IDs/names again (as they were designed to
  be — `QuoteRow.templateId`/`templateName` already exist unchanged).
- Anyone can add a new template by dropping a Google Doc into that Drive
  folder — no CRM code or admin UI change needed, exactly like legacy.

### Merge-fill + table insertion (Docs API, new territory for this codebase)

`api_generateQuoteDoc` gets rebuilt to do real work:

1. **Copy** the selected template file into the Quotations folder
   (`drive.files.copy`), naming it `<quoteNo>-R<rev> — <customerName>`
   (matches legacy).
2. **Merge-fill the copy** via `documents.batchUpdate` with one
   `replaceAllText` request per merge field — index-free, since
   `ReplaceAllTextRequest` searches the document's own current text and
   replaces matches; no manual index tracking needed for this step, mirroring
   how `DocumentApp.replaceText()` needed none either.
3. **Insert the BOQ tables.** `{{BOQ_TABLE}}` cannot be merge-replaced with
   rich structure (a table) via `replaceAllText`, so:
   a. `documents.get()` the merged doc, locate the `{{BOQ_TABLE}}` paragraph's
      `startIndex`/`endIndex` (mirrors legacy's own `body.findText(...)` — the
      original implementation needed this same two-phase "locate marker, then
      insert structure there" approach; we are not introducing new complexity
      relative to legacy, just doing the same two phases via a different API).
   b. One `batchUpdate`: `deleteContentRange` (removes the marker paragraph)
      + `insertTable` per BOQ block (empty rows × the block's header count),
      + one `insertTable` for the totals (subtotal/tax/total rows).
   c. `documents.get()` again to read the just-created tables' actual cell
      `startIndex` values (row-major, deterministic order — the Docs API
      does not return per-cell indices in the `batchUpdate` reply, a second
      fetch is the documented, reliable way to get them).
   d. One final `batchUpdate`: `insertText` into each cell at its discovered
      index, filling headers + row data + totals.
4. **Export to PDF.** `drive.files.export({ fileId, mimeType: 'application/pdf' })`
   on the merged copy — pure Drive-level conversion, no external renderer,
   exactly matching legacy's `getAs('application/pdf')`.
5. **Save the PDF** as a new Drive file in the Quotations folder (`drive.files.create`
   with the exported bytes), set both the Doc copy and the PDF to
   domain-shared read access (reusing the exact sharing logic already built
   for quotation Drive-save).
6. **Record both URLs** (`doc`/`pdf` = the Doc's and PDF's `webViewLink`) on
   the quote row via the existing `updateQuote`.

Steps 2-3 (merge-fill, table-locate, table-insert, cell-fill) are each
**pure, independently unit-testable functions** operating on plain
JSON structures (Docs API request/response shapes are stable, documented,
and constructible by hand in tests) — no live API calls needed to test the
request-building logic, only the final orchestration layer touches the real
`docs`/`drive` clients, and that layer is tested the same way the existing
`DriveService`/`DriveClient` split already is (fakes/mocks at the client
boundary).

### OAuth scope change (breaking, requires one-time re-consent)

The Docs API requires scope `https://www.googleapis.com/auth/documents` in
addition to the existing `https://www.googleapis.com/auth/drive.file`. A
refresh token's granted scopes are fixed at consent time — the existing
`GOOGLE_DRIVE_REFRESH_TOKEN` cannot be upgraded in place. The one-time setup
routes (`/api/admin/drive-setup/start`/`callback`) get updated to request
both scopes, and the project owner will need to re-run the one-time consent
flow once this ships, producing a new refresh token that replaces the old
one. No code change is needed to permit the re-run: the existing
self-disabling guard (refuses to run if `GOOGLE_DRIVE_REFRESH_TOKEN` is
already set) stays exactly as-is — re-running deliberately requires the
project owner to first remove `GOOGLE_DRIVE_REFRESH_TOKEN` from Vercel (a
manual, explicit act, consistent with treating credential rotation as
something a human decides to do, not a silently-available toggle in the
route itself), then visit `/api/admin/drive-setup/start` again as before.

### UI implications

- "Download document" / "Download PDF" (currently pointing at the local
  HTML endpoint) become real `webViewLink`s pointing directly at Drive,
  exactly like legacy's "Open Google Doc"/"Open PDF" — for quotes that HAVE
  been generated via the new pipeline. Existing quotes generated under the
  old placeholder keep their old links until someone clicks "Re-generate
  download" again (already an existing button/flow, unchanged).
- The "Save to Drive" button (shipped earlier today) becomes redundant for
  *generated* quotes once this ships, since `generateQuoteDoc` itself now
  creates the Doc+PDF directly in the Drive folder as a side effect of
  generation — mirroring how legacy never had a separate "save" step for
  generated docs either. It stays exactly as-is, unchanged, for *uploaded*
  (external) quotes, which still need an explicit save step since generation
  doesn't apply to them. The UI conditionally hides the "Save to Drive"
  button for `source === 'Generated'` quotes that already have `doc`/`pdf`
  set from the new pipeline (no `driveViewLink` needed for those - `doc`/`pdf`
  already are Drive links).

## Non-goals

- No change to the BOQ-table paste/parse UI, quote creation form, or pricing
  logic — this only changes what happens when a template is applied to
  produce documents.
- No template *editing* UI in the CRM — templates are managed by editing the
  Google Doc directly in Drive, exactly like legacy.
- No migration/backfill of existing placeholder-generated quotes.
- No change to the *uploaded* (external) quotation flow or the existing
  Drive-save feature's behavior for external quotes.

## Architecture

### New/changed modules

- `src/server/drive/client.ts` — gains Docs-API-touching methods:
  `copyFile`, `exportToPdf`, plus a new `src/server/drive/docs.ts` wrapping
  `documents.get`/`documents.batchUpdate` calls (the only place that talks to
  the real Docs API — everything else is pure request-building).
- `src/server/drive/template-merge.ts` (new) — the pure functions:
  `buildMergeFieldRequests(fields: Record<string,string>): Request[]`,
  `locateMarker(doc: DocsDocument, marker: string): MarkerLocation`,
  `buildTableInsertionRequests(location, blocks, totals): Request[]`,
  `buildCellFillRequests(doc: DocsDocument, tableRanges, values): Request[]`.
  Fully unit-tested against hand-built Docs API JSON fixtures, zero network
  calls.
- `src/server/drive/template-folder.ts` (new, alongside existing `folder.ts`)
  — `getDriveTemplatesFolderId()`, reads `GOOGLE_DRIVE_TEMPLATES_FOLDER_ID`
  from `public.settings`.
- `src/server/quotes/repository.ts` / `service.ts` — `listTemplates()`
  rewritten to call the Drive client instead of reading `QUOTE_TEMPLATES`
  from settings; `generateQuoteDoc` rewritten to orchestrate the full
  copy→merge→table-insert→export→save pipeline.
- `src/app/api/admin/drive-setup/start|callback/route.ts` — scope list
  extended; callback additionally creates the Templates folder and seeds
  the starter Doc via the Docs API.
- Legacy UI (`Index.html` + hand-patched generated artifact, same dual-edit
  discipline as before): hide "Save to Drive" for generated quotes that
  already have Drive-hosted `doc`/`pdf`.

### Database

No new migration needed — `templateId`/`templateName`/`doc`/`pdf` columns
already exist and already have the right shape (text) for real Drive file
IDs/URLs.

## Testing strategy (TDD)

- `src/server/drive/template-merge.ts` tests: hand-built Docs API document
  JSON fixtures (a `{{BOQ_TABLE}}` paragraph, some merge-field text runs),
  asserting exact `Request[]` output for each pure function — including
  edge cases (marker not found, empty BOQ blocks, multi-row tables, special
  characters in customer names needing no additional escaping since
  `replaceAllText` handles literal text safely via the API, not string
  concatenation into markup the way the legacy HTML renderer needs `esc()`).
- `src/server/drive/client.ts`/`docs.ts` tests: mocked `googleapis` (same
  pattern as the existing Drive client tests) - verify `copyFile`,
  `exportToPdf`, `documents.get`/`batchUpdate` are called with the right
  shapes, and that failures propagate as normalized errors.
- `src/server/quotes/service.test.ts`: `generateQuoteDoc` orchestration
  tested against a fake `DriveClient`/`DocsClient`, verifying the full
  sequence (copy → merge → locate → insert → fill → export → save → update
  quote row) fires in order with the right arguments, and that `doc`/`pdf`
  end up as the exported files' `webViewLink`s.
- `src/server/quotes/repository.test.ts` (or extend `service.test.ts`):
  `listTemplates()` calls the Drive client's file-listing method with the
  right folder ID and mimeType filter.
- Playwright e2e: mock `api_listTemplates` returning a real template, create
  a quotation, click "Generate", assert "Download document"/"Download PDF"
  become real (mocked) Drive links; assert "Save to Drive" is hidden for
  that quote.

## Explicitly deferred (still, even after this)

- Rich template editing/preview inside the CRM.
- Support for template formats other than Google Docs (e.g. Slides).
- Any change to the domain-shared sharing model already established.
