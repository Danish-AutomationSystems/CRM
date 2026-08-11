# CRM Points (Manager Feedback) — Design

Date: 2026-08-11
Source: `CRM Points.docx` (manager review of the live CRM at `https://crm.automationsystems.info`)
Status: Approved by project owner (Danish) on 2026-08-11

This spec covers eleven review points. Each is implemented as its own task with its own
pass check. Every code change follows TDD: a failing test first, then the implementation.

---

## 0. Decisions taken before design (owner-approved)

| Decision | Choice | Consequence |
|---|---|---|
| Legacy UI artifact | **Fix the generator first** | `scripts/port-legacy-index.mjs` is repaired and `legacy-full.generated.ts` is regenerated from `docs/source-appscript/Index.html`. Index.html becomes editable source again. Unblocks six UI points. |
| "rename tags -> location everywhere" | **UI labels only** | DB keeps `customers.tags` / `users.allowed_tags`; RPC field names unchanged. Zero migration risk. |
| SEI field | **Customer field, admin-managed list** | `customers.sei` migrates `text` -> `text[]`; selectable names live in `public.settings`. Ships empty; an L6 populates it. |
| Case ownership model | **Materialise owners on the case** | Owners stop being derived live from `handlers`. Reuses `cases.extra_owners`. No new table. |
| Two case filters | **OR** | "Owned by me" + "Assigned to me" ticked together shows either. Neither ticked = all visible cases. |
| Direct account | **Virtual, no DB row** | Synthesised in user-list / dashboard-picker responses. Cannot ever become a login identity. |
| Blank customer locations | **Backfill `TO BE FILLED`** | No existing record is blocked or emptied. `TO BE FILLED` becomes a valid location value but is never offered as a choice. |
| Existing L5/L6 handler rows | **Block new + auto-remove existing** | Removal migration is gated behind P11 (see ordering constraint below). |

---

## 1. Critical ordering constraint

**The L5/L6 handler-removal migration (P1) MUST NOT run until P11 has landed.**

Today `caseHandlerOwners()` derives case owners live from the `handlers` table. Deleting an
L5/L6 handler row while that derivation is still in place would silently strip that person
from every case they own, including closed ones — irreversible, and the exact behaviour the
manager asked us to prevent in P11.

Once P11 materialises ownership onto each case, deleting the handler row is inert: the case
keeps its stored owners. Only then is the removal migration safe.

This is encoded as a hard task dependency, not a comment.

---

## 2. Workstreams

Work is split so that no two concurrent agents write the same file.

| Stream | Scope | Files owned | Depends on |
|---|---|---|---|
| **G** Generator fix | Repair expression scanner, regenerate artifact | `scripts/port-legacy-index.mjs`, `src/app/crm/legacy-full.generated.ts` | — |
| **A** Ownership + server | P11, P10, P9-server, P1, P6-filter, P7-validation, P8-field | `src/server/**`, `supabase/migrations/**` | — |
| **B** UI | P5, P6-ui, P7-ui, P8-ui, P9-ui, P10-label | `docs/source-appscript/Index.html`, `src/app/crm/legacy-full-ui.css` | G, A |
| **C** Security audit | P3 | `docs/` only (read-only elsewhere) | — |
| **D** Scalability | P4 | `docs/` only (read-only elsewhere) | — |
| **E** Role matrix | P2 | `docs/` only | A |

G, A, C, D start concurrently. B follows G and A. E follows A. The final report follows all.

---

## 3. Point-by-point design

### P1 — L5/L6 may not be an account handler

**Current behaviour.** `customers/service.ts::createCustomer` already assigns `'direct'` as
the handler when `roleLevel(user) >= 5`. But `api_addHandler` performs no role check, so an
L5/L6 can be added as a handler manually. Nothing prevents it today.

**Change.**
- `addHandler` rejects any target whose role is L5 or L6, with a user-facing message.
- Case ownership is explicitly *not* restricted: L5/L6 remain eligible as `extraOwners` and
  as the ticket `assignee`.
- Migration (gated behind P11) deletes existing `handlers` rows whose `user_email` resolves
  to an L5/L6 user.

**Pass check.** Unit: `addHandler` throws for L5 and for L6, succeeds for L1–L4. Unit:
`addCaseOwner` and `assignTicket` still accept an L5/L6. Migration: assert the count of
L5/L6 handler rows is > 0 before and exactly 0 after, and assert no `cases` row lost an
owner across the migration.

### P2 — Role-based permission matrix

**Deliverable.** An L1–L6 × action matrix derived from `auth/access.ts::accessLevel()`,
every `requireLevel()` call site, `ensureFull`, `ensureCanSeeCase` and `ensureAdmin`.

Written **after** stream A so it documents final behaviour, not current behaviour. Lands in
the final Word report and in `docs/role-matrix.md`.

**Pass check.** Every row is traced to a specific file:line. No claim is written that isn't
backed by code. Spot-verified against the access-control unit tests.

### P3 — Database security audit

**Scope.** RLS deny-all policies across all 14 tables; `DATABASE_URL` / service-role key
handling; `middleware.ts` `PROTECTED_PREFIXES` coverage; per-request identity re-derivation
in `getRequestContext`; the allowed-domain lock; the **auto-provision-as-L1 path** (any
`@automationsystems.org` Google account self-provisions on first login — this is the single
most important thing to assess); SQL-injection surface via `postgres.js` tagged templates;
Drive OAuth token scope and storage; secrets in env vs repo.

**Pass check.** Every finding carries a file:line and a concrete exploit scenario, rated
by severity. Findings that turn out not to be exploitable are stated as such rather than
padded into the report.

### P4 — Scalability and storage estimate

**Scope.** The dominant risk is that `listCustomers()` and `listCases()` load **every** row
and filter in JavaScript, and `listCases` additionally issues one `getCustomer` per case
(N+1). Also: `quotations.upload_data` stores uploaded files as inline `bytea` in the row;
Supabase tier limits; Vercel serverless concurrency against the transaction pooler.

**Deliverable.** Measured row-size estimates, projected storage at 20 / 50 / 100 users over
1 / 3 / 5 years, and the specific query rewrites that would be needed before each threshold.

**Pass check.** Estimates derive from actual column types and observed row sizes, not
guesses. Each recommendation names the file:line it applies to.

### P5 — Remove redundant dashboard buttons

Remove `+ New customer` (L4 dashboard, `Index.html:464`) and `Customers` / `Cases`
(L5/L6 dashboard, near `Index.html:496`). All three duplicate the top nav.

**Pass check.** e2e: at L4 and at L5, the dashboard contains none of these three buttons,
and the top-nav routes to Customers and Cases still work.

### P6 — Cases filter: fix checkbox, split into two

**Current.** One `Mine only` checkbox (`Index.html:1481`) that renders as an oversized blue
box, filtering on `ownerEmails.includes(me)`.

**Change.** CSS fix for `input[type=checkbox]`, then two independent checkboxes —
`Owned by me`, `Assigned to me` — combined with **OR**. Server: `api_listCases` gains
`owned` and `assigned` filter flags; the legacy `mine` flag is retained and treated as
`owned` so any in-flight client keeps working.

**Pass check.** Unit on `listCases`: owned-only, assigned-only, both (union), neither (all
visible) each return the expected case IDs against a fixture where the three sets differ.
e2e: the checkbox renders at a normal size and each box changes the result count.

### P7 — Location mandatory, moved, relabelled

**Change.**
- `createCustomer` requires at least one valid location; `updateCustomer` requires the
  customer not be left with zero.
- `TO BE FILLED` is added as a recognised location value so backfilled records survive a
  later save, but it is excluded from the picker so nobody can select it deliberately.
- Migration sets `tags = ARRAY['TO BE FILLED']` for every customer with an empty `tags`.
- The field moves directly beneath Name in the create-customer modal.
- All user-facing text reads **Location**: modal label, grid header, filter dropdown,
  detail view, admin. DB and RPC keep `tags`.

**Pass check.** Unit: create with no location throws; create with a location succeeds;
update cannot empty it; `TO BE FILLED` survives a save round-trip; the picker does not
offer it. Migration: count of customers with empty tags is > 0 before and exactly 0 after,
and the total customer count is unchanged.

### P8 — SEI as a non-mandatory multi-select

**Current.** `customers.sei` is free `text`, edited as a grid text input (`Index.html:748`).

**Change.**
- Migration `text` -> `text[]`, splitting any existing value on `|`/`,` so current data is
  preserved rather than dropped.
- Selectable names come from a new `SEI_NAMES` key in `public.settings`, editable by an L6
  in Admin. **Ships empty** — no invented Schneider names.
- UI is a dropdown multi-select, deliberately *not* the pill/`tagpick` style used by
  locations, per the manager's explicit instruction.
- Remains optional.

**Pass check.** Unit: a customer saves with zero, one and many SEI values; an unknown name
is rejected. Migration: every pre-existing non-empty `sei` string appears as a populated
array afterwards, asserted row by row.

### P9 — Direct as a special account

**Change.**
- **No Remove button** when the sole handler is `Direct` — it is cleared automatically by
  `removeDirectHandlers()` inside `addHandler`, so a manual remove can only produce a
  customer with no handler at all.
- Direct is synthesised as a virtual user: name `Direct`, all locations, explicitly marked
  as having no login. It appears in the user list and in the "view a user's dashboard"
  picker for L4+.
- `api_dashboard` special-cases the Direct subject and reports customers/cases where
  `handlers.user_email = 'direct'`.
- Invariant preserved: Direct is set only when no real handler exists, and is removed the
  moment one is added.

**Pass check.** Unit: `api_dashboard('direct')` returns Direct-handled customers and is
allowed for L4+ and refused below L4. Unit: Direct never appears in
`listAssignableUsers` (it cannot hold a ticket). e2e: the Remove button is absent for
Direct and present for a real handler.

### P10 — Case on a Direct-handled customer mislabels the creator

**Root cause.** `caseHandlerOwners()` filters out `'direct'`, finds no real handlers, and
falls back to the stored `cases.owner` column — the creator. Because that fallback is
returned from the *same* function the UI uses to decide "is this person an account
handler", `formatCase()` computes `removable: false` and the modal renders
"(account handler — owner of every case on the account)" for someone who is not a handler
at all (screenshot 6).

**Change.** Separate the two concepts. `ownerList` entries carry an explicit
`source: 'handler' | 'creator' | 'manual'`. The UI labels each accordingly. The creator
fallback is removable **unless** it would leave the case with zero owners.

**Pass check.** Unit reproducing the exact reported scenario: L6 creates a customer (Direct
handler), creates a case; the resulting owner is the creator, labelled `creator`, not
`handler`. Unit: removing the last remaining owner is refused.

### P11 — Handler changes propagate to case owners

**Required behaviour.** Handler added -> owner of that customer's **active** cases. Handler
removed -> keeps every case already owned. Closed cases are never modified.

**Current architecture breaks all three**, because ownership is derived at read time.

**Change.**
- Owners become materialised per case, stored in `cases.extra_owners`.
- A one-off migration seeds every existing case's owner set from today's derived values, so
  behaviour is unchanged on the day it ships.
- `createCase` seeds owners = the customer's real handlers, or the creator when the only
  handler is Direct.
- `addHandler` appends the new handler to the owner set of that customer's cases **where
  `outcome IS NULL`** (active only).
- `removeHandler` no longer affects any case.
- Read paths (`caseOwners`, dashboard attribution, `listCases`) read the stored set.

**Pass check.** Unit for each rule: add-handler touches active cases only and leaves a
closed case's owners byte-identical; remove-handler leaves all cases unchanged; a case
always has >= 1 owner. Migration: for every existing case, the owner set computed *before*
the migration equals the stored set *after* it — asserted per case, not in aggregate. This
is the single most important check in the batch.

---

## 4. Testing strategy

- **TDD throughout.** Failing test first. No implementation lands without a test that failed
  before it.
- **Migrations are verified with before/after assertions on real row counts**, not unit
  tests alone. Four migrations carry data risk: P7 backfill, P8 SEI conversion, P11 owner
  seed, P1 handler removal.
- **P11's seed migration is the highest-risk change in this batch.** Its check is exact
  per-case equivalence of derived-before vs stored-after.
- Existing gates must stay green: `npm run typecheck`, `npm run test`, `npm run build`,
  `npm run test:e2e`.
- The regenerated legacy artifact must satisfy `new Function(legacyAppScript)` without
  throwing — the syntax check whose absence caused the generator to be frozen originally.

## 5. Deliverable

`migrated-crm/docs/CRM-Points-Response.docx` — for each of the eleven points: what the
manager asked, what was found, what changed, and the current correct behaviour. Includes
the P2 role matrix, the P3 security findings and the P4 storage estimate.

## 6. Explicitly out of scope

- No change to the derived-vs-stored model for anything other than case ownership.
- No renaming of `tags` in the database or RPC layer.
- No rewrite of the legacy client into React (the generator fix makes this unnecessary now).
- No invented Schneider names in the SEI list.
- The pre-existing `public.settings` drift issue (documented in `CONTEXT.md`) is **not**
  fixed here as a general matter. One narrow exception: P8's `SEI_NAMES` must read live
  from `public.settings`, because an admin-managed list that the app never reads back would
  reproduce the drift bug by construction — the Admin screen would appear to save and have
  no effect.

  P7 deliberately does **not** need this. The location list stays on the hardcoded
  `DEFAULT_SETTINGS.TAGS` constant, with `TO BE FILLED` added to it. Locations are not
  admin-edited as part of this batch, so widening P7 to live settings would add migration
  risk for no requested benefit.
