# Drive-First Quotation Upload — Design Spec (2026-08-13)

## Context

Uploaded quotation files are currently written into the database, as
`quotations.upload_data bytea`, capped at ~8 MB each
(`src/server/quotes/service.ts:544`). Generated quotations already go to Google
Drive; only the *uploaded* path stores bytes in Postgres.

The scalability analysis in `docs/scalability-report-2026-08.md` measured the
consequence against the live production database. Summary of the numbers that
drive this spec:

- Supabase Free allows 500 MB; ~488 MB is usable after baseline overhead.
- All CRM records together (customers, cases, contacts, quotation metadata,
  activity log) cost about **250 kB per user-month**. At 20 users that is over
  eight years of runway.
- Uploaded files cost about **10 MB per user-month** at the same workload —
  roughly **40× everything else combined**. At 20 users the free database fills
  in under three months.

That single line item, not the CRM's own data, is what holds the practical
ceiling to 5–8 users. Moving uploads to Drive removes the only super-linear
storage term.

### This reverses an earlier recorded decision

`docs/superpowers/specs/2026-07-31-google-drive-quote-save-design.md` chose
"**Trigger: manual button**, not automatic on every generate/upload" as an
explicit stakeholder decision. That decision was correct for its purpose —
Drive was a durable *extra copy* alongside the database.

This spec changes Drive from a secondary copy into the **primary and only**
store for uploaded files. That is a deliberate reversal made on the strength of
the measured storage numbers above, not an oversight of the earlier spec.

## Verified starting state (measured 13 Aug 2026, live production)

```
quotations rows                 : 0
rows with a stored file         : 0
recycle_bin rows                : 0
Drive folder files              : 0
Drive account                   : testing@automationsystems.org ("Testing AS")
Drive folder                    : AS CRM Quotations Testing
Drive folder owner              : testing@automationsystems.org
Drive storage                   : 1112.60 GB used of 1650.00 GB (537 GB free)
GOOGLE_DRIVE_QUOTATIONS_FOLDER_ID : set in public.settings
All CRM users                   : 3, all on automationsystems.org
```

**There is no data to migrate.** No quotation row, no stored file, no recycle-bin
entry, no file in the Drive folder. Any migration step would be a no-op. This is
the cheapest possible moment to make this change, and the cost only rises.

## Decisions

Taken during brainstorming with the project owner:

| # | Decision | Rationale |
|---|---|---|
| 1 | Upload writes **only** to Drive. `upload_data` is never populated. | Removes the storage term entirely. |
| 2 | If Drive is unreachable, **the upload fails**. No database fallback. | Owner's choice. Guarantees no bytes ever enter Postgres. Cost: a Google outage blocks quotation upload. Mitigated by making retry a single click. |
| 3 | Uploaded files are reached via a **"View in Drive" link**. The download button is removed for uploaded quotations. | Owner's choice. Simplest, and matches how generated quotations already behave. |
| 4 | `upload_data` is **kept but unused** in this phase; dropped in a separate later phase. | Standard expand/contract column removal. Keeps this deploy revertable without a schema change. |
| 5 | Files stay in the **existing folder in `testing@`'s My Drive**. | Owner's choice. Shared Drive migration recorded as a known risk and follow-up below. |
| 6 | Scope is the Drive change **only**. The case-list N+1 is not touched. | Owner's choice. Keeps blast radius to the quotes and drive modules. |

## Architecture

### Sequencing

The Drive filename convention is `<quoteNo> R<rev> - <customerName> - <fileName>`,
but `quoteNo` and `rev` are allocated *inside* the database transaction
(`allocateQuoteRevision`). Three ways to resolve that ordering conflict were
considered:

**A — Hold the transaction open across the Drive upload.** Simplest code.
**Rejected:** ties up one of only ten pool connections for the multi-second
duration of a Google API call. Concurrent uploads would exhaust the pool.

**B — Split allocation into its own prior transaction.** **Rejected:** allocation
is entangled with `supersedePrevious` and auto-case creation. Splitting it risks
correctness in logic this change has no reason to touch.

**C — Upload first under a provisional name, then rename after commit.**
**Chosen.**

1. Upload the bytes to Drive as `<customerName> - <fileName>`. No database work
   has happened yet.
2. Run the **existing, unmodified** transaction, writing `driveFileId` and
   `driveViewLink`, leaving `uploadDataB64` empty and `pdf` empty.
3. After the transaction commits, rename the Drive file to the full convention.

No transaction is ever held open across a network call.

### Failure matrix

| Fails at | Outcome |
|---|---|
| Step 1 — Drive upload | Nothing written to the database. The transaction never starts. Upload fails cleanly with a clear message. Implements decision 2. |
| Step 2 — transaction | Rolls back exactly as today. A Drive delete is then attempted for the now-orphaned file. |
| Step 2 cleanup — orphan delete also fails | One unreferenced file remains in the Drive folder. No data loss, no database impact. Logged. The **original** transaction error is what surfaces to the user, not the cleanup error. |
| Step 3 — rename | Row correct, link correct, filename cosmetically provisional. Logged. The request still succeeds — a cosmetic naming failure must not fail an otherwise complete upload. |

Orphaned files are identifiable by the absence of the `<quoteNo> R<rev>` prefix.

### Code touch points

- **`src/server/quotes/service.ts` — `uploadQuotation`.** The sequencing above.
  The primary change.
- **`src/server/quotes/service.ts` — `externalArtifact`.** Currently returns a
  placeholder HTML stub when no blob is present. Replace with a clear error
  directing the user to the Drive link. Without this, the stub becomes reachable
  for every new upload.
- **`src/server/drive/service.ts` — `saveQuotationToDrive`.** Add a guard
  refusing an External quotation that has no stored bytes, so the manual
  "Save to Drive" button can never upload the placeholder stub.
- **`docs/source-appscript/Index.html`.** Expected to need **no change**.
  `mQuoteViewer` already renders "View in Drive" when `driveViewLink` is set
  (line 1930) and already omits the download row when `doc` and `pdf` are both
  empty (line 1924). Setting `pdf: ''` makes the existing conditionals produce
  the wanted result. **To be verified by test, not assumed** — if a change does
  prove necessary, it goes through `scripts/port-legacy-index.mjs`, which now
  carries CRLF normalisation and anchor assertions.

Deliberately untouched: the transaction body, `allocateQuoteRevision`,
`supersedePrevious`, auto-case creation, generated-quotation rendering, the
download route for generated quotations, `cases/`, `customers/`, `dashboard/`,
and every existing migration.

### Database

**No migration.** `drive_file_id`, `drive_view_link`, `drive_saved_at` and
`drive_saved_by` already exist from `0004_quotation_drive_link.sql`.

## Testing

Test-driven throughout — each test is written and seen to fail before the
implementation that satisfies it.

| Test | Asserts |
|---|---|
| `quotes/service.test.ts` — happy path | Drive receives the bytes; the row carries `drive_file_id` and `drive_view_link`; `uploadDataB64` is empty; `pdf` is empty |
| — Drive upload fails | The error propagates; **no quotation row is created**; no case is auto-created |
| — transaction fails after Drive succeeded | A Drive delete is attempted for the orphan |
| — orphan delete also fails | The original transaction error surfaces, not the cleanup error |
| — rename fails after commit | The request still succeeds and the row is intact |
| `drive/service.test.ts` — guard | `saveQuotationToDrive` refuses an External quotation with no stored bytes |
| `legacy-app.test.ts` | The viewer shows "View in Drive" and no download button for an uploaded quotation |
| `tests/e2e` | Upload end to end with a mocked RPC; the failure path re-enables the button with the file still selected |

Every Drive call is mocked at the service boundary, consistent with the existing
`src/server/drive/service.test.ts`. No test contacts the real Google API.

**Baseline that must not regress: 240 vitest and 21 Playwright tests currently
pass.** Any reduction stops the work.

## Rollout

1. Branch from `main`. TDD commits.
2. Local gate, all four must pass: `npm run typecheck`, `npm test`,
   `npm run test:e2e`, `npm run build`.
3. Take a backup with `scripts/backup-database.mjs` before deploying. The free
   tier performs no automatic backups.
4. Deploy.
5. Production verification — one real upload, checking three things: the file
   appears in the Drive folder, the "View in Drive" link opens it, and
   `select count(upload_data) from public.quotations` still returns `0`.

**Rollback:** `git revert` of a single commit. No schema change to undo. The
column still exists, so reverted code simply resumes writing to it.

## Known risks and follow-ups

1. **Drive files live in a personal My Drive, not a Shared Drive.** The folder is
   owned by `testing@automationsystems.org`; the API returns an owner, which
   Shared Drive files do not have. If that account is ever suspended or
   deleted, every quotation link breaks. Accepted for now by decision 5.
   **Recommended follow-up:** create a Workspace Shared Drive and repoint
   `GOOGLE_DRIVE_QUOTATIONS_FOLDER_ID`. Only that one settings value changes.
2. **Drive access requires a Google account in the `automationsystems.org`
   domain**, because files are shared domain-with-link view-only. All three
   current users qualify. Adding a CRM user outside the domain would break
   uploaded-file viewing for them.
3. **Effective upload size limit is smaller than advertised.** The client caps
   uploads at 8 MB, but Vercel's documented serverless request-body limit is
   4.5 MB and base64 inflates a file by 1.33×, putting the real ceiling near
   3.3 MB. Anything larger likely fails today as an opaque `413`. This is
   **pre-existing and unrelated** to this change. To be verified with a real
   large-file upload during implementation and reported; the honest fix is a
   one-line client-side limit change, raised separately rather than widening
   this scope.
4. **`updateQuote` is a read-modify-write over the whole row**
   (`quotes/repository.ts:437`), so it re-reads and rewrites `upload_data` on
   every quotation edit. Once the column is never populated this costs almost
   nothing, so it is deliberately left alone here and is naturally resolved by
   the phase-2 column drop.
5. **The case-list N+1 remains** (`cases/service.ts:623`). Excluded by decision
   6. It becomes the binding constraint at roughly 300–500 cases and needs its
   own plan within months.

## Explicitly out of scope

- Dropping `upload_data` and removing its SQL references — phase 2, its own
  commit and migration.
- The case-list N+1 fix.
- SQL-side filtering and pagination.
- Any change to how generated quotations are produced, rendered or downloaded.
- Changing the upload size limit.
- Migrating the Drive folder to a Shared Drive.
