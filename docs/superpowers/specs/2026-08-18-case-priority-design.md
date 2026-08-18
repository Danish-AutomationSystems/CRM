# Optional Case Priority — Design Spec (2026-08-18)

## Context

A case (a support ticket) carries a stage, an outcome, owners, and an assignee, but
nothing that says how urgent it is. The project owner wants an **optional** priority —
High, Medium, or Low — settable when the case is raised and visible wherever the case
is seen.

Customers already have exactly this field (`customers.priority`, `0001_initial_schema.sql:24`).
Cases do not. Almost every piece of this feature therefore has a working precedent in
the codebase, and the design deliberately copies those precedents rather than inventing
parallel ones.

## Decisions

Taken during brainstorming with the project owner:

| # | Decision | Notes |
|---|---|---|
| 1 | Values are **High / Medium / Low**, and priority is **optional**. | `DEFAULT_SETTINGS.PRIORITIES` (`settings/defaults.ts:48`) already holds exactly this list. |
| 2 | Priority is **editable after creation**, and every change is **logged in case history**. | A case that becomes urgent later must be markable as urgent, and the audit trail must say who escalated it. |
| 3 | Shown in **all four** places a case renders. | Cases list table, case detail header, customer-detail cases table, dashboard open-cases list. |
| 4 | The Cases tab gains a **priority filter**. Sort order is **unchanged**. | Owner explicitly declined High-first sorting: people rely on the current newest-updated order. |
| 5 | **Quick log gets the picker too.** | Owner's choice, against the recommendation to keep Quick log minimal for phone use. |
| 6 | Unset means **empty string**, never a default of "Medium". | `priChip('')` already returns `''`, so existing cases render byte-identically after the migration. |

## Architecture

### Data

New migration `supabase/migrations/0011_case_priority.sql`:

```sql
alter table public.cases add column if not exists priority text not null default '';
create index if not exists cases_priority_idx on public.cases(priority) where priority <> '';
```

Written with `set local lock_timeout = '3s'`, matching `0009_activity_log_note.sql`. Adding a
column with a non-volatile default is a catalogue-only operation in Postgres 11+ — it does not
rewrite the table — so the ACCESS EXCLUSIVE lock is held for microseconds. The `lock_timeout`
exists so that if some long transaction is holding a conflicting lock, this migration fails fast
instead of queueing behind it and blocking every reader of `public.cases`.

The partial index excludes the empty string. Today every row would be in that excluded set, so the
index costs nothing until priorities are actually used.

**No CHECK constraint on the values.** `customers.priority` has none, deliberately: an L6 admin can
edit the PRIORITIES list in Admin → Settings, and a database constraint would begin rejecting saves
that the UI itself offers. Validation is server-side, via the existing
`validOne(input.priority, DEFAULT_SETTINGS.PRIORITIES)` helper — the same call
`customers/service.ts:386` already makes.

### The defect class this feature is most exposed to

`public.cases` is read and written in **five** statements across **two** files. A new column must
reach all five. Four are in `src/server/cases/repository.ts`:

| Site | Line | What happens if `priority` is missed |
|---|---|---|
| `createCase` INSERT | 351 | Every new case silently stores `''`. The column default masks the omission — no error. |
| `updateCase` UPDATE | 365 | **Worse than the INSERT.** `updateCase` reads the existing row, merges `fields` over it, and rewrites the full column list. A column absent from the `set` clause is simply never written, so every unrelated edit — a title change, a stage change, an outcome — leaves priority behind, and setting a priority does nothing at all. |
| `getCase` SELECT | 327 | The case detail page shows no priority regardless of what is stored. |
| `listCases` SELECT | 340 | The list and the filter both see `undefined`. |

The fifth lives elsewhere: `listCasesByCustomer` in `src/server/customers/repository.ts:325` has
its own SELECT, its own row type, and its own mapper, and it is what feeds the Cases card on a
customer's page. A guard that parses only `cases/repository.ts` will not see it, so it gets its own.

This is not hypothetical. `createQuote` shipped to production having silently dropped all four of
its Drive columns for exactly this reason, and it survived six reviews. The guards below exist
because of that incident.

### Column-parity guard

`src/server/cases/repository.test.ts` already derives, from the migration files, the set of columns
a migration added to `activity_log`, and asserts `logActivity` writes every one of them. The same
derivation is extended to `public.cases`, asserting that all four sites in that file cover every
migration-added column. `listCasesByCustomer` gets a separate, simpler guard in a new
`src/server/customers/repository.test.ts`, asserting its select list names the column.

Derived, not hardcoded: pinning the literal string `priority` would catch this one defect and let
the next new column ship unnoticed — which is precisely what happened before.

The `updateCase` assertion needs a new parser, since that method is a `set` clause rather than an
INSERT column list or a SELECT list. It parses `set ... where` and collects the left-hand side of
each `col = ...` assignment. It must be proven non-vacuous the same way the others are: a test
asserting the parser finds a plausible number of columns, so a regex that stops matching fails
loudly instead of passing with an empty list.

### Server

`CaseRow` gains `priority: string`, mapped in `toCase` as `row.priority ?? ''`.

**`createCase`** (`service.ts:615`) — sets `priority: validOne(input.priority, DEFAULT_SETTINGS.PRIORITIES)`.
`validOne` returns `''` for anything unrecognised, so an absent, empty, or junk value all yield no
priority. `CaseInput` gains `priority: unknown`.

**`quickLog`** (`service.ts:1126`) — same treatment. **Naming hazard:** `QuickLogInput` already has
`newCustomer.priority`, which is the *customer's* priority. The new field is `input.priority` at the
top level and is the *case's*. They are different fields on the same payload and must not be
conflated; the implementation must read them by their full paths.

**`setCasePriority(user, id, priorityInput)`** — a new service method modelled directly on
`setCaseStage` (`service.ts:695`):

- `loadVisibleCase(repo, user, id)` for the access check — same first line as `setCaseStage`, and
  the reason an outsider cannot even learn the case exists.
- Rejects a value outside `DEFAULT_SETTINGS.PRIORITIES`, with one exception: `''` is accepted, and
  means "clear the priority". Priority is optional, so it must be removable.
- Returns early when the value is unchanged, writing nothing — `setCaseStage` does the same, and it
  keeps the history free of no-op entries.
- Writes `{ priority, updatedAt }` then logs `CASE_PRIORITY` with details `${row.priority || '-'} -> ${priority || '-'}`,
  mirroring `CASE_STAGE`'s format so history reads consistently.

A closed case is **not** blocked from a priority change. `setCaseStage` refuses on Won/Lost because
a closed case has no meaningful stage; priority carries no such contradiction, and forbidding it
would add a rule nobody asked for.

**`listCases`** (`service.ts:1087`) — `CaseListFilter` gains `priority: unknown`, filtered in the
same predicate chain as `stage`: `if (priority && row.priority !== priority) return false;`. This is
in-memory JS filtering, consistent with every other filter there. Pushing filters into SQL is a
known, separately-recorded follow-up and is out of scope here.

**Payloads** — `formatCase` (`service.ts:330`, feeding `api_getCase`) and the `listCases` output map
(`service.ts:1107`) both gain `priority`.

**RPC** — `api_setCasePriority` registered in `src/server/cases/rpc.ts` with `{ read: false }`,
alongside `api_setCaseStage`.

### Access control

`setCasePriority` uses `loadVisibleCase`, which is what `setCaseStage`, `updateCase`, and
`setCaseOutcome` all use. Anyone who can edit the case can set its priority; nobody else can
observe that the case exists. No new permission level and no new access rule are introduced —
a deliberate choice, since a bespoke rule here would be a new thing to get wrong.

### Client

All changes go through `docs/source-appscript/Index.html`, regenerated with
`node scripts/port-legacy-index.mjs`. `src/app/crm/legacy-full.generated.ts` is never hand-edited.

`priChip()` (`Index.html:351`) is **used unmodified**. It already renders High as red, Medium as
amber, Low as grey, and returns `''` for an unset value.

The customer-detail table's `priority` comes from the customers service, not `api_listCases`.

| Surface | Location | Change |
|---|---|---|
| New case modal | `mNewCase`, `:1303` | Optional `<select>` beside "Assign to". `saveNewCase` (`:1367`) sends `priority`. |
| Quick log modal | `mQuickLog`, `:1747` | Same optional select beside the existing Stage picker. |
| Case detail header | `renderCase`, `:1420` | `priChip(o.priority)` next to `caseStatusChip`. |
| Case Status card | `renderCase`, `:1420` (Status card) | A priority `<select>` beside the Stage control, guarded by `d.canEdit`, calling `api_setCasePriority`. Includes a blank option so priority can be cleared. |
| Cases list table | `renderCases`, `:1726` | New `Priority` column after `Status`. |
| Cases filter bar | `vCases`, `:1690` | `cf_priority` select; `applyCaseF` (`:1704`) carries it into `S.caseF`. |
| Customer detail cases table | `vCustomer`, `:1179` | New `Priority` column after `Status`. |
| Dashboard open cases | `openCasesHTML`, `:597` | `priChip(c.priority)` beside the existing stage chip. |

The dashboard list is fed by its own service, not by `listCases`. Its payload is built at
`src/server/dashboard/service.ts:124` (the `tickets` array type) and pushed at `:143`, and it
carries only `id`, `title`, `customerId`, `customerName`, and `stage`. **Widening `CaseRow` alone
will not put a priority on the dashboard** — both of those lines must gain the field explicitly, and
the dashboard service has its own in-memory fake to keep in step.

## Testing

Unit tests, at the service boundary, with the existing in-memory fakes:

- A case created with each of High, Medium, Low stores that value; created with no priority stores `''`.
- A case created with a junk priority (`'Urgent'`, `123`, `null`) stores `''` rather than erroring —
  matching how `validOne` already behaves for stage and category.
- Quick log stores the case priority, and does **not** confuse it with `newCustomer.priority`. One
  test sets both to different values and asserts each landed on the right row.
- `setCasePriority` writes the new value and logs `CASE_PRIORITY` with `Low -> High`.
- `setCasePriority` with `''` clears the priority and logs `High -> -`.
- `setCasePriority` to the current value writes nothing and logs nothing.
- `setCasePriority` rejects a value outside the allowed list.
- `setCasePriority` denies a user who cannot see the case, and the error must not reveal whether the
  case exists.
- `setCasePriority` is permitted on a Won/Lost case.
- The `listCases` priority filter returns only matching cases; an empty filter returns all, unchanged.
- **Regression:** `updateCase` on a case that has a priority leaves that priority intact. This is the
  test that would have caught the `createQuote` defect class, and it must be written to fail first
  against a `set` clause missing the column.
- `getCase` and `listCases` payloads both carry `priority`.

Repository source-parsing guards, as described above, over all four `public.cases` statements.

Playwright: the existing case-creation e2e must still pass unchanged. A case created without a
priority must render byte-identically to today — no badge, no dash, no empty cell artefact.

## Migration safety

- Additive. No existing column is altered, renamed, or dropped.
- No backfill. Every existing row gets `''` from the column default, which is the intended
  "no priority" state.
- Fully reversible: `alter table public.cases drop column priority;` with no data loss beyond the
  priorities themselves.
- Old client, new database: a browser running cached pre-deploy JS sends no `priority`, and
  `validOne` yields `''`. Nothing breaks.
- New client, old database: does not occur — the migration is applied before the merge, per the
  established sequence in this project.

`scripts/backup-database.mjs` needs no change: it backs up `public.cases` as a table, so the new
column is included automatically. This must be **verified**, not assumed, by inspecting how that
script enumerates columns — the attachments work found `case_attachments` missing from both backup
and restore, and that was only caught by looking.

## Known risks

1. **Four write/read sites, one column.** The dominant risk, addressed by the parity guard. `updateCase`
   is the dangerous one, because a miss there is silent and corrupts on every unrelated edit.
2. **`priority` means two different things in the Quick log payload.** Mitigated by an explicit test.
3. **Admin-editable PRIORITIES remain inert.** An L6 editing the priorities list in Admin writes to
   `public.settings`, but validation reads the hardcoded `DEFAULT_SETTINGS` — the pre-existing
   settings-drift issue recorded in `CONTEXT.md`. This feature does not fix it and does not worsen it;
   it inherits exactly the behaviour `customers.priority` already has.

## Explicitly out of scope

- Sorting or grouping the case list by priority (decision 4).
- Priority-based notifications, escalation rules, or SLAs.
- Making `PRIORITIES` read live from `public.settings` — the general settings-drift fix, which needs
  its own spec.
- Pushing the priority filter into SQL — part of the deferred `listCases` pagination work.
- Priority on actions, quotations, or customers (customers already have their own).
