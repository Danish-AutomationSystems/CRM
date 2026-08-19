# AS CRM Migration Context

Last updated: 2026-08-19 (settings-drift fixed, Drive-first quotation uploads, ticket handover notes, case attachments, optional case priority, admin config module, form placeholders removed)

## Project Purpose

AS CRM is the migrated version of the Automation Systems CRM that previously ran on Google Apps Script. The migration goal is to preserve the existing CRM features and behavior while improving latency, maintainability, security, and deployability by moving to:

- Next.js on Vercel for the app and server routes.
- Supabase Postgres/Auth for database and Google sign-in.
- Server-side RPC handlers that emulate the Apps Script `google.script.run` API surface.

The production app is deployed at:

- https://as-crm-ten.vercel.app

Custom CRM subdomain:

- https://crm.automationsystems.info

The source repository is:

- https://github.com/Danish-AutomationSystems/CRM.git

Active deployment branch:

- `main` (feature work was developed on `migration/vercel-supabase-crm` and merged into `main`)

## Security Rules For Future Agents

- Do not commit raw passwords, service-role keys, database URLs, or OAuth client secrets.
- Raw secrets belong only in Vercel environment variables, Supabase dashboard, Google Cloud dashboard, and local ignored `.env.local` files.
- `CONTEXT.md` intentionally documents secret names, locations, and formats, not raw secret values.
- If a future task requires a secret value, ask the project owner or read it from an authorized local ignored file/environment; never print it in chat or commit it.
- The Google sign-in domain restriction is enforced in both the OAuth request hint and backend auth checks.
- Keep this file updated whenever project setup, deployment state, architecture, environment variable requirements, external service configuration, or important decisions change.

## Current Production Status

Completed:

- Vercel project created under the Automation Systems team: `as-crm`.
- GitHub repository connected to Vercel.
- Production deployment created and aliased to `https://as-crm-ten.vercel.app`.
- Supabase schema migrations applied.
- Initial L6 admin user seeded for the project owner email.
- Local verification passed before deployment:
  - `npm run typecheck`
  - `npm run test`
  - `npm run build`
  - Playwright CRM smoke tests with mocked Supabase
- Deployment smoke checks after production deploy:
  - `/login` returned HTTP 200
  - `/crm` redirected to login for unauthenticated users
- Auto-provision deployment:
  - Commit: `4076fdf feat: auto-provision company users as L1`
  - Vercel deployment: `dpl_5c9DWd2aQkSzdoWSdzH5CLUEwNs4`
  - Production aliases moved to the new deployment, including `https://crm.automationsystems.info`
  - `https://as-crm-ten.vercel.app/login` returned HTTP 200
  - UI Revamp & Modernization (2026-07-30):
  - CSS design system tokens (`--sp-*`, `--fs-*`, `--r-*`, `--shadow-*`, `--brand-lt`, `--brand-glow`).
  - Sticky header with backdrop blur filter (`backdrop-filter: blur(12px)`).
  - Modern responsive mobile layout with hamburger toggle (`.nav-toggle`).
  - Redesigned login page (`/login`) with brand mark icon, diagonal green gradient background, and styled button.
- Performance & Latency Optimizations (2026-07-30):
  - Supabase B-tree and GIN database indexes (`supabase/migrations/0003_performance_indexes.sql`).
  - RPC Gzip/Brotli payload compression headers (`/api/rpc`).
  - Selective SQL query field projection.
  - Client SWR memory caching with automatic write-invalidation (`cacheBustKey`).
  - Generator script (`scripts/port-legacy-index.mjs`) safe DOM helpers (`setHtml`, `setText`) and unmounted DOM error suppression in `oops(e)` to prevent errors during fast route switching.
- Generator CSS Protection:
  - `scripts/port-legacy-index.mjs` writes raw legacy AppsScript CSS to `legacy-full-ui.baseline.css` so that `src/app/crm/legacy-full-ui.css` remains manually maintained and is never overwritten on regeneration.
- CRM Tab URL Routing (2026-07-31):
  - The CRM previously ran the whole authenticated app behind a single `/crm` route. The legacy client switched views (Dashboard/Customers/Cases/Admin/detail views) purely in-memory (`S.route`/`S.routeArg`), never touching `window.location`, so refreshing always reset the user to Dashboard and browser back/forward did nothing.
  - Added `src/app/crm/[[...slug]]/page.tsx`, an optional catch-all route replacing `src/app/crm/page.tsx`, mapping `/crm`, `/crm/customers`, `/crm/customer/:id`, `/crm/cases`, `/crm/case/:id`, `/crm/admin` to an initial `{route, arg}` via `src/app/crm/route-map.ts` (pure, unit-tested slug<->path<->route-state mapping). Unknown slugs fall back to `dash`. No `src/middleware.ts` change was needed - it already prefix-protects `/crm/*`.
  - `src/app/crm/LegacyFullCrmApp.tsx` now syncs the URL from the legacy app's existing `#main[data-route]` attribute (the generator already stamps this on every `S.route=` assignment) via a `MutationObserver`, using raw `window.history.pushState(null, '', path)` - deliberately NOT `next/navigation`'s `router.push`, which would remount the page's client subtree (the catch-all segment value changes) and re-`eval` the ~115KB legacy script on every tab click. Next.js 15 patches `window.history.pushState` itself (`node_modules/next/dist/client/components/app-router.js`) to keep its internal router state in sync, so raw `pushState` is the supported integration point, confirmed by Playwright back/forward tests passing against the real dev server.
  - The record id (`S.routeArg`) for detail views is read directly off the `window.S` global at MutationObserver time (indirect `eval` puts legacy script globals on `window`), never from a new DOM attribute - this kept the legacy artifact untouched at a time when the generator was not yet safe to run (see the 2026-08-11 "legacy generator is fixed" entry below for current status).
  - Handles the async boot race: `init()` always lands on `vDash` first (its render `.then` has no route guard, unlike the other views), so a deep-linked initial route is restored via a one-shot flag consumed on the first `data-route` mutation, deferred to a `setTimeout(0)` macrotask so it runs after `vDash`'s render and isn't clobbered.
  - Role-hidden tabs (e.g. an L1 user deep-linking `/crm/cases`, whose nav button is `display:none`): silently falls back to the dashboard and rewrites the URL to `/crm` via `replaceState` (not `pushState`), so Back still exits the CRM cleanly. Server-side RPC authorization remains the actual security boundary; this is UX-only.
  - Tests: `src/app/crm/route-map.test.ts` (pure mapping + round-trip), `src/app/crm/legacy-app.test.ts` `describe('tab URL sync', ...)` (boot-race, popstate, hidden-tab fallback, clean unmount), `tests/e2e/crm-smoke.spec.ts` (nav click updates URL without remounting via a `window.__mountProbe` sentinel, refresh restores the exact view, cold deep link, back/forward, unauthenticated deep links preserve `next=`).
  - Design doc: `docs/superpowers/specs/2026-07-31-crm-tab-routing-design.md`.
- Mobile Nav Drawer Fix (2026-07-31):
  - Real-device report (Android Chrome, `crm.automationsystems.info`): opening the mobile hamburger nav on `/crm/cases` showed the user-info chip and the Dashboard/Customers/Cases/Admin buttons side by side in two narrow columns instead of the nav stacking full-width below the header, wasting most of the screen.
  - Root cause in `src/app/crm/legacy-full-ui.css`: the mobile `nav.nav-open` rule set `width:100%` but `nav`'s base (desktop) rule sets `flex:1`, whose `flex-basis:0%` takes priority over `width` for main-axis sizing in a flex row. So `nav` only grew to fill the leftover space next to `.uchip` on the same line instead of being forced onto its own row. Fixed by adding `flex:0 0 100%` alongside `width:100%` in the mobile rule.
  - Also widened the hamburger-drawer breakpoint from `max-width:720px` to a dedicated `max-width:900px` media query (kept separate from the phone-only content rules - 2-column stat grid, smaller `h1`, full-screen modals - which stay at 720px). Below 900px the desktop nav was wrapping an orphaned last button onto its own line, which visibly broke on common tablet-portrait widths like iPad (768-834px logical px); above 1024px the desktop nav fits on one line cleanly.
  - Verified with real Playwright screenshots (not just DOM assertions) across 360-1440px viewport widths on both Dashboard and Cases, confirming no horizontal page overflow and the drawer spans the full header width when open.
  - Regression coverage added to `tests/e2e/crm-smoke.spec.ts`: `the collapsed nav drawer spans the full header width on ...` at phone (390x844) and tablet-portrait (768x1024) widths, asserting `#nav`'s bounding-box width against `.hwrap`'s and checking for zero horizontal document overflow.
  - No `ui-ux-pro-max`/`ui-styling` skill exists in the current tool environment despite being referenced by earlier CONTEXT.md UI-revamp entries; this fix was done via direct CSS diagnosis and Playwright visual verification.
- Mobile Header Redesign (2026-07-31, follow-up to the nav drawer fix above):
  - Second real-device report: even after the drawer fix, the hamburger toggle sat to the right of the "AS CRM" title (DOM order is brand, then the generator-injected `.nav-toggle`, then `nav`, then `.uchip`, none with an explicit `order` before this change) - not the conventional leading-left position - and the user-info chip (name + email + role badge) wrapped onto its own left-aligned row below, wasting vertical space before any content was visible.
  - `src/app/crm/legacy-full-ui.css`, inside the `@media(max-width:900px)` block: `.nav-toggle{order:-1}` moves the toggle to lead the header row (left of the brand mark/title). `.brand small` (the "Automation Systems NG" tagline) and `.umail` (email) are hidden on mobile to shrink content so toggle + brand + a compact `uname`+`rolebadge` chip all fit on a single row, with `.uchip` kept at `margin-left:auto` (previously zeroed, which is what caused it to left-align on its own wrapped row) so it stays pinned to the right like the desktop layout.
  - Verified via Playwright computed-style inspection that `.nav-toggle` truly has `background:transparent`/no border (confirming its icon is a plain, unstyled glyph, not an actual duplicate "box" next to the brand mark) and via screenshots at 360/390/412/480/768px that toggle, brand, and the compact user chip render on one row with no horizontal overflow.
  - Regression coverage extended in the same `tests/e2e/crm-smoke.spec.ts` nav-drawer tests: asserts the toggle's bounding box sits left of and on the same row as `.brand` and `.uchip`, in addition to the existing full-width-drawer-when-open and zero-horizontal-overflow checks.
- Customer/Contact Save Cache Bug + Table Overflow Fix (2026-07-31):
  - **Bug 1 - saves not reflecting instantly.** Real-user report: editing a customer's details/contacts and saving did not update the on-screen detail view until a hard page refresh. Root cause: the legacy client (`docs/source-appscript/Index.html`) has TWO separate caching layers - the new `SWR_CACHE` (added 2026-07-30, keyed by RPC call, purged by `cacheBustKey(fn)`), and an older, entirely separate `CACHE` object (`CACHE.customers/cases/cust/kase`) that `vCustomer()`/`vCase()`/`vDash()` use for their own 90-second (`FRESH_MS`) stale-while-revalidate render - if a cached detail entry is "fresh," the view renders it immediately and skips the network call entirely. The **original** Apps Script `gs()` called `cacheBust()` (a full clear of that older `CACHE` object) on every write; the 2026-07-30 SWR migration fully replaced that `gs()` and never carried `cacheBust()` over, so `CACHE.cust`/`CACHE.kase` silently stopped being invalidated on writes.
  - Fix: `scripts/port-legacy-index.mjs`'s injected `rpcGs` now calls `cacheBustKey(fn); cacheBust();` (both) on every write, restoring the original invalidation behavior alongside the newer selective SWR purge. At the time this fix shipped (2026-07-31) the generator could not yet be run end-to-end (see the historical frozen-artifact note, since resolved 2026-08-11 - see the Architecture Overview's "legacy generator is fixed" section), so the identical one-line change (`else { cacheBustKey(fn); cacheBust(); }`) was also hand-applied directly to the committed `src/app/crm/legacy-full.generated.ts` as a one-off. That hand-patch workflow is no longer how this file should be edited; see the 2026-08-11 entry.
  - Regression test: `src/app/crm/legacy-app.test.ts` `describe('client-side cache invalidation after writes', ...)` and the e2e test `editing a customer reflects the change immediately, without a manual reload` in `tests/e2e/crm-smoke.spec.ts`.
  - **Bug 2 - customer/case detail pages needed pinch-zoom-out on mobile ("weird view").** Root cause: `.table-scroll` (a horizontal-scroll CSS class added during the 2026-07-30 UI revamp specifically for wide tables) was never actually applied to any `<table>` in the legacy markup - confirmed zero usages via `grep -n "table-scroll" docs/source-appscript/Index.html`. Any table whose content didn't fit its card (e.g. the customer-detail Cases table's `owners`/`assignee` email columns) had nowhere to overflow, so it blew out its card, `#main`, `body`, and `<html>` to its own intrinsic width - reproduced and measured directly: `document.documentElement.scrollWidth` was 888px against a 412px viewport. The Customers grid table was unaffected because it already has its own ad-hoc `<div style="overflow-x:auto">` wrapper in the source markup; no other table does.
  - Fix (CSS-only, no markup changes needed, fixes every table in the app at once): `src/app/crm/legacy-full-ui.css`'s base `table` rule now sets `display:block;overflow-x:auto;-webkit-overflow-scrolling:touch` in addition to its existing `width:100%`, so any table scrolls its own overflow internally instead of widening its ancestors.
  - Regression tests in `tests/e2e/crm-smoke.spec.ts`: `the customer detail page does not overflow the mobile viewport` and `the cases list table does not overflow the mobile viewport`, both asserting `document.documentElement.scrollWidth === clientWidth` at phone widths.
  - Not yet audited: forms/modals other than the customer edit modal (already spot-checked, no overflow) - if further "weird view" reports come in for a specific screen (bulk-add, quote builder/invoice, admin tables), reproduce with the same technique (real Playwright viewport + `document.documentElement.scrollWidth` vs `clientWidth`, walking `#main *` for the widest offending element) before guessing at a fix.
- Google Drive Quotation Save (2026-07-31):
  - New module `src/server/drive/`: `client.ts` (`createDriveClient()` - validates `GOOGLE_DRIVE_CLIENT_ID`/`GOOGLE_DRIVE_CLIENT_SECRET`/`GOOGLE_DRIVE_REFRESH_TOKEN` eagerly and synchronously, then returns an `uploadFile()` method using the `googleapis` Drive API v3, sets domain-shared read access, and tolerates permission-sharing failures), `folder.ts` (`getDriveFolderId()` - reads the target Drive folder ID from `public.settings` key `GOOGLE_DRIVE_QUOTATIONS_FOLDER_ID`), and `service.ts` (`createDriveService()` - orchestrates `saveQuotationToDrive`, reusing the existing `quoteService.getDownloadArtifact()` for artifact bytes). `service.ts` takes `getDriveClient: () => DriveClient` as a lazy factory specifically so RPC registration doesn't crash at import time in environments without Drive credentials configured yet - this was a real bug caught and fixed during implementation, not a stylistic choice.
  - DB migration `supabase/migrations/0004_quotation_drive_link.sql` adds `quotations.drive_file_id`, `drive_view_link` (both `text not null default ''`), `drive_saved_at` (nullable `timestamptz`), and `drive_saved_by` (nullable `text`, FK to `public.users(email)`).
  - New RPC `api_saveQuotationToDrive(quoteNo, rev)`, registered in `src/server/quotes/rpc.ts` with `{ read: false }`.
  - Drive filename convention: for Generated-source quotes, the Drive filename is the artifact's own filename verbatim (`safeQuoteFileName` already embeds quote number/rev/customer name); for External/uploaded quotes, the filename is wrapped as `<quoteNo> R<rev> - <customerName> - <fileName>`, matching the legacy Apps Script convention. This branches on `quote.source` - added during implementation after a reviewer caught that a single naive wrapping approach double-duplicated quote metadata in Generated-quote filenames.
  - New admin-only, self-disabling one-time setup routes: `src/app/api/admin/drive-setup/start/route.ts` (redirects to Google's OAuth consent screen, scope `drive.file`) and `src/app/api/admin/drive-setup/callback/route.ts` (exchanges the code for a refresh token, creates the `AS CRM Quotations Testing` Drive folder, stores its ID in `public.settings` under key `GOOGLE_DRIVE_QUOTATIONS_FOLDER_ID`, and displays the refresh token once in the admin's own browser to copy into Vercel - the app never stores or logs it). Both routes refuse to run if `GOOGLE_DRIVE_REFRESH_TOKEN` is already set, and require an authenticated L6 admin session (`getRequestContext` + `ensureAdmin`) before touching Google or the database. `src/middleware.ts`'s `PROTECTED_PREFIXES` now includes `/api/admin`.
  - UI: the legacy quote-viewer modal (`docs/source-appscript/Index.html`'s `mQuoteViewer`, and the corresponding `src/app/crm/legacy-full.generated.ts`, hand-patched at the time per the then-frozen-artifact workaround, since resolved 2026-08-11) shows a "Save to Drive" button that becomes a "View in Drive" link once `quote.driveViewLink` is set.
  - Credentials: `GOOGLE_DRIVE_CLIENT_ID` and `GOOGLE_DRIVE_CLIENT_SECRET` are already set in both `.env.local` (local dev) and Vercel production env vars. The Google Cloud OAuth client `AS-CRM-DRIVE` was created with both `https://as-crm-ten.vercel.app/api/admin/drive-setup/callback` and `https://crm.automationsystems.info/api/admin/drive-setup/callback` registered as authorized redirect URIs. `GOOGLE_DRIVE_REFRESH_TOKEN` was set and the one-time setup was completed and verified live in production later the same day (2026-07-31) - see the entry below. (Correction: this entry originally said the token had not been set yet; superseded almost immediately, kept here only for history.)
  - Deferred, not built at the time of this entry: "full legacy revival" - real Google Doc templates, Docs API merge-fill, and Drive-native PDF export - see the Full Legacy Quotation Template Revival entry below, which builds exactly this.
- Full Legacy Quotation Template Revival (2026-07-31, follow-up to the Drive save feature above):
  - New pure modules in `src/server/drive/`: `template-merge.ts` (`buildMergeFieldRequests`, `locateMarker`, `buildStructureRequests`, `collectTables`, `buildCellFillRequests` - zero imports, zero I/O, operate on plain Docs API JSON shapes, fully unit-tested against hand-built fixtures) and `docs.ts` (`createDocsClient()` - the only place touching the real Docs API `documents.get`/`documents.batchUpdate`, dynamic `googleapis` import like `client.ts`). `client.ts` gained `listDocsInFolder`, `copyFile`, `exportPdf`, `shareDomainReadable`, all routed through one internal `driveApi()` helper so there is exactly one place constructing the Drive handle. `template-folder.ts` mirrors `folder.ts`, reading `GOOGLE_DRIVE_TEMPLATES_FOLDER_ID` from `public.settings`.
  - **Docs API `batchUpdate` index rules** (the non-obvious knowledge a future maintainer needs - all four encoded directly in `template-merge.ts`'s implementation and tests):
    1. Requests in one `batchUpdate` call apply sequentially, and every insertion shifts all later indices in the *same* document.
    2. To place several items in reading order at one shared index (e.g. filling where a deleted marker stood), insert them in **reverse** order - each insert pushes earlier-inserted content further down, so the last request emitted ends up first in the document.
    3. `insertTable` does not return per-cell indices in its `batchUpdate` reply - a second `documents.get()` is the documented, reliable way to discover them (`table.tableRows[].tableCells[].content[].startIndex`).
    4. When filling many cells discovered from one `documents.get()` snapshot, write them in **descending** index order - writing a low index first would invalidate every higher index captured in the same snapshot.
  - `listTemplates()` (`src/server/quotes/service.ts`/`repository.ts`) no longer reads the flat `QUOTE_TEMPLATES` settings row (removed entirely) - it now calls `DriveClient.listDocsInFolder()` against the real `AS CRM Templates Testing` Drive folder (settings key `GOOGLE_DRIVE_TEMPLATES_FOLDER_ID`, created and seeded with a starter template Doc during the one-time OAuth setup). `createQuoteService(repo, deps?)` gained an optional `QuoteServiceDeps` second parameter (`listTemplates`, `getDriveClient`, `getDocsClient`, `getQuotationsFolderId`) so the service stays fakeable in tests without a real Drive/Docs client.
  - `generateQuoteDoc` is fully real now (previously a placeholder pointing `doc`/`pdf` at the same local HTML download URL used elsewhere): copies the selected template into the Quotations folder, merge-fills every legacy placeholder (`{{QUOTE_NO}}`, `{{CUSTOMER_NAME}}`, `{{CONTACT_NAME}}`, `{{TOTAL}}`, etc.) via `replaceAllText`, locates `{{BOQ_TABLE}}`, deletes it and inserts the BOQ + totals tables, re-fetches the document to discover the new cells' real indices, fills them, exports the merged Doc to PDF via Drive's native `files.export` (no external rendering engine, exactly like legacy's `getAs('application/pdf')`), uploads and domain-shares the PDF, and records both real `webViewLink`s on the quote row.
  - `QuoteRepository.listContacts(customerId)` added (mirrors the customers repository's existing contact query) so the merge pass can fill `{{CONTACT_NAME}}` with the customer's first contact, formatted `"<name> (<designation>)"`.
  - Error messages from the new guards (no template selected, template has no `{{BOQ_TABLE}}` placeholder, quote was uploaded as an external file) are now user-facing 400s instead of opaque 500s - `src/server/rpc/errors.ts`'s `USER_FACING_PATTERNS` gained `/template/i`, `/placeholder/i`, `/external file/i`.
  - UI: "Save to Drive" is now hidden in the quote viewer (`mQuoteViewer`, both `Index.html` and the hand-patched generated artifact) for *generated* quotes whose `doc`/`pdf` already point at `drive.google.com` (new `driveHosted(q)` helper) - `generateQuoteDoc` itself now creates the Doc+PDF directly in Drive as a side effect of generation, so a separate save step would just duplicate the file. Unchanged for *uploaded* (external) quotes, which still need the explicit save step.
  - OAuth scope change (breaking): the Docs API needs `https://www.googleapis.com/auth/documents` in addition to the existing `drive.file` scope. A refresh token's granted scopes are fixed at consent time, so the existing `GOOGLE_DRIVE_REFRESH_TOKEN` cannot be upgraded in place - see Pending/manual below, this is the one manual step still required to make the feature live.
  - While recovering this feature's Wave-1 parallel implementation tasks after several hit an unrelated session rate limit mid-task, found and fixed a real drift bug unrelated to this plan: `docs/source-appscript/Index.html` (the source of truth for the legacy client, regenerated via `scripts/port-legacy-index.mjs` since 2026-08-11) had fallen out of sync with the deployed `legacy-full.generated.ts` for the quote-viewer's document/PDF button and link text (`Index.html` said "Open Google Doc"/"Generate Doc + PDF"; the deployed artifact actually said "Download document"/"Generate download"). Fixed `Index.html` to match reality - no runtime behavior change. Also noted but deliberately left unfixed (separate, larger, pre-existing issue): `Index.html` is missing the `jsArg()` JS-string-escaping helper that the generated artifact already uses at several `onclick` sites (`Index.html` still uses the older `esc()` there) - worth a dedicated follow-up pass auditing every escaped inline-handler call site.
  - Design doc: `docs/superpowers/specs/2026-07-31-google-docs-template-revival-design.md`. Plan: `docs/superpowers/plans/2026-07-31-google-docs-template-revival.md`.

- CRM Points-Manager Feedback: case-ownership re-architecture and related fixes (2026-08-11):
  - **Case ownership is now materialised on the case, not derived from `handlers` at read time.** Each case stores its own owner set in `cases.extra_owners` (a pipe-joined `text` column; parsed/joined via `parsePipe`/`joinPipe`). `caseOwners(caseRecord: CaseRecord)` in `src/server/auth/access.ts` now takes **no ownership argument** - it reads `caseRecord.extraOwners` directly, falling back to the case's creator (`caseRecord.owner`, excluding `direct`) only when nothing is stored. The old `caseHandlerOwners()` function that derived owners from `public.handlers` at read time no longer exists (its logic survives only as a frozen, explicitly-labeled reference copy in `src/server/cases/owner-seed.ts`, used solely to compute the one-time migration backfill).
  - Practical effect of the re-architecture: adding a handler to a customer propagates that handler onto the customer's **ACTIVE** cases only (not closed ones); removing a handler from a customer **never** touches any case - previously, removing a handler silently stripped that person from every case on the account, including closed ones, with no way to recover it.
  - Every case owner entry now carries an explicit `source: 'handler' | 'creator' | 'manual'` (`CaseOwnerSource`/`CaseOwnerEntry` in `src/server/auth/access.ts`, `caseOwnerSource()`/`caseOwnerEntries()`). Handler-sourced owners are non-removable from the case UI (removal happens on the customer instead); creator/manual owners are removable unless doing so would leave the case with zero owners.
  - `customerRealHandlers()` (formerly folded into the same function as ownership derivation) now answers only "is this person an account handler" and is explicitly documented as unrelated to case ownership - keeping the two concerns separate is what fixes the underlying bug class.
  - **L5/L6 users may no longer be added as account handlers** (enforced in `customers/service.ts`'s `addHandler`, with a comment: "an L5/L6 bulk-importer does not become a handler"). They remain valid as case owners/assignees directly - this restriction is handler-only.
  - **`Direct` is a virtual account** (`src/server/domain/direct.ts`, `DIRECT_EMAIL='direct'`, `isDirect()`, `directVirtualUser()`): never a row in `public.users` (the table has a CHECK constraint requiring an `@automationsystems.org` address), only ever stored as `public.handlers.user_email='direct'`, and synthesised into user lists and the L4+ dashboard subject picker (`DIRECT_VISIBLE_FROM_LEVEL=4`) at read time. It can never hold a support ticket (case owner/assignee) or log in (`hasLogin: false`).
  - **At least one location (`customers.tags`) is now mandatory** on customer create/update. Existing customers with no location were backfilled to the placeholder `'TO BE FILLED'` (migration `0007`), which is a recognised value (present in `DEFAULT_SETTINGS.TAGS`) but deliberately excluded from `SELECTABLE_TAGS` so nobody can pick it on purpose and a later save can't silently strip a location back to empty.
  - **`customers.sei` changed from free text to `text[]`** (migration `0008`), multi-select, validated against a **live** `public.settings.SEI_NAMES` list (split on `\s*[|,]\s*`, parsed by `parseSeiText()` in `src/server/customers/sei.ts`; the same key is read live at request time by `customers/service.ts` via `SEI_NAMES_SETTING_KEY`, not from the hardcoded `DEFAULT_SETTINGS` - see the `public.settings` drift note below, which this partially resolves). `public.recycle_bin.sei` was converted too since `restoreCustomer()` copies it straight back onto `public.customers`. The migration seeds `SEI_NAMES` empty; an L6 populates it in Admin.
  - **`api_listCases` gained `owned`/`assigned` filters** (`src/server/cases/rpc.ts`/`service.ts`): `owned` (also accepting the legacy `mine` flag for backward compatibility with in-flight old clients) and `assigned` narrow the case list; neither set returns all cases the caller can see.
  - Four new DB migrations ship this work, in strict order:
    - `0005_materialise_case_owners.sql` - seeds `cases.extra_owners` with exactly the set the old read-time derivation would have produced (reference implementation `src/server/cases/owner-seed.ts`), so behavior is unchanged on the day it ships. Re-verifies every case against the frozen old-derivation logic before committing, aborting on any mismatch.
    - `0006_remove_l5_l6_handlers.sql` - deletes existing L5/L6 handler rows. **MUST run after `0005`** - under the old model, deleting a handler row would have silently stripped that person from every case (including closed ones); with `0005` already applied, case ownership is materialised, so this migration is inert with respect to `public.cases` (a check inside the migration asserts it writes zero rows there).
    - `0007_backfill_customer_locations.sql` - backfills empty `customers.tags` to `['TO BE FILLED']`, asserts row count and empty-count invariants.
    - `0008_customer_sei_multi_select.sql` - converts `customers.sei` (and `recycle_bin.sei`) from `text` to `text[]`, drops the old btree index first (recreate if needed), seeds `SEI_NAMES` empty in `public.settings`.
    - All four (`0005`-`0008`) are applied in every environment, including production. See the Supabase Migrations section below for the full, current, applied list (now through `0011`).
  - New docs from this pass: `docs/role-matrix.md`, `docs/security-audit.md`, `docs/scalability-and-storage.md`.
  - Design doc: `docs/superpowers/specs/2026-08-11-crm-points-manager-feedback-design.md`.

- Drive-first quotation upload (2026-08-13, commit `ffa5678`):
  - Uploaded quotation files (as opposed to generated ones, which already went to Drive) used to be written straight into Postgres as `quotations.upload_data bytea`, capped at ~8 MB. A scalability audit (`docs/scalability-and-storage.md`, spec `docs/superpowers/specs/2026-08-13-quotation-drive-first-upload-design.md`) measured stored files at roughly 40x the storage cost of every other CRM record combined, putting Supabase Free's 500 MB ceiling within reach at only 5-8 active users.
  - `uploadQuotation` (`src/server/quotes/service.ts`) now uploads straight to Google Drive via `deps.getDriveClient()`/`deps.getQuotationsFolderId()` and writes `uploadDataB64: ''` on the created row - no bytes ever reach Postgres for a new upload. It throws a user-facing error if Drive is not configured, rather than silently falling back to the DB.
  - `quotations.upload_data`/`upload_mime_type` **still exist** and are still read (`src/server/quotes/repository.ts`'s `getQuote`, `encode(upload_data, 'base64')`) so any file uploaded before this change remains downloadable. Do not treat the column as dead - it is legacy-read-only, not removed.

- Ticket handover notes (2026-08-14, commit `e44a342`):
  - Reassigning a case can carry an optional internal note, stored on `activity_log.note` (migration `0009_activity_log_note.sql`, `text not null default ''`). Written only by `src/server/cases/repository.ts`'s `logActivity`; the other three `logActivity` call sites (customers, quotes, admin) don't touch the column.
  - Design: `docs/superpowers/specs/2026-08-14-ticket-handover-notes-design.md`.

- Case-list customer batching (2026-08-14, `51fd057`):
  - `listCases` no longer issues one `getCustomer` call per case. `src/server/cases/service.ts` now collects every needed customer id and calls `repo.getCustomersByIds(ids)` once, the same pattern already applied to `recentActivity()` on 2026-08-11. This closes the "still outstanding" N+1 item recorded in the 2026-08-11 latency notes - see the Known Live Latency section below, which has been corrected.
  - Design: `docs/superpowers/specs/2026-08-14-case-list-batch-customers-design.md`.

- Case attachments (2026-08-14, `cecce07`):
  - A ticket handover response can attach documents. Files live in Google Drive; only metadata is stored in the new `public.case_attachments` table (migration `0010_case_attachments.sql`): `activity_id` (FK to `activity_log`, cascade-deletes), `case_id`, `drive_file_id` (unique - one row per Drive file, enforced by the DB so two concurrent reassignments can't both claim the same file), `drive_view_link`, `file_name`, `mime_type`, `size_bytes`, `uploaded_by`. RLS denies all direct client access, same pattern as other tables.
  - `scripts/` gained a reaper for abandoned Drive uploads (attachments uploaded to Drive but never committed to a case) and a backup/restore path for `case_attachments`.
  - Design: `docs/superpowers/specs/2026-08-14-case-attachments-design.md`.

- Optional case priority (2026-08-18, merge commit `459f924`):
  - Cases can now carry a priority (High/Medium/Low, or `''` for not set), mirroring `customers.priority`'s existing shape. `cases.priority text not null default ''` (migration `0011_case_priority.sql`). Deliberately **no** database CHECK constraint - same reasoning as `customers.priority`: an L6 admin can edit the `PRIORITIES` list in Admin, and a DB constraint would start rejecting saves the UI itself offers. Validation is server-side only, via `validOne(input, live.priorities)`.
  - New RPC `api_setCasePriority`, logged as `CASE_PRIORITY`. Priority can also be set at case creation. Carried through both dashboard case lists and the customer-detail case payload.
  - The priority filter on the Cases tab is applied in JavaScript inside `listCases`, not pushed into SQL, so no index was added on the column - a later migration should add one if that filtering ever moves into SQL.
  - Design: `docs/superpowers/specs/2026-08-18-case-priority-design.md`.

- Admin config module and placeholder removal (2026-08-19, merge commit `d1205d4`, this branch):
  - The settings-drift bug (see the corrected "Known Issue" section below, now fixed) and a full admin config module (add/rename/delete individual config items, propagated everywhere they're referenced) shipped together. See "What The Admin Config Module Needs A Future Maintainer To Know" below for the load-bearing details.
  - Every form placeholder (`placeholder="..."` ghost text) was removed from the legacy client (`ec2bfcb`) as a separate, smaller change bundled into the same merge.
  - Design: `docs/superpowers/specs/2026-08-18-admin-config-module-design.md`, `docs/superpowers/specs/2026-08-18-form-placeholder-removal-design.md`.

### Resolved: the legacy generator is fixed and back in normal use (2026-08-11)

- The frozen-artifact workaround described in earlier revisions of this section is **no longer in effect**. `scripts/port-legacy-index.mjs`'s `el(x).innerHTML = EXPR;` / `el(x).textContent = EXPR;` -> `setHtml(...)`/`setText(...)` rewrite (now extracted into `scripts/lib/dom-assignment-transform.mjs`, `findStatementEnd`/`rewriteDomAssignments`) now correctly tracks string literals, template literals with `${}` interpolation, regex literals, comments, and bracket/paren nesting to find a statement's true terminating `;`, instead of naively stopping at the first `;`. 16 unit tests in `scripts/lib/dom-assignment-transform.test.mjs` cover CSS strings containing `;`, template-literal interpolation, nested callback bodies, regex literals, and comments.
- A second, separate latent bug was found and fixed in the same pass: the DOM-assignment rewrite was running *before* a later literal full-statement substitution in `port-legacy-index.mjs`, so that substitution's search pattern silently stopped matching (a no-op `String.replace`) once the DOM rewrite had already changed the text it was looking for. The DOM-assignment rewrite now runs **last** in the pipeline (see the comments around `rewriteDomAssignments(script)` in `scripts/port-legacy-index.mjs`), so every earlier literal substitution still matches untouched source text.
- `src/app/crm/legacy-app.test.ts` now has a permanent guard test asserting `expect(() => new Function(legacyAppScript)).not.toThrow()`, so a future regression in the generator's expression scanning fails CI instead of silently shipping invalid JS.
- **The correct workflow is now:** edit `docs/source-appscript/Index.html` (the source of truth), run `node scripts/port-legacy-index.mjs` to regenerate `src/app/crm/legacy-full.generated.ts`, then verify with `npm run typecheck`/`npm run test`/`npm run build` as usual. Do **not** hand-patch `legacy-full.generated.ts` directly anymore - that was a workaround for the now-fixed generator bug, not a standing rule. `src/app/crm/legacy-full-ui.css` remains hand-maintained by design (unrelated to this fix); the generator only ever writes the reference copy to `legacy-full-ui.baseline.css` and never touches the hand-maintained CSS file.
- Separately useful invariant, unaffected by this fix: the artifact emits `S.route='case'; setRouteAttr('case'); S.routeArg=id; setTab('cases');` - i.e. `setRouteAttr` (which stamps `data-route`) fires *before* `S.routeArg` is assigned. Reading `S.routeArg` is only safe from a `MutationObserver` callback (a microtask, so it runs after the full synchronous statement list), never synchronously right after observing the attribute change.
- Design doc: `docs/superpowers/specs/2026-08-11-crm-points-manager-feedback-design.md`.

Pending/manual:

- Google provider has been enabled in Supabase Auth.
- Google Cloud OAuth Client ID and Client Secret have been pasted into Supabase.
- Supabase URL Configuration has been updated for the CRM subdomain.
- Google OAuth client `AS-WEBAPP` has been updated for the CRM subdomain.
- Real Google sign-in must be tested on `https://crm.automationsystems.info/login`.
- If Google login redirects to `http://localhost:3000/?code=...`, Supabase Auth URL Configuration is still using localhost as Site URL or is missing the production callback URL.
- Custom CRM subdomain DNS is verified in Vercel.
- The Google Drive OAuth refresh token must be **regenerated** now that the Docs API scope (`https://www.googleapis.com/auth/documents`) has been added alongside the existing `drive.file` scope - the currently-live `GOOGLE_DRIVE_REFRESH_TOKEN` predates this and lacks it, so `generateQuoteDoc` will fail with a "not configured" error until this is redone. Steps: delete `GOOGLE_DRIVE_REFRESH_TOKEN` from Vercel env vars, redeploy, sign in as an L6 admin at `https://crm.automationsystems.info/api/admin/drive-setup/start`, approve the consent screen as `testing@automationsystems.org`, copy the newly printed refresh token into Vercel, redeploy again. This also recreates both Drive folders (Quotations and Templates) and reseeds the starter template Doc - any templates added to the old Templates folder in the meantime would need to be re-added to the new one.

## Architecture Overview

### App Router

- `src/app/login/page.tsx`
  - Client-side Google sign-in button.
  - Uses `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`.
  - Calls Supabase OAuth with `provider: 'google'`.
  - Sends `hd=automationsystems.org` as a Google hosted-domain hint.

- `src/app/auth/callback/route.ts`
  - Handles Supabase OAuth callback and session exchange.

- `src/app/crm/[[...slug]]/page.tsx`
  - Protected CRM route, an optional catch-all so `/crm`, `/crm/customers`, `/crm/customer/:id`, `/crm/cases`, `/crm/case/:id`, and `/crm/admin` all resolve here.
  - Imports the migrated full legacy CRM UI CSS.
  - Maps `params.slug` to an initial `{route, arg}` via `src/app/crm/route-map.ts` and passes it into `CrmApp`/`LegacyFullCrmApp` so a refresh or deep link restores the correct tab instead of always landing on Dashboard.

- `src/app/crm/route-map.ts`
  - Pure, unit-tested slug <-> URL path <-> legacy `{route, arg}` mapping used by both the server page and the client wrapper.

- `src/app/api/rpc/route.ts`
  - Server-side RPC endpoint.
  - Receives `{ fn, args }`.
  - Gets authenticated request context.
  - Dispatches to registered server RPC functions.

- `src/app/api/download/quote/[quoteNo]/[rev]/route.ts`
  - Downloads generated or uploaded quotation/invoice related files.

### Legacy UI Port

- `src/app/crm/LegacyFullCrmApp.tsx`
  - Mounts the migrated Apps Script UI behavior into React.

- `src/app/crm/legacy-full.generated.ts`
  - Generated/ported legacy client code from Apps Script `Index.html`.

- `src/app/crm/legacy-full-ui.css`
  - Full legacy UI CSS.

- `scripts/port-legacy-index.mjs`
  - Rebuilds the generated legacy client from source Apps Script HTML when needed.

Source Apps Script files are stored under:

- `docs/source-appscript/Code.gs`
- `docs/source-appscript/Index.html`
- `docs/source-appscript/AS_CRM_FUNCTIONALITIES.md`
- `docs/source-appscript/AS_CRM_PROJECT_CONTEXT.md`
- `docs/source-appscript/SETUP_GUIDE.md`

### Server Domains

- `src/server/auth/*`
  - Supabase auth helpers, access/domain checks, user context.

- `src/server/db/*`
  - Postgres client, schema helpers, ID helpers.

- `src/server/rpc/*`
  - RPC registry, parity checks, normalized RPC errors.

- `src/server/customers/*`
  - Customer repository, service, RPC handlers.

- `src/server/cases/*`
  - Case repository, service, RPC handlers.

- `src/server/quotes/*`
  - Quotation repository, rendering, service, RPC handlers.
  - External quotation uploads store original bytes and MIME type.

- `src/server/dashboard/*`
  - Dashboard aggregations and RPC handlers.

- `src/server/admin/*`
  - Admin/settings/user-management services and RPC handlers.

- `src/server/settings/defaults.ts`
  - Default company/config values.

## Supabase

Project URL:

- `https://cympxjsqetzivwxwbhob.supabase.co`

Project ref:

- `cympxjsqetzivwxwbhob`

Data API base:

- `https://cympxjsqetzivwxwbhob.supabase.co/rest/v1/`

Database:

- Database name: `postgres`
- User: `postgres.cympxjsqetzivwxwbhob`
- Transaction pooler host: `aws-0-ap-northeast-1.pooler.supabase.com`
- Transaction pooler port: `6543`
- Session pooler host: `aws-0-ap-northeast-1.pooler.supabase.com`
- Session pooler port: `5432`

Prefer the transaction pooler in serverless/Vercel:

```text
postgresql://postgres.cympxjsqetzivwxwbhob:<PASSWORD>@aws-0-ap-northeast-1.pooler.supabase.com:6543/postgres?sslmode=require
```

Migrations:

- `supabase/migrations/0001_initial_schema.sql`
- `supabase/migrations/0002_external_quote_upload_data.sql`
- `supabase/migrations/0003_performance_indexes.sql`
- `supabase/migrations/0004_quotation_drive_link.sql`
- `supabase/migrations/0005_materialise_case_owners.sql` - seeds `cases.extra_owners`. **MUST run before `0006`.**
- `supabase/migrations/0006_remove_l5_l6_handlers.sql` - deletes L5/L6 handler rows; depends on `0005` having already materialised case ownership.
- `supabase/migrations/0007_backfill_customer_locations.sql` - backfills empty `customers.tags` to `['TO BE FILLED']`.
- `supabase/migrations/0008_customer_sei_multi_select.sql` - converts `customers.sei`/`recycle_bin.sei` from `text` to `text[]`, seeds `SEI_NAMES` empty.
- `supabase/migrations/0009_activity_log_note.sql` - adds `activity_log.note text not null default ''` for ticket handover notes.
- `supabase/migrations/0010_case_attachments.sql` - creates `public.case_attachments` for handover-note Drive attachments.
- `supabase/migrations/0011_case_priority.sql` - adds `cases.priority text not null default ''`.
- **All 11 migrations are applied in every environment, including production.** `public.schema_migrations` currently holds 11 rows. Verify with `scripts/apply-migrations.mjs` (or a direct `select count(*) from public.schema_migrations`) before assuming otherwise - do not trust a stale count in this file.

Migration helper:

- `scripts/apply-migrations.mjs`

Admin seed helper:

- `scripts/seed-admin.mjs`

Important schema note:

- `quotations.upload_data`/`upload_mime_type` are **no longer how a new uploaded quotation is stored** (changed 2026-08-13, `docs/superpowers/specs/2026-08-13-quotation-drive-first-upload-design.md`). A new upload goes straight to Google Drive (`uploadQuotation` in `src/server/quotes/service.ts`) and the created row's `uploadDataB64` is written empty. The columns still exist and are still read (`src/server/quotes/repository.ts`'s `getQuote`) purely so any file uploaded before this change stays downloadable - do not remove them, and do not assume a new upload will ever populate them again.

## Vercel

Vercel team:

- Automation Systems

Vercel project:

- `as-crm`

Production alias:

- `https://as-crm-ten.vercel.app`

Custom domain attached to the Vercel project:

- `crm.automationsystems.info`

GoDaddy DNS is used because nameservers are still GoDaddy (`ns25.domaincontrol.com`, `ns26.domaincontrol.com`).

GoDaddy DNS record configured for Vercel:

```text
Type: CNAME
Name: crm
Value: 7633a7ffb603e0b3.vercel-dns-017.com
TTL: default / 1 hour
```

Do not point the apex/root domain `automationsystems.info` to this CRM unless explicitly requested. The intended CRM URL is the subdomain `crm.automationsystems.info`.

Alternative, instead of an individual DNS record, change domain nameservers at GoDaddy to:

```text
ns1.vercel-dns.com
ns2.vercel-dns.com
```

Prefer the individual `crm` CNAME record so existing root-domain website/email/DNS records remain untouched.

After GoDaddy DNS changes, verify:

```bash
npx vercel domains verify crm.automationsystems.info
```

Current verification status:

- `npx vercel domains verify crm.automationsystems.info` returned configured correctly.
- `http://crm.automationsystems.info/login` returned HTTP 200.
- Initial HTTPS checks failed while the certificate was not ready.
- `npx vercel certs issue crm.automationsystems.info` succeeded.
- `https://crm.automationsystems.info/login` now returns HTTP 200.
- After DNS setup, the local/router resolver briefly failed to resolve `crm.automationsystems.info`, while public DNS (`8.8.8.8` and `1.1.1.1`) and Vercel verification were correct. A direct HTTPS probe with `curl --resolve crm.automationsystems.info:443:216.198.79.1` returned HTTP 200. Treat local resolve failures as DNS cache propagation unless public DNS or Vercel verification fails.
- User's Chrome showed `DNS_PROBE_FINISHED_NXDOMAIN` after setup. Re-checks showed public DNS still resolves the CNAME, Vercel verification is configured correctly, and direct HTTPS probing returns HTTP 200. Recommended user-side fix is DNS/browser cache flush or temporarily switching DNS to Google/Cloudflare.
- GoDaddy DNS screenshot reviewed: `CNAME` record with `Name: crm` and value `7633a7ffb603e0b3.vercel-dns-017.com.` is correct. Existing root `A @ WebsiteBuilder Site` and `CNAME www -> automationsystems.info.` do not block the intended `crm.automationsystems.info` subdomain.

Build settings:

- Framework: Next.js
- Install command: `npm install`
- Build command: `npm run build`
- Dev command: `npm run dev`
- Region configured in `vercel.json`: `bom1`

Required Vercel production environment variables:

```text
NEXT_PUBLIC_SUPABASE_URL
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY
SUPABASE_SERVICE_ROLE_KEY
DATABASE_URL
CRM_ALLOWED_DOMAIN
CRM_COMPANY_NAME
```

Current intended non-secret values:

```text
NEXT_PUBLIC_SUPABASE_URL=https://cympxjsqetzivwxwbhob.supabase.co
CRM_ALLOWED_DOMAIN=automationsystems.org
CRM_COMPANY_NAME=Automation Systems NG Pvt Ltd
```

Do not store raw values for the publishable key, service role key, database password, full database URL, or OAuth client secret in this file.

Useful Vercel commands:

```bash
npx vercel whoami
npx vercel project inspect as-crm
npx vercel env ls
npx vercel deploy --prod --yes
```

## Google OAuth Setup

The current sign-in error `Unsupported provider: provider is not enabled` means Supabase Google Auth is not fully enabled/configured yet.

### Current Google Cloud Project Creation

The Google Cloud OAuth project is being created inside the `automationsystems.org` Google Cloud organization.

Current project creation values shown in Google Cloud:

```text
Project name: AS CRM Auth
Project ID: as-crm-auth
Organisation: automationsystems.org
Parent resource: automationsystems.org
```

Do this:

1. Click `Create`.
2. Select the newly created project after Google finishes provisioning it.
3. Go to `Branding` and complete the OAuth consent basics:
   - App name: `AS CRM`
   - User support email: `testing@automationsystems.org` if available in the dropdown; otherwise use the company admin/owner email shown by Google.
   - App logo: skip for now.
   - Application home page: `https://as-crm-ten.vercel.app`
   - Application privacy policy link: leave blank/skip if Google allows it for Internal; otherwise add a company policy URL later.
   - Application terms of service link: leave blank/skip if Google allows it for Internal; otherwise add a company terms URL later.
   - Authorized domains: add `automationsystems.org` if Google asks for domains.
   - Developer contact email: `testing@automationsystems.org` if available; otherwise use the company admin/owner email.
4. Go to `Audience`:
   - Select `Internal` if available. This is expected because the project is under the `automationsystems.org` organization.
   - Do not use `External` unless Google does not offer Internal. If External is required, keep Publishing status as Testing and add company test users.
   - No broad public audience is needed; this CRM is company-only.
5. Go to `Clients`.
6. Click `Create client`.
7. Application type: `Web application`.
8. Name: `AS-WEBAPP`.
9. Add this Authorized redirect URI:

```text
https://cympxjsqetzivwxwbhob.supabase.co/auth/v1/callback
```

10. Click `Create`.
11. Copy the generated `Client ID` and `Client Secret`.

Current status:

- Web application OAuth client has been created with name `AS-WEBAPP`.
- Authorized redirect URI has been pasted into that client.
- Google-generated `Client ID` and `Client Secret` have been generated and supplied by the user in chat.
- Next step is to copy those values into Supabase Google provider and save. Do not commit those raw values.

### In Supabase

Go to:

```text
Supabase -> Authentication -> Sign In / Providers -> Google
```

Set:

```text
Enable Sign in with Google: ON
Client IDs: <GOOGLE_OAUTH_CLIENT_ID ending in .apps.googleusercontent.com>
Client Secret: <GOOGLE_OAUTH_CLIENT_SECRET>
```

Then save.

Hosted Supabase provider settings are configured in the Dashboard unless a Supabase Management API access token is explicitly available. The project service-role key is not the same as a Supabase Management API access token.

Go to:

```text
Supabase -> Authentication -> URL Configuration
```

Set:

```text
Site URL:
https://as-crm-ten.vercel.app

Redirect URLs:
https://as-crm-ten.vercel.app/auth/callback
```

Important: if `Site URL` remains `http://localhost:3000`, Supabase can complete Google sign-in and then send the user back to localhost with `?code=...`. The Next.js login code sends the browser origin as `redirectTo`, so a localhost redirect after production login is a Supabase dashboard URL configuration problem, not a Vercel redeploy problem.

Supabase Auth URL Configuration has been updated to:

```text
Site URL:
https://crm.automationsystems.info

Redirect URLs:
https://crm.automationsystems.info/auth/callback
https://as-crm-ten.vercel.app/auth/callback
```

Google Cloud OAuth client `AS-WEBAPP` has been updated to include:

```text
Authorized JavaScript origins:
https://crm.automationsystems.info

Authorized redirect URIs:
https://cympxjsqetzivwxwbhob.supabase.co/auth/v1/callback
```

No Vercel redeploy is required after enabling the Google provider.

## Local Development

Install dependencies:

```bash
npm install
```

Create local env:

```bash
copy .env.example .env.local
```

Fill `.env.local` with authorized secrets. `.env.local` is ignored by git.

Run development server:

```bash
npm run dev
```

Default local URL:

- `http://localhost:3000`

## Verification Commands

Use these before claiming a change is complete:

```bash
npm run typecheck
npm run test
npm run build
npm run test:e2e
```

Playwright config:

- `playwright.config.ts`

Smoke test:

- `tests/e2e/crm-smoke.spec.ts`

The mocked-authenticated-session Playwright tests (nav/URL sync, tab routing, refresh restore, back/forward) are skipped by default and only run when a fake local Supabase env is set, since `playwright.config.ts` spawns `npm run dev` and passes through the process env:

```powershell
$env:NEXT_PUBLIC_SUPABASE_URL='http://127.0.0.1:3999'
$env:NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY='dummy-anon-key'
npx playwright test
```

## Known Product Decisions

- Google Drive upload was initially not part of the migrated version, but "save quotation to Google Drive" was added 2026-07-31 (see the Current Production Status entry above) as an additive feature alongside direct download - it does not replace direct download.
- Invoice/quotation buttons should download files directly to the user's PC.
- Apps Script latency was the motivation for moving to Vercel/Supabase.
- Preserve feature parity first; fix existing product bugs later.
- Keep RPC and data behavior close to the Apps Script implementation to reduce migration risk.
- Security and correctness are preferred over broad rewrites.
- Current production behavior has been approved for now.
- Next requested work is latency improvement and a responsive UI revamp without harming functionality or changing base business logic.
- UI revamp scope clarification: this means improving responsiveness, frontend layout quality, visual hierarchy, spacing, accessibility, and cleaner styling using `ui-ux-pro-max` and `ui-styling`; it does not mean replacing CRM features or changing business logic.
- Mobile and desktop are equally important for the revamped UI.
- The UI is currently mounted as a large generated legacy Apps Script client (`src/app/crm/legacy-full.generated.ts`) with full legacy CSS (`src/app/crm/legacy-full-ui.css`), which preserved parity but is not the desired long-term UI architecture.
- Future latency/UI work must proceed through approved spec/planning first, use TDD for production changes, and keep `CONTEXT.md` updated after every meaningful setup/design/deployment decision.
- UI revamp completion (2026-07-30): CSS overhaul + generator tweaks applied to modernize the CRM frontend. Changes are frontend-only — responsive layout, design system tokens (`--sp-*`, `--fs-*`, `--r-*`, `--shadow-*`), polished typography/spacing, smooth transitions, mobile hamburger nav, mobile full-screen modals, and premium login page restyle. No backend, business logic, or feature parity changes. Design spec: `docs/superpowers/specs/2026-07-30-ui-revamp-design.md`, Plan: `docs/superpowers/plans/2026-07-30-ui-revamp.md`.
- Performance & Latency Optimization (2026-07-30): Multi-layer optimization completed — Supabase Postgres performance indexes (`0003_performance_indexes.sql`), RPC payload Gzip/Brotli compression, server query projection, and client SWR caching with instant write-invalidation. Preserved 100% feature parity, data safety, and security rules. Spec: `docs/superpowers/specs/2026-07-30-latency-optimization-design.md`, Plan: `docs/superpowers/plans/2026-07-30-latency-optimization.md`.

## Admin/User Access Model

- Users must sign in using Google.
- Allowed email domain defaults to `automationsystems.org`.
- Backend auth checks must reject users outside the allowed domain even if Google/Supabase accepts the identity.
- Initial admin user was seeded as L6 with access to all tags.
- User/role/tag management lives in the admin service/RPC layer.
- New Google accounts from `automationsystems.org` are auto-provisioned into `public.users` on first successful login as active `L1` users with no allowed tags and `added_by='auto-provision'`.
- L6 admins should review newly auto-provisioned L1 users in admin user management and assign the correct role/tags.
- If login succeeds at Google/Supabase but the login page shows `Your account is not allowed to access AS CRM.`, the signed-in email is outside `CRM_ALLOWED_DOMAIN`, the existing CRM user row is inactive, or the user has an invalid role. Missing company-domain users should now be auto-created instead of blocked.

## Important Implementation Notes

- The generated legacy UI code uses escaped JS argument helpers to prevent inline handler injection.
- The app preserves BOOT/access-lock behavior so unauthorized users see the legacy-style lock instead of a broken CRM.
- External quote uploads must preserve original file bytes and MIME type.
- Serverless database access should use the Supabase transaction pooler.
- Middleware protects authenticated CRM/API routes.

## Useful Docs In Repo

- `docs/deployment/vercel-supabase-setup.md`
- `docs/qa/final-migration-checklist.md`
- `docs/superpowers/specs/2026-07-29-vercel-supabase-crm-migration-design.md`
- `docs/superpowers/plans/2026-07-29-vercel-supabase-crm-migration.md`
- `docs/superpowers/specs/2026-07-31-crm-tab-routing-design.md`
- `docs/superpowers/specs/2026-08-11-crm-points-manager-feedback-design.md`
- `docs/superpowers/specs/2026-08-13-quotation-drive-first-upload-design.md`
- `docs/superpowers/specs/2026-08-14-case-attachments-design.md`
- `docs/superpowers/specs/2026-08-14-case-list-batch-customers-design.md`
- `docs/superpowers/specs/2026-08-14-ticket-handover-notes-design.md`
- `docs/superpowers/specs/2026-08-18-admin-config-module-design.md`
- `docs/superpowers/specs/2026-08-18-case-priority-design.md`
- `docs/superpowers/specs/2026-08-18-form-placeholder-removal-design.md`
- `docs/role-matrix.md`
- `docs/security-audit.md`
- `docs/scalability-and-storage.md`
- `docs/superpowers/agent-reports/*`

## Fixed: `public.settings` used to be write-only from the app's perspective (was open 2026-08-11, fixed 2026-08-19)

This used to be the top gotcha in this file - an L6 admin's edit to Admin > Settings saved to the DB but every consumer except CSV import kept reading the hardcoded `DEFAULT_SETTINGS` constant instead. **It is fixed.** Recorded here so a future agent recognizes the shape of the bug if it starts to reappear, and because the guard that prevents regression is worth knowing about.

- `src/server/settings/live.ts`'s `loadSettings(repo)` is now the one place the request path learns what the configurable lists (`TAGS`, `TYPES`, `PRIORITIES`, `CATEGORIES`, `SEI_NAMES`) and scalar settings (`TAX_PCT`, `CURRENCY`, `COMPANY`) actually contain. It reads `public.settings` live, falling back to `DEFAULT_SETTINGS` only for a genuinely-absent/blank row (`SEI_NAMES` is the one list allowed to be empty on purpose, so it has no fallback). Cached per request, deliberately never process-wide - a serverless process-wide cache would make one warm instance serve stale config while another serves fresh, which is worse than no cache at all.
- `dashboard/service.ts`'s `bootstrap()` (the settings block sent to the client) and the save-time validation in `customers/service.ts`/`cases/service.ts`/`quotes/service.ts` all call `loadSettings()` now, not `DEFAULT_SETTINGS` directly. `DEFAULT_SETTINGS` (`src/server/settings/defaults.ts`) is demoted to seed-and-fallback only.
- `SELECTABLE_TAGS` (a derived re-export of `DEFAULT_SETTINGS.TAGS`, filtered) was the actual path the original bug reached the customer page through - `customerMeta` read that binding, not `DEFAULT_SETTINGS.TAGS` directly, so a naive "grep for `DEFAULT_SETTINGS.TAGS`" fix would have missed it.
- **Regression guard: `src/server/settings/no-hardcoded-reads.test.ts`.** It scans `dashboard/service.ts`, `customers/service.ts`, `cases/service.ts`, `quotes/service.ts` for any read of a configurable key off `DEFAULT_SETTINGS` - direct property access, destructuring, *and* known derived re-exports (`DERIVED_CONSTANT_BINDINGS`, currently just `SELECTABLE_TAGS -> TAGS`). Add an entry to `DERIVED_CONSTANT_BINDINGS` for any future derived export of a configurable key, or this guard goes back to missing that shape of bug. `STAGES`/`OUTCOMES`/`QUOTE_STATUSES`/`ROLES` are deliberately exempt - those are enforced by a database CHECK constraint, so reading them from the constant is correct, not a bug.

## Known Live Latency / Architecture Notes (2026-08-11)

- `recentActivity()`'s sequential-per-row Supabase query bug is **fixed**: `src/server/dashboard/service.ts` now collects every customer id an activity row needs and makes one batched `repo.getCustomersByIds(ids)` call instead of one `getCustomer` call per row (see `src/server/dashboard/service.test.ts` for the batching assertions).
- `listCases`'s per-case `getCustomer` N+1 is also **fixed** (2026-08-14, `51fd057`): `src/server/cases/service.ts` now batches with `repo.getCustomersByIds(ids)`, the same pattern as `recentActivity`. Design: `docs/superpowers/specs/2026-08-14-case-list-batch-customers-design.md`.
- Still outstanding, worth flagging for whoever picks this area up next:
  - `listCustomers()`/`listCases()` still read whole tables into memory and filter/paginate in JS rather than pushing filters down into SQL.
  - The Supabase database region is `ap-northeast-1` (Tokyo) while Vercel compute (`vercel.json`) is `bom1` (Mumbai) - every query pays this cross-region hop on top of the query cost itself.
- None of these are regressions from any of the work in this file; they're pre-existing and documented here because they were surfaced during an audit pass.

## What The Admin Config Module Needs A Future Maintainer To Know

Shipped 2026-08-19 (`d1205d4`, design `docs/superpowers/specs/2026-08-18-admin-config-module-design.md`). Admin > Settings now supports item-level add/rename/delete on each configurable list (`TAGS`, `TYPES`, `PRIORITIES`, `CATEGORIES`, `SEI_NAMES`), propagated to every row that references the value, not just the settings row. The following each cost a review cycle to find - read them before touching `src/server/admin/service.ts`:

- **Rename propagates everywhere the value is stored; delete does not need to, because delete is refused if anything still uses the value... except that's not how it works.** More precisely: `validOne(value, allowed, stored)` (`src/server/customers/service.ts`, `src/server/cases/service.ts`) accepts a value that is currently configured **or** that is unchanged from what's already stored on the row being edited. That's what makes deletion safe without a cascading check - a record that already holds a retired value keeps it until someone edits that specific field, instead of every read of that record suddenly failing validation. Creation paths deliberately call `validOne(input.x, live.x)` with **no** `stored` argument, so a retired option can never be chosen on a brand-new record.
- **`users.allowed_tags` is in the rename map** (`src/server/admin/service.ts`, the `kind: 'array'` target using `array_replace`) because tags are locations, and locations gate which customers a user can see. A rename that missed this column would silently revoke a user's visibility into accounts they should still see, not just mislabel a field. The `'*'` wildcard (meaning "every location") is deliberately left alone by `array_replace` since it never matches a real tag name.
- **`cases.won_categories` is pipe-joined text, not an array column**, written as `' | '` (with spaces, via `joinPipe`) but parsed by splitting on `'|'` and trimming each element (`parsePipe`). The rename SQL trims per element with `btrim(part, E' \t\r\n')` (matching `parsePipe`'s JS `.trim()`, which also strips tabs/CRs/newlines, not just ASCII spaces) before comparing - SQL that compares the raw untrimmed element would silently rewrite nothing. A plain string `replace()` is the other wrong answer: the live category list holds both `Other` and `Others`, so a substring replace of `Other` would corrupt `Others`.
- **Config mutations take a row lock (`lockSetting`, `for update`) on the settings row, inside the transaction**, before reading the current list. Without it, two concurrent admin actions on the same list race: a lost update can strand a value that ends up unselectable on new records, invisible in the admin UI list, and unrenameable (rename reads the same un-locked list to find it).
- **`SEI_NAMES` may legitimately be emptied to zero items; every other configurable list must keep at least one.** Enforced by one shared helper used by both `deleteConfigItem` and `saveSettings`, so the two paths can't drift into disagreeing about which lists are allowed to go empty.
- **`'TO BE FILLED'` is reserved.** It's migration `0007`'s backfill placeholder for customers with no location (see the case-ownership re-architecture entry above). It can never be added, deleted, or offered as a selectable option - it's a marker for "needs a human to pick a real value," not a real value.
- **The client is generated - edit the source, not the artifact.** Edit `docs/source-appscript/Index.html`, then run `node scripts/port-legacy-index.mjs` to regenerate `src/app/crm/legacy-full.generated.ts`. Never hand-edit the generated file directly (this used to be a necessary workaround while the generator was broken; it is fixed as of 2026-08-11 and hand-editing is no longer acceptable). Config values that need to reach an inline `onclick` handler go through the generator's `jsArg()` rewrite (JSON-stringify then HTML-escape), not hand-rolled string escaping - see `scripts/port-legacy-index.mjs`'s `jsArg`/`jsJsonArg` injection.
- **Case sources is gone from the admin panel, but the underlying data is not.** `srcOptions()` (the client-side dropdown builder) was deleted, and there is no more UI to add/rename/delete a case source. `cases.source` the database column, and the server-side plumbing that reads/writes it (`src/server/cases/service.ts`, `repository.ts`), are unchanged and still fully functional - only the admin-editable-list UI for it was removed.

## Open Items

- **`SOURCES` is an orphan settings key.** `api_admin_saveSettings` still accepts `input.sources` and still writes it to `public.settings` (`src/server/admin/service.ts`), but nothing reads it anymore now that `srcOptions()` is gone from the client. Harmless as shipped, but a future cleanup pass should either wire it back up or remove the write path - don't be surprised to find a settings row nothing consumes.
- **The database password has been exposed in a transcript and has not been rotated.** Treat `DATABASE_URL`'s current password as compromised. Rotating it (Supabase dashboard -> Database -> reset password, then update `DATABASE_URL` in Vercel and every local `.env.local`) has not happened as of this entry.
- **Vercel is on the Hobby plan**, which forbids commercial use. This CRM is being used for real company business. Upgrading to a paid plan is unresolved.

## Session Log

- 2026-08-11: Full data-flow / schema audit (no code changes). Confirmed via `git status --short` the working tree has no pending source changes (only untracked local tool dirs: `.agent/`, `.claude-code-history/`, `.codex-history/`). `npx vercel whoami` returned "Not authorized" in this environment - could not pull `npx vercel env ls` output; env var names/values were not re-verified this session, only the names already documented above. Found and documented the `public.settings` drift issue above.
- 2026-08-11 (later same day): CRM points-manager feedback implementation landed on `feat/crm-points-manager-feedback` - repaired `scripts/port-legacy-index.mjs` (statement-terminator scanning, DOM-rewrite ordering), re-architected case ownership onto `cases.extra_owners` (`caseOwners()` no longer takes an ownership argument; `caseHandlerOwners()` removed), rejected L5/L6 as account handlers, added the `Direct` virtual account (`src/server/domain/direct.ts`), made customer location mandatory, converted `customers.sei` to a multi-select `text[]` validated against a live `SEI_NAMES` setting, and added `owned`/`assigned` filters to `api_listCases`. Four new migrations (`0005`-`0008`) shipped with this work; they were **not yet applied to any database as of this entry** - since then, all four have been applied everywhere (see the corrected Supabase Migrations section). New docs: `docs/role-matrix.md`, `docs/security-audit.md`, `docs/scalability-and-storage.md`. This `CONTEXT.md` update corrects the now-stale "treat the legacy artifact as frozen" instruction from earlier in this file and documents all of the above - see the Current Production Status and Architecture Overview sections.
- 2026-08-19: `CONTEXT.md` correction pass (no code changes), verified against `git log`, the migration files, and source rather than trusting the prior draft. Corrected: the `public.settings` write-only issue is fixed (`src/server/settings/live.ts`, guarded by `no-hardcoded-reads.test.ts`); migrations `0005`-`0011` are all applied (`schema_migrations` holds 11 rows); `quotations.upload_data` is legacy-read-only now that uploads go to Drive; the `listCases` customer N+1 is fixed. Added entries for every feature shipped since 2026-08-11 (Drive-first upload `ffa5678`, handover notes `e44a342`, case-list batching `51fd057`, case attachments `cecce07`, case priority merge `459f924`, admin config module + placeholder removal merge `d1205d4`) and a "What The Admin Config Module Needs A Future Maintainer To Know" section. Verified HEAD is `d1205d4` on `main`.

## If A New Agent Takes Over

Start here:

1. Read this `CONTEXT.md`.
2. Read `docs/qa/final-migration-checklist.md`.
3. Read the migration design and plan under `docs/superpowers`.
4. Check `git status --short`.
5. Confirm production env names with `npx vercel env ls`.
6. Run the verification commands before editing deployment-sensitive behavior.
7. Never overwrite user changes or remove existing migration parity code without proving the replacement.
