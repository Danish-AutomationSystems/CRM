# Case-owner layer removal - before/after report

Date: 2026-09-18
Branch: `feat/eliminate-case-owner-layer`, HEAD `0ae7f83`

## Goal

Case access used to run through three layers: account/customer handlers, case-level owners
(`cases.owner` + `cases.extra_owners`, materialized and manually editable via `addCaseOwner`/
`removeCaseOwner`), and the ticket assignee. The case-owner layer added real operational complexity -
a manage-owners modal, a handler/creator/manual source distinction, a propagation step that copied new
handlers onto active cases (skipping closed ones), and two independent implementations of "who owns
this case" that had to be kept in sync by hand. The goal was to make account/customer handlers the sole
owners of an account and every case on it, removing the standalone case-owner concept entirely.
Assignee (the ticket holder) is unchanged.

## How it was achieved

Ownership is now derived live by a single function, `caseHandlers(caseRecord, ownership)` in
`src/server/auth/access.ts`: it reads the account's real handlers and returns them; if the account has
no real handler (a customerless case, or one handled only by the virtual `Direct` account), it falls
back to the case's creator (`cases.created_by`) so the case is never orphaned. Nothing about ownership
is stored on the case anymore - the derivation runs fresh on every read, including for already-closed
(Won/Lost/Hold) cases, so there is no historical freeze the way the old materialized model had. This
replaced the old `caseOwners()`/`caseOwnerEntries()`/`caseOwnerSource()` functions and the raw-SQL
duplicate of the same rule in `src/server/customers/repository.ts`. The manual `addCaseOwner`/
`removeCaseOwner` service methods, their RPCs, and the manage-owners modal were deleted with no
replacement - the only ways to touch a case going forward are: be a handler of its account, be its
assignee, or be L4+. `cases.owner` and `cases.extra_owners` (and the index on one of them) are
physically dropped by a new migration, `0014_drop_case_owner_columns.sql`, which has not yet been
applied to production. The work was split into 5 sequential tasks (schema-parity test parser, frontend
label change, server derivation + RPC removal + a review fix round, column drop + write-path cleanup,
this documentation pass); see `.superpowers/sdd/2026-09-18-eliminate-case-owner-layer/task-1-report.md`
through `task-4-report.md` for full per-task detail.

## What changed

| What changed | Previous behavior | New behavior |
|---|---|---|
| Who owns a case | Materialized per-case owner set (`cases.extra_owners`, falling back to `cases.owner`), independently editable from account handlers via `addCaseOwner`/`removeCaseOwner`. | Derived live from the account's real handlers, via `caseHandlers()` (`src/server/auth/access.ts`). No independent per-case owner concept exists. |
| Where ownership is stored | `cases.owner` (set once at creation) + `cases.extra_owners` (pipe-text, kept in sync by a propagation loop). | Nowhere. `caseHandlers()` recomputes it on every read from `public.handlers` (via `AccessOwnership.handlerEmailsByCustomerId`) and `cases.created_by`. Both storage columns are dropped by migration `0014` (not yet applied). |
| Account with no real handler (customerless / Direct-only) | `owner` (the creator, excluding `direct`) was the fallback, seeded at creation time into `extra_owners`/`owner` by `seedOwners`. | `caseHandlers()` falls back live to `normalizeEmail(caseRecord.createdBy)` (excluding `direct`) whenever `customerRealHandlers()` returns zero handlers - no seeding at creation, nothing stored. |
| Closed (Won/Lost/Hold) cases when handlers change | Frozen: the handler-add propagation loop in `addHandler` (`src/server/customers/service.ts`) only touched the account's **active** cases, explicitly skipping closed ones - a closed case kept whatever owners it had at close time. | Live, no freeze: `caseHandlers()` is recomputed on every read regardless of case state, so adding a handler to an account changes that account's closed cases' handler list too, exactly like its open ones. Covered by `src/server/customers/service.test.ts`'s `'adding a handler performs no case write, and the new handler is seen on both the active and closed case via caseHandlers'`. |
| Adding a handler to a customer | `addHandler` propagated the new handler onto every active case via `listCaseOwnerRows`/`setCaseExtraOwners` (a DB write per active case). | `addHandler` performs zero case writes - the propagation loop, `CaseOwnerRow`, `listCaseOwnerRows`, and `setCaseExtraOwners` are all deleted. The new handler is simply visible the next time any of the account's cases (active or closed) is read. |
| Removing a handler from a customer | Touched zero cases (documented as intentional, to avoid the old bug of silently stripping access from closed cases). | Still touches zero cases, but the effect is now immediate and live: the removed handler stops being one of `caseHandlers()`'s results on the account's next read, open or closed. |
| Manually adding/removing a case owner | `addCaseOwner`/`removeCaseOwner` (`src/server/cases/service.ts`) let a caller who was already an owner or L4+ add/remove owners independent of the account's handler list, subject to "always keep ≥1 owner" and "handler-sourced owners can't be removed this way." | Removed entirely, no substitute. There is no way to grant or revoke per-case ownership independent of being an account handler, the assignee, or L4+. |
| Case creator's access | Always an owner if the "manual"/"creator" `extra_owners` entry was ever seeded or added, regardless of current handler state (frozen at whatever was materialized). | Sees the case only via the creator fallback, and only while the account has zero real handlers. The instant a real handler is added to that account, the creator's claim to the case ends (unless they're also the assignee) - a confirmed access reduction, see below. |
| Case visibility rule | `caseVisible()` = L4+ OR case-owner (materialized) OR assignee OR `customerAccess==='FULL'`. | `caseVisible()` = L4+ OR `customerAccess==='FULL'` (covers real handler, tag-matched L3+, L4+) OR assignee OR `caseHandlers(...).includes(caller)` (only reachable when there's no real handler, i.e. the narrow creator fallback). Same public shape, simplified/reordered internals in `src/server/auth/access.ts`. |
| "Owned by me" filter / dashboard "my cases" | `listCases`'s `owned` filter and the dashboard's "my cases"/"open opps" grouping checked materialized `extra_owners`/`owner`. | Same client-facing checkbox and wire field (`owned`), but the server-side check now uses `handlerEmails(row, ownership)` (`src/server/cases/service.ts`) / live `caseHandlers()` (`src/server/dashboard/service.ts`) - unchanged UX, changed semantics: "cases of customers I handle" (plus the narrow creator fallback), not "cases I was ever recorded as owning." |
| Case page / Cases tab / customer case list label | "Owners: `<names>` manage" with a manage-owners modal (`mOwners`/`addOwner`/`removeOwner`/`ownerSourceLabel`), table columns headed "Owners". | "Handlers: `<names>`" plain read-only list, no manage button, no modal (`docs/source-appscript/Index.html`). Table headers read "Handlers". API responses rename `owners`/`ownerEmails`/`ownerList` to `handlers`/`handlerList` in `getCase`, `listCases`, and the customer-detail case payload. |
| Reassignment suggestions | `mAssign`'s suggestion-bubble hint sourced names from `ownerList`, worded "people who own this case." | Sources from `d.case.handlerList` (`mAssignCase()` in `Index.html`); hint reworded "this account's handlers." |
| RPC surface | `api_addCaseOwner`, `api_removeCaseOwner` registered and callable (`src/server/cases/rpc.ts`). | Both removed. `src/server/rpc/api-parity.test.ts` asserts `hasRpc('api_addCaseOwner')`/`hasRpc('api_removeCaseOwner')` are both `false`, and lists them in `intentionallyUnmigrated` with a dated comment. |
| Database schema | `public.cases` carried `owner` (text) and `extra_owners` (pipe-text), plus the `cases_owner_outcome_idx` index. | Migration `supabase/migrations/0014_drop_case_owner_columns.sql` drops both columns and the index, with a post-condition assertion both are gone. **Committed but NOT applied to production**; its `--dry-run` has not been run either (see Open before production, below). `cases.created_by` is untouched and unaffected - it is what the creator fallback reads. |
| Number of implementations of the ownership rule | Two: TypeScript `caseOwners()` (`src/server/auth/access.ts`) and a raw-SQL `CASE ... WHEN cardinality(...) > 0 ...` expression (`src/server/customers/repository.ts`), kept in sync by hand. | One: `caseHandlers()` (`src/server/auth/access.ts`). `customers/repository.ts`'s `listCasesByCustomer` query now selects `c.created_by` directly and the customer service layer calls `caseHandlers()` on each row - no SQL-side duplicate of the rule remains. |

## Known access reductions

Both were explicitly confirmed acceptable by the project owner before this shipped, and neither has a
migration or replacement path:

1. **The creator of a case loses visibility into it the instant a real handler is added to that
   account**, unless they're also the assignee. Previously, a creator who had been materialized as an
   owner kept access regardless of later handler changes.
2. **Anyone who was a manually-added case owner** (not a handler, not the creator, not the assignee)
   **loses access entirely once this ships.** There is no replacement mechanism for manual per-case
   ownership - the only ways to touch a case going forward are: be a handler of its account, be its
   assignee, or be L4+.

## Verification

- `npm test`: **42 test files, 758 tests, all passing.**
- `npm run typecheck`: clean, no errors.
- `npm run build`: succeeded (production build, all 9 static/dynamic routes generated). One
  pre-existing, unrelated ESLint plugin-conflict warning caused by the worktree having its own
  `package.json`/lockfile alongside the main repo - not introduced by this change, does not fail the
  build.
- Playwright (`npx playwright test`, dev server pre-warmed, `NEXT_PUBLIC_SUPABASE_URL`/
  `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` exported in the same shell as the test run): **33 passed, 0
  failed, 0 skipped.**

## Open before production

- **Migration `0014_drop_case_owner_columns.sql` has not been applied to any environment, including
  production.** `public.schema_migrations` still holds 13 rows.
- **Its `--dry-run` has also not been run** (`node scripts/apply-migrations.mjs --through 0014
  --dry-run`) - no `DATABASE_URL`/`.env.local` was available in the environment this work was done in.
  Run the dry-run first, then apply, both with the project owner's explicit go-ahead, exactly like every
  other migration in this project's history.
- **Backup-restore caveat**, verbatim from the migration file's own header comment: "Backups taken
  before this migration still carry owner/extra_owners on public.cases rows. scripts/restore-database.mjs
  inserts every key it finds, so strip those two keys before restoring such a backup into a post-0014
  schema."
