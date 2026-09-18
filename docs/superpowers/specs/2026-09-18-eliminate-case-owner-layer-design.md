# Eliminate the case-owner layer — design spec

Date: 2026-09-18
Status: Approved

## Problem

Case access today runs through three layers: account/customer **handlers**, case-level **owners**
(`cases.owner` + `cases.extra_owners`, materialized and manually editable via `addCaseOwner`/
`removeCaseOwner`), and the ticket **assignee**. The case-owner layer adds real operational
complexity — a manage-owners modal, a handler/creator/manual source distinction, a propagation step
that copies new handlers onto active cases, and two independent implementations of "who owns this
case" (TypeScript in `src/server/auth/access.ts`, raw SQL in `src/server/customers/repository.ts`)
that must be kept in sync by hand.

The goal: **account/customer handlers become the sole owners of an account and every case on it.**
The standalone case-owner concept — explicit case-level owners, the creator/manual-owner overrides,
the manage-owners UI — is removed. Assignee (the ticket holder) is unchanged.

## Scope

Confirmed with the project owner, decisions locked before any code:

1. **Handler-less fallback.** A case whose account has no real handler yet (a customerless case, or a
   Direct-handled account) falls back to `[case.createdBy]` as its sole owner, so the case isn't
   orphaned — nobody but the assignee/L4+ could otherwise see it. The moment a real handler exists on
   that account, the fallback stops applying; the handler(s) become the owner(s).
2. **No historical freeze.** Ownership is derived live from current handlers, always — including on
   closed (Won/Lost/Hold) cases. Today's behavior (handler-add skips closed cases, preserving a
   historical snapshot) is explicitly *not* preserved. Existing data is test-only and doesn't need to
   survive this change unchanged.
3. **Columns physically dropped.** `cases.owner`, `cases.extra_owners`, and the `cases_owner_outcome_idx`
   index are removed in a real migration — not just stopped-being-read. `cases.created_by` (a separate,
   pre-existing audit column, distinct from `owner`) stays; it's what the handler-less fallback reads.
4. **No replacement for manual per-case ownership.** Today you can add someone as a case owner without
   making them an account handler. That capability is removed with no substitute — the only ways to
   touch a case going forward are: be a handler of its account, be its assignee, or be L4+.
5. **UI label: "Owners" → "Handlers" everywhere it appears on a case.** The word "Owners" described a
   concept that no longer exists as its own thing; the data is now literally the account's handler
   list, so the label should say that. The manage-owners modal is removed entirely — there is nothing
   left to manage per case, so the case page shows a plain, read-only handler list.

## Current state (verified by direct investigation, not assumed)

- **DB**: no CHECK constraint anywhere references `owner` or `extra_owners` — all ownership semantics
  live in application code. `cases.owner` is set once at creation and never changes. `cases.extra_owners`
  (pipe-text) is the actual authoritative "current owners," materialized by migration `0005` and kept
  in sync by an add-handler propagation loop.
- **Two parallel derivations of the same rule** that must change together: `caseOwners()`
  (`src/server/auth/access.ts:68-74`) in TypeScript, and a `CASE ... WHEN cardinality(...) > 0 ...`
  expression in raw SQL (`src/server/customers/repository.ts:339-346`) for the customer-detail case
  list. Today these two implementations independently encode "stored extra_owners, else owner-unless-
  Direct" — the exact same rule written twice.
- **`caseVisible()`** (`src/server/auth/access.ts:115-127`): `L4+ OR case-owner OR assignee OR
  customerAccess==='FULL'`. `customerAccess==='FULL'` already covers "is a handler" (plus tag-matched
  L3+, plus L4+) — so the case-owner branch is mostly redundant with it today. The only thing it does
  that `FULL` access doesn't is cover the creator-fallback for a handler-less account.
- **Three case-creation paths don't currently agree** on how they seed `extra_owners`: `createCase` and
  `quickLog` seed the account's real handlers (falling back to the creator only if none exist);
  the auto-case created from a first Sent quotation (`quotes/service.ts`) seeds `extra_owners` **empty**
  and relies purely on the `owner` fallback. This is a pre-existing inconsistency, not something this
  change introduces — and it disappears for free once nothing needs seeding at all.
- **Handler add** propagates onto the account's *active* cases only (`customers/service.ts:925-932`,
  closed cases explicitly skipped). **Handler remove** touches zero cases. Manual
  `addCaseOwner`/`removeCaseOwner` (`cases/service.ts:845-895`) have their own rules: caller must
  already be an owner or L4+, a case must always keep ≥1 owner, handler-sourced owners can't be removed
  through this path at all (must remove the handler instead).
- **Dashboard**: "my cases"/"open opps" is grouped by ownership (`caseOwners`), completely separately
  from "tickets," which is grouped by `assignee`. These stay two independent buckets — only the
  ownership side's derivation changes.
- **Frontend** (`docs/source-appscript/Index.html`): 14 distinct sites — the manage-owners modal
  (`mOwners`/`addOwner`/`removeOwner`/`ownerSourceLabel`), three "Owners" column renders (case page
  header, Cases-tab table, customer-detail case list), the Cases-tab "Owned by me" filter and its
  dashboard-stat-tile wiring, `mNewCase`'s copy, and the case-reassignment suggestion list (`mAssign`),
  which currently sources its suggested names from `ownerList`.

## New architecture

### Single source of truth

Replaces `caseOwners()` / `caseOwnerEntries()` / `caseOwnerSource()` / the `CaseOwnerSource` and
`CaseOwnerEntry` types entirely:

```ts
function caseHandlers(customerId: string, createdBy: string, ownership: Ownership): string[] {
  const handlers = customerRealHandlers(customerId, ownership);
  if (handlers.length > 0) return handlers;
  const creator = normalizeEmail(createdBy);
  return creator && !isDirect(creator) ? [creator] : [];
}
```

One function, one place, no "source" tracking (there's nothing left to explain — a name in the list is
either a handler or the fallback creator, and the fallback only ever shows when there are zero
handlers, so there's no ambiguity to label). Used everywhere the old `caseOwners()` was used, and
replaces the SQL-side duplicate in `customers/repository.ts` — that query should now either call the
same derivation logic at the service layer instead of duplicating it in SQL, or, if a SQL-side
computation is still needed for performance, express the *identical* handlers-or-creator-fallback rule
using `handlers` and `cases.created_by` directly (never reintroduce `extra_owners`/`owner`).

### `caseVisible()` simplifies to:

```
L4+ (seesAll)
  OR customerAccess === 'FULL'          (already covers: real handler, tag-matched L3+, L4+)
  OR assignee === caller                 (unchanged)
  OR (no real handler on this account AND caller === case.createdBy)   (the narrow fallback)
```

### Removed entirely

- Service: `addCaseOwner`, `removeCaseOwner` (`src/server/cases/service.ts`), their RPC registrations
  (`api_addCaseOwner`, `api_removeCaseOwner`, `src/server/cases/rpc.ts`), the `CASE_OWNER_ADD`/
  `CASE_OWNER_REMOVE` activity actions.
- The handler-add propagation loop in `addHandler` (`src/server/customers/service.ts:925-932`) and its
  supporting `CaseOwnerRow` type, `listCaseOwnerRows`/`setCaseExtraOwners` repository methods — nothing
  is materialized anymore, so there's nothing to propagate.
- Case-creation seeding: `createCase`, `quickLog`, and the auto-case-from-quote path all currently write
  `extraOwners`/`owner` at creation. None of them need to write anything for ownership purposes once the
  columns are gone — `created_by` (already written for audit purposes on every path) is sufficient for
  the fallback to work.
- Frontend: `mOwners()`, `addOwner()`, `removeOwner()`, `ownerSourceLabel()`, the `o.removable`
  conditional in the case page's owner row rendering.

### DB migration

New migration (numbered after the current latest): `alter table public.cases drop column owner;`,
`alter table public.cases drop column extra_owners;`, `drop index if exists cases_owner_outcome_idx;`.
No data preservation — confirmed acceptable given the current dataset is test data only. Follow this
repo's established migration conventions (`set local lock_timeout`, a post-condition `do $$ ... raise
exception` block asserting both columns are actually gone — see recent migrations `0012`/`0013` for the
house pattern).

### Frontend

- Case page: "Owners: <b>...</b>" → "Handlers: <b>...</b>", reading a new `case.handlers` field (plain
  list of names, no manage button, no modal).
- Cases-tab table and customer-detail case list: "Owners" column header → "Handlers".
- `mAssign`'s reassignment-suggestion list: source from the same handler list instead of `ownerList`.
- `mNewCase`'s copy referencing "account handlers are the owners" stays accurate as-is (it already
  described the target end-state) — verify wording still reads correctly once "Owners" no longer
  appears as a separate UI concept anywhere else on the page.
- Cases-tab "Owned by me" filter: unchanged UX (same checkbox, same wire field `owned`), but its
  semantics now mean "cases of customers I handle" server-side — no client change needed, only the
  server-side filter logic changes what `owned` actually checks.

### API response shape changes

- `getCase`: drop `ownerEmails`/`ownerList` (the source/removable metadata is gone); rename the
  `owners` field to `handlers` in the response. Server and client must agree on vocabulary — a future
  reader should never have to translate "Handlers" in the UI back to "owners" in the API.
- `listCases`, customer-detail case list: same rename, `owners` → `handlers`.

## Testing

Every one of these needs a real, behavior-asserting test (not a mock-call-count check) — per the
project owner's explicit "properly tested for each edge case" requirement:

- `caseHandlers()`: real handlers present → returns them, ignores creator entirely. Zero handlers,
  customerless case → returns `[createdBy]`. Zero handlers, Direct-only account → returns `[createdBy]`.
  Handler exists but creator is someone else → creator is NOT in the result (no more "manual"/"creator"
  blending). `createdBy` is Direct or blank with zero handlers → returns `[]` (never crashes, never
  fabricates an owner).
- `caseVisible()`: full matrix — L4+ sees everything; a real handler sees it via `FULL` access, not
  needing the fallback branch; an unrelated L1/L2/L3 user is denied; the assignee sees it regardless of
  handler status; the creator sees a handler-less case; the creator LOSES visibility the instant a real
  handler is added to that account (this is the sharpest edge case — write it explicitly); a former
  creator on an account that now has a handler is denied unless they're also the assignee.
- Closed-case behavior: add a handler to an account with an existing **closed** case — assert the
  closed case's handler list changes too (proving the "no freeze" decision is actually implemented, not
  just documented).
- Case creation paths: `createCase`, `quickLog`, and the auto-case-from-quote path all produce a case
  whose `caseHandlers()` result is identical when the underlying account/creator state is identical —
  proving the three-path inconsistency is genuinely gone, not just moved.
- RPC removal: `api_addCaseOwner`/`api_removeCaseOwner` are actually gone from the RPC registry (a
  test asserting they 404/throw "unknown RPC," not just "the function isn't imported somewhere").
- Frontend: the case page renders "Handlers" (never "Owners") at every stage/access level; no manage
  button, no modal, ever; the Cases-tab and customer-detail "Handlers" columns show the same data as
  the case page for the same case; `mAssign`'s suggestions match the account's handler list.
- Migration: post-condition assertion that both columns and the index are gone; confirm the migration
  runs cleanly against the current (test) production schema state via `--dry-run` first.

## Final report deliverable

After implementation, before this is considered done: a short report (not code) stating what was
achieved and how, including a table with columns **What changed / Previous behavior / New behavior**,
covering at minimum: case ownership derivation, handler-less fallback, closed-case ownership, manual
per-case ownership, the "Owned by me" filter's meaning, the case-page UI label, and the RPC surface
(`api_addCaseOwner`/`api_removeCaseOwner` removed).

## Known risks / non-goals

- This is a genuine access-reduction for two real scenarios, both explicitly confirmed acceptable: (a)
  the creator of a case loses visibility into it the moment a real handler is added to that account,
  unless they're also the assignee; (b) anyone who was a manually-added case owner (not a handler, not
  the creator, not the assignee) loses access entirely once this ships — there is no migration path for
  them, per the "no replacement mechanism" decision.
- Out of scope: nothing about the assignee/ticket-holder model changes. Nothing about the Quoted/
  Revision case-lifecycle work changes. Nothing about customer-level handler add/remove rules
  (L5/L6-can't-be-handlers, etc.) changes — only how handlers translate into *case* access.
