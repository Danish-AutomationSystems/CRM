# Optional Case Priority Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give a case an optional High/Medium/Low priority, settable when the case is raised, changeable afterwards with every change logged, visible on all four surfaces where a case renders, and filterable on the Cases tab.

**Architecture:** One new nullable-in-spirit column (`cases.priority text not null default ''`) carried through the five statements that touch `public.cases`, validated server-side against the existing `DEFAULT_SETTINGS.PRIORITIES`, exposed through one new RPC modelled on `api_setCaseStage`, and rendered with the `priChip()` helper the client already has. Every piece copies an existing precedent rather than inventing one.

**Tech Stack:** TypeScript, Next.js 15 App Router, `postgres.js`, Supabase Postgres 17.6, vitest, Playwright.

## Global Constraints

- **Design spec:** `docs/superpowers/specs/2026-08-18-case-priority-design.md`. Read it first.
- **Branch:** `feat/case-priority`, already created, spec already committed on it.
- **Run everything from** `D:\AutomationSystems\CRM\migrated-crm`. Windows. Use the PowerShell tool. Never work in the parent directory `D:\AutomationSystems\CRM` — that is the old Apps Script project.
- **TDD is mandatory.** Every code change is preceded by a test that is run and *seen to fail* first. A test that passes before the implementation exists is a broken test, not a head start — report it rather than moving on. **One deliberate exemption**, ruled on by the project owner and carrying an explanatory code comment: the `updateCase` service-level regression test in Task 5. Do not remove it, and do not remove its comment.
- **Baseline that must not regress: 382 vitest tests and 23 Playwright tests currently pass.**
- **Unset priority is the empty string `''`, never `null`, never a default of `'Medium'`.** Existing cases must render byte-identically to today after this ships.
- **No backfill.** Every existing case keeps an empty priority. Explicitly confirmed by the project owner.
- **Never hand-edit `src/app/crm/legacy-full.generated.ts`.** Edit `docs/source-appscript/Index.html` and run `node scripts/port-legacy-index.mjs`.
- **Never commit secrets.** Do not open, read, or echo `.env.local`. Do not print any database URL, password, service-role key, or OAuth token.
- Playwright needs env vars or the dev server will not boot:
  `$env:NEXT_PUBLIC_SUPABASE_URL="http://127.0.0.1:3999"; $env:NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY="dummy-key-for-e2e"; npx playwright test`
  **Never pipe Playwright through `tail` or `head`** — it masks the exit code and a failing run reports as success.
- **Do not apply the migration to production during Tasks 1-8.** Task 9 owns that, after the full gate passes and a backup exists.

---

## File Structure

| File | Responsibility | Change |
|---|---|---|
| `supabase/migrations/0011_case_priority.sql` | Adds the column and its partial index | **Create** |
| `src/server/cases/repository.ts` | `public.cases` SQL | **Modify** — `CaseDbRow`, `toCase`, and its four statements |
| `src/server/cases/repository.test.ts` | Source-parsing column-parity guards | **Modify** — new `public.cases` guards |
| `src/server/cases/service.ts` | Case business logic | **Modify** — `CaseRow`, `CaseInput`, `CaseListFilter`, `createCase`, `quickLog`, `setCasePriority`, `listCases`, `formatCase` |
| `src/server/cases/service.test.ts` | Unit tests + `FakeCaseRepository` | **Modify** |
| `src/server/cases/rpc.ts` | RPC registration | **Modify** — `api_setCasePriority` |
| `src/server/dashboard/service.ts` | Dashboard aggregation | **Modify** — `openMine` and `tickets` payloads |
| `src/server/dashboard/service.test.ts` | Dashboard tests + fake | **Modify** |
| `src/server/customers/repository.ts` | The **fifth** `public.cases` read site | **Modify** — `listCasesByCustomer` |
| `src/server/customers/repository.test.ts` | Guard for that fifth site | **Create** |
| `src/server/customers/service.ts` | `CustomerCaseSummary` | **Modify** |
| `src/server/customers/service.test.ts` | Unit tests + fake | **Modify** |
| `src/server/integration/concurrency.test.ts` | Fake | **Modify** — `CaseRow` fixtures |
| `src/server/integration/crm-flows.test.ts` | Fake | **Modify** — `CaseRow` fixtures |
| `docs/source-appscript/Index.html` | Legacy client source of truth | **Modify** — 8 sites |
| `src/app/crm/legacy-full.generated.ts` | Generated client | **Regenerate only** |
| `CONTEXT.md` | Project context | **Modify** — Task 9 |

---

### Task 1: The migration

**Files:**
- Create: `supabase/migrations/0011_case_priority.sql`

**Interfaces:**
- Produces: the column `public.cases.priority`, type `text`, `not null`, default `''`. Every later task depends on this name and type.

- [ ] **Step 1: Write the migration**

Create `supabase/migrations/0011_case_priority.sql`:

```sql
-- Optional case priority: High / Medium / Low, or '' for "not set".
--
-- `not null default ''` mirrors public.customers.priority (0001_initial_schema.sql:24),
-- which has carried exactly this shape since the initial schema. Empty string rather
-- than NULL keeps every read path free of null-handling, and priChip('') already
-- renders nothing, so existing cases look identical after this ships.
--
-- Deliberately NO check constraint on the values. customers.priority has none, for a
-- reason: an L6 admin can edit the PRIORITIES list in Admin -> Settings, and a database
-- constraint would start rejecting saves that the UI itself offers. Validation is
-- server-side, via validOne(input, DEFAULT_SETTINGS.PRIORITIES).
--
-- NOTE: scripts/apply-migrations.mjs already wraps each file in a single transaction
-- (sql.begin), so this file must NOT issue its own BEGIN/COMMIT - doing so would commit
-- before the schema_migrations bookkeeping row is written. Everything below is atomic.

-- Fail fast rather than queueing for the ACCESS EXCLUSIVE lock behind a long read.
-- public.cases is read by the case list, the case page, and every dashboard; all of
-- them would block behind us while we waited.
set local lock_timeout = '3s';

alter table public.cases
  add column if not exists priority text not null default '';

-- Partial index: today every row is in the excluded set, so this costs nothing until
-- priorities are actually used. It exists for the Cases-tab priority filter.
create index if not exists cases_priority_idx
  on public.cases(priority)
  where priority <> '';

do $$
declare
  col_type text;
  col_nullable text;
  col_default text;
begin
  select data_type, is_nullable, column_default
    into col_type, col_nullable, col_default
    from information_schema.columns
   where table_schema = 'public'
     and table_name = 'cases'
     and column_name = 'priority';

  if col_type is null then
    raise exception 'cases.priority was not created';
  end if;

  if col_type <> 'text' then
    raise exception 'cases.priority has type %, expected text', col_type;
  end if;

  if col_nullable <> 'NO' then
    raise exception 'cases.priority must be NOT NULL';
  end if;

  if col_default is null or col_default not like '''''%' then
    raise exception 'cases.priority default is %, expected the empty string', col_default;
  end if;

  if not exists (
    select 1 from pg_indexes
     where schemaname = 'public' and indexname = 'cases_priority_idx'
  ) then
    raise exception 'cases_priority_idx was not created';
  end if;

  -- Deliberately no row-level probe here. The column is NOT NULL two statements up,
  -- so any `where priority is null` predicate can never be true - and because it can
  -- never be true, Postgres would still seq-scan public.cases to prove it, inside this
  -- transaction, holding ACCESS EXCLUSIVE and blocking every reader. Without it,
  -- `add column ... not null default ''` is metadata-only on PG 11+.
end $$;
```

Note the `col_default not like '''''%'` test: in SQL a literal single quote is doubled, so
that pattern is `''%` — it asserts the default *starts with* an empty-string literal, which
tolerates Postgres rendering it as `''::text`.

- [ ] **Step 2: Confirm the backup and restore scripts already cover this**

Read `scripts/backup-database.mjs` and `scripts/restore-database.mjs`. Find how each one
enumerates the columns of `public.cases`.

- If they do `select *` / build the column list dynamically, **no change is needed** — record
  in your report the exact line that proves it.
- If either hardcodes a column list for `cases`, **add `priority` to it**. The
  `case_attachments` work found that table missing from both scripts entirely, and it was
  caught only by looking. Look.

Do not run either script in this task. Do not connect to any database in this task.

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/0011_case_priority.sql
git commit -m "feat(db): add optional cases.priority column

text not null default '', mirroring customers.priority. No check
constraint, deliberately: the PRIORITIES list is admin-editable and a
constraint would reject saves the UI offers. Self-verifying, and
metadata-only on PG 11+ so the ACCESS EXCLUSIVE lock is momentary."
```

---

### Task 2: Carry the column through the repository

This is the highest-risk task in the plan. `public.cases` is read and written in **four**
statements, and `updateCase` in particular rewrites its full column list from a merged row —
a column missing from its `set` clause is **silently never written**, so setting a priority
would appear to succeed and do nothing. `createQuote` shipped that exact defect to production.

The guards come first, and they must be seen to fail.

**Files:**
- Modify: `src/server/cases/repository.test.ts`
- Modify: `src/server/cases/repository.ts` (`CaseDbRow` ~line 54, `toCase` line 154, `getCase` line 325, `listCases` line 338, `createCase` line 349, `updateCase` line 365)

**Interfaces:**
- Consumes: `public.cases.priority` from Task 1.
- Produces: `CaseRow.priority: string` — every later task reads and writes this property name.

- [ ] **Step 1: Write the failing parity guards**

Add to `src/server/cases/repository.test.ts`. The file already has `methodBody`,
`selectColumns`, and the `migrationAddedActivityLogColumns` pattern; these are the `cases`
equivalents. Place them after the existing helpers and before the `describe` blocks.

```ts
/**
 * EVERY column of public.cases: the initial CREATE TABLE plus every later ALTER.
 *
 * Deliberately not limited to migration-added columns. A guard over only the new
 * ones would protect `priority` and leave the original seventeen unguarded - drop
 * `outcome_note` from updateCase's set clause and nothing would object. The defect
 * class is "a statement stops carrying a column", and it does not care when the
 * column was born.
 */
function allCasesColumns(): string[] {
  const dir = path.join(__dirname, '..', '..', '..', 'supabase', 'migrations');
  const names = new Set<string>();

  const initial = fs.readFileSync(path.join(dir, '0001_initial_schema.sql'), 'utf8');
  const created = initial.match(/create table if not exists public\.cases \(([\s\S]*?)\n\);/);
  if (!created) throw new Error('public.cases CREATE TABLE not found');
  for (const line of created[1].split('\n')) {
    const trimmed = line.trim();
    // Skip table-level constraints; only column definitions start with a bare name.
    if (!trimmed || /^(constraint|primary key|unique|check|foreign key)\b/i.test(trimmed)) continue;
    const name = trimmed.split(/\s+/)[0].replace(/,$/, '');
    if (/^[a-z_][a-z0-9_]*$/.test(name)) names.add(name);
  }

  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
    const migrationSql = fs.readFileSync(path.join(dir, file), 'utf8');
    const statements = migrationSql.matchAll(/alter\s+table\s+(?:only\s+)?public\.cases\b([\s\S]*?);/gi);
    for (const statement of statements) {
      const adds = statement[1].matchAll(/add\s+column\s+(?:if\s+not\s+exists\s+)?"?([a-z_][a-z0-9_]*)"?/gi);
      for (const add of adds) names.add(add[1].toLowerCase());
    }
  }

  return [...names].sort();
}

/**
 * Columns a given statement is allowed NOT to carry, each with a reason.
 *
 * Every entry here is a deliberate, reviewed exemption. Adding to this list is
 * how the guard gets weakened, so an entry without a reason is a defect.
 */
const CASES_EXEMPT: Record<string, Record<string, string>> = {
  // createCase does not name `version`: the column defaults to 1.
  createCase: { version: 'defaults to 1 on insert' },
  // updateCase identifies the row by case_id and must never rewrite creation facts.
  updateCase: {
    case_id: 'the WHERE key, never in the SET clause',
    created_by: 'creation fact, immutable',
    created_at: 'creation fact, immutable'
  },
  getCase: {},
  listCases: {}
};

function missingFrom(statement: string, carried: string[]): string[] {
  const exempt = CASES_EXEMPT[statement];
  return allCasesColumns().filter((c) => !carried.includes(c) && !(c in exempt));
}

/**
 * Columns added to public.cases by a migration after the initial schema.
 * Kept as a separate, narrower derivation purely to prove the guard above is
 * live: if this ever returns nothing, the migration parsing has broken.
 */
function migrationAddedCasesColumns(): string[] {
  const dir = path.join(__dirname, '..', '..', '..', 'supabase', 'migrations');
  const names = new Set<string>();

  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
    const migrationSql = fs.readFileSync(path.join(dir, file), 'utf8');
    const statements = migrationSql.matchAll(/alter\s+table\s+(?:only\s+)?public\.cases\b([\s\S]*?);/gi);
    for (const statement of statements) {
      const adds = statement[1].matchAll(/add\s+column\s+(?:if\s+not\s+exists\s+)?"?([a-z_][a-z0-9_]*)"?/gi);
      for (const add of adds) names.add(add[1].toLowerCase());
    }
  }

  return [...names].sort();
}

function casesInsertColumns(): string[] {
  const body = methodBody('createCase');
  const match = body.match(/insert into public\.cases \(([^)]*)\)/);
  if (!match) throw new Error('createCase insert column list not found');
  return match[1].split(',').map((c) => c.trim()).filter(Boolean);
}

/**
 * The left-hand side of every assignment in updateCase's `set` clause.
 *
 * updateCase is not an INSERT and not a SELECT: it merges `fields` over the
 * existing row and rewrites the full column list. A column missing here is
 * never written, and nothing errors - which is why it gets its own parser
 * rather than being folded into one of the others.
 */
function casesUpdateSetColumns(): string[] {
  const body = methodBody('updateCase');
  const match = body.match(/update public\.cases\s*\n\s*set\b([\s\S]*?)\bwhere\b/);
  if (!match) throw new Error('updateCase set clause not found');
  return [...match[1].matchAll(/(?:^|,)\s*([a-z_][a-z0-9_]*)\s*=/gi)].map((m) => m[1].toLowerCase());
}
```

Then the tests:

```ts
describe('cases repository public.cases statements', () => {
  it('finds the migration-added columns, so the derivation cannot pass vacuously', () => {
    // If this ever legitimately drops to zero, every guard below stops guarding.
    expect(migrationAddedCasesColumns()).toContain('priority');
  });

  it('parses a plausible createCase insert list, so a failed regex cannot pass vacuously', () => {
    expect(casesInsertColumns().length).toBeGreaterThan(10);
    expect(casesInsertColumns()).toContain('case_id');
  });

  it('parses a plausible updateCase set list, so a failed regex cannot pass vacuously', () => {
    expect(casesUpdateSetColumns().length).toBeGreaterThan(10);
    expect(casesUpdateSetColumns()).toContain('title');
  });

  it('derives the full public.cases column set, so no guard below can pass vacuously', () => {
    const all = allCasesColumns();
    expect(all.length).toBeGreaterThan(15);
    expect(all).toContain('case_id');
    expect(all).toContain('outcome_note');
    expect(all).toContain('priority');
  });

  it('createCase writes every public.cases column', () => {
    const missing = missingFrom('createCase', casesInsertColumns());
    expect(missing, `createCase does not write public.cases column(s): ${missing.join(', ')}`).toEqual([]);
  });

  it('updateCase writes every public.cases column', () => {
    const missing = missingFrom('updateCase', casesUpdateSetColumns());
    expect(missing, `updateCase does not write public.cases column(s): ${missing.join(', ')}`).toEqual([]);
  });

  it('getCase selects every public.cases column', () => {
    const missing = missingFrom('getCase', selectColumns('getCase', 'cases'));
    expect(missing, `getCase does not select public.cases column(s): ${missing.join(', ')}`).toEqual([]);
  });

  it('listCases selects every public.cases column', () => {
    const missing = missingFrom('listCases', selectColumns('listCases', 'cases'));
    expect(missing, `listCases does not select public.cases column(s): ${missing.join(', ')}`).toEqual([]);
  });

  it('writes no column outside the table (typo guard)', () => {
    const all = allCasesColumns();
    for (const [name, carried] of [
      ['createCase', casesInsertColumns()],
      ['updateCase', casesUpdateSetColumns()]
    ] as const) {
      const unknown = carried.filter((c) => !all.includes(c));
      expect(unknown, `${name} names column(s) that do not exist: ${unknown.join(', ')}`).toEqual([]);
    }
  });
});
```

- [ ] **Step 2: Run the guards and verify they fail**

Run: `npx vitest run src/server/cases/repository.test.ts`

Expected: the "plausible list" and "derives the full column set" tests PASS. The four coverage
tests FAIL, each naming `priority`.

**Read the failure messages.** They must name `priority` and *only* `priority`. If a coverage
test also names other columns, the exemption list is wrong or the parser is dropping real
columns — fix that before implementing. Never widen `CASES_EXEMPT` to make a guard pass; that
is weakening the guard to silence it.

**If any of the four coverage tests passes here, stop and report it** — the parser returned an
empty list and the guard is vacuous.

- [ ] **Step 3: Add the column to the four statements**

In `src/server/cases/repository.ts`:

`CaseDbRow` (~line 54) gains, after `source`:
```ts
  priority: string | null;
```

`toCase` (line 154) gains, after `source: row.source ?? '',`:
```ts
    priority: row.priority ?? '',
```

`getCase` (line 327) and `listCases` (line 340) — both select lists become:
```ts
      select case_id, customer_id, title, details, source, priority, stage, outcome, order_value,
             won_categories, outcome_note, owner, extra_owners, assignee, closed_on,
             created_by, created_at, updated_at
```

`createCase` (line 351) — the column list gains `priority` after `source`, and the values
tuple gains `${row.priority}` in the matching position:
```ts
      insert into public.cases (
        case_id, customer_id, title, details, source, priority, stage, outcome, order_value,
        won_categories, outcome_note, owner, extra_owners, assignee, closed_on,
        created_by, created_at, updated_at
      )
      values (
        ${row.id}, ${row.customerId}, ${row.title}, ${row.details}, ${row.source}, ${row.priority}, ${row.stage},
        ${dbOutcome(row.outcome)}, ${dbNumber(row.orderValue)}, ${joinPipe(row.wonCategories)},
        ${row.outcomeNote}, ${dbEmail(row.owner)}, ${joinPipe(row.extraOwners)}, ${dbEmail(row.assignee)},
        ${dbDate(row.closedOn)}, ${dbEmail(row.createdBy)}, ${row.createdAt}, ${row.updatedAt}
      )
```

**Count the values against the columns before moving on.** Both lists must be 18 entries.

`updateCase` (line 367) — the `set` clause gains, after `source = ${row.source},`:
```ts
        priority = ${row.priority},
```

- [ ] **Step 4: Add `priority` to `CaseRow`**

In `src/server/cases/service.ts`, find the `CaseRow` type and add, after `source: string;`:
```ts
  priority: string;
```

- [ ] **Step 5: Run the guards and the typechecker**

```
npx vitest run src/server/cases/repository.test.ts
npx tsc --noEmit
```

Expected: the guards now PASS. `tsc` will FAIL, naming every test file that builds a
`CaseRow` literal without `priority`. That is expected and is Step 6's work.

- [ ] **Step 6: Fix the fixtures the typechecker names**

`npx tsc --noEmit` names them. The known ones:
- `src/server/cases/service.test.ts` — the `caseRow()` factory at line 205 gains
  `priority: '',` after `source: 'Direct Enquiry',`.
- `src/server/dashboard/service.test.ts`, `src/server/integration/concurrency.test.ts`,
  `src/server/integration/crm-flows.test.ts` — any `CaseRow` literal gains `priority: ''`.

**Do not use `as any`, do not cast, and do not make `priority` optional on `CaseRow`.**
Making it optional would defeat the entire point: an optional property is exactly what lets a
write path forget it.

Default every fixture to `''`, not to a priority value — the fixtures represent today's
data, and today no case has a priority.

- [ ] **Step 7: Run everything**

```
npm test
npx tsc --noEmit
```

Expected: 382 baseline plus the 7 new guard tests, typecheck clean.

- [ ] **Step 8: Commit**

```bash
git add src/server/cases/repository.ts src/server/cases/repository.test.ts src/server/cases/service.ts src/server/cases/service.test.ts src/server/dashboard/service.test.ts src/server/integration/concurrency.test.ts src/server/integration/crm-flows.test.ts
git commit -m "feat(cases): carry priority through every public.cases statement

Four statements touch public.cases and all four must know about a new
column. updateCase is the dangerous one: it merges fields over the
existing row and rewrites the full column list, so a column missing from
its set clause is silently never written on every edit.

Guards are derived from the migration files rather than hardcoding
'priority', so the next column added to public.cases is protected too."
```

---

### Task 3: Set priority when a case is created

**Files:**
- Modify: `src/server/cases/service.ts` (`CaseInput` line 149, `createCase` line 615, `quickLog` line 1126)
- Modify: `src/server/cases/service.test.ts`

**Interfaces:**
- Consumes: `CaseRow.priority` from Task 2; `validOne(value, allowed)` at `service.ts:222`;
  `DEFAULT_SETTINGS.PRIORITIES` = `['High', 'Medium', 'Low']`.
- Produces: `api_createCase` and `api_quickLog` accept an optional `priority` on their input object.

- [ ] **Step 1: Write the failing tests**

Add to `src/server/cases/service.test.ts`, in the `createCase` and `quickLog` describe blocks
(match the file's existing structure — read it before writing).

```ts
  it('stores the priority a case is created with', async () => {
    const { repo, service } = makeService();

    const created = await service.createCase(sales, 'CUST-0001', {
      title: 'Urgent panel fault',
      priority: 'High'
    });

    const stored = await repo.getCase(created.id);
    expect(stored?.priority).toBe('High');
  });

  it('stores no priority when the case is created without one', async () => {
    const { repo, service } = makeService();

    const created = await service.createCase(sales, 'CUST-0001', { title: 'Routine enquiry' });

    const stored = await repo.getCase(created.id);
    expect(stored?.priority).toBe('');
  });

  it('ignores a priority outside the allowed list rather than failing the create', async () => {
    const { repo, service } = makeService();

    const created = await service.createCase(sales, 'CUST-0001', {
      title: 'Panel fault',
      priority: 'Urgent'
    });

    const stored = await repo.getCase(created.id);
    expect(stored?.priority).toBe('');
  });
```

And for quick log — this one exists specifically because `QuickLogInput` already has a
`newCustomer.priority` meaning the *customer's* priority, and the new top-level `priority`
means the *case's*. They are different fields on the same payload:

```ts
  it('quick log stores the case priority without confusing it with the new customer priority', async () => {
    const { repo, service } = makeService();

    const logged = await service.quickLog(sales, {
      newCustomer: { name: 'Fresh Co', tag: 'Punjab', priority: 'Low' },
      title: 'Site visit request',
      priority: 'High'
    });

    const storedCase = await repo.getCase(logged.caseId);
    const storedCustomer = await repo.getCustomer(logged.customerId);
    expect(storedCase?.priority).toBe('High');
    expect(storedCustomer?.priority).toBe('Low');
  });

  it('quick log stores no case priority when none is given', async () => {
    const { repo, service } = makeService();

    const logged = await service.quickLog(sales, {
      customerId: 'CUST-0001',
      title: 'Called about spares'
    });

    expect((await repo.getCase(logged.caseId))?.priority).toBe('');
  });
```

**Check the helpers before using them.** `makeService()`, `sales`, and the customer fixtures
are the file's existing ones — read their definitions and adapt if the shapes differ. Confirm
the fake repository's `getCustomer` returns something carrying `priority`; if it does not,
assert the customer priority through whatever the fake does expose rather than inventing a
new fake method.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/server/cases/service.test.ts`

Expected: FAIL. The "stores the priority" and quick-log tests fail with `''` received where
`'High'` was expected. The two "stores no priority" tests may already pass — that is fine and
expected, since `CaseRow.priority` exists but nothing sets it. Note it in your report rather
than forcing them to fail.

- [ ] **Step 3: Implement**

`CaseInput` (line 149) gains, after `source: unknown;`:
```ts
  priority: unknown;
```

`createCase`'s row literal (line ~645) gains, after `source: asText(input.source),`:
```ts
          priority: validOne(input.priority, DEFAULT_SETTINGS.PRIORITIES),
```

`QuickLogInput` gains a top-level `priority: unknown;` — **not** inside `newCustomer`, which
already has its own `priority` meaning the customer's.

`quickLog`'s row literal (line ~1188) gains, after `source: '',`:
```ts
          priority: validOne(input.priority, DEFAULT_SETTINGS.PRIORITIES),
```

`validOne` returns `''` for anything not in the allowed list, so an absent, empty, or junk
value all yield no priority with no error. That is the intended behaviour and matches how
`stage`, `type`, and `category` are already validated.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/server/cases/service.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/server/cases/service.ts src/server/cases/service.test.ts
git commit -m "feat(cases): accept an optional priority when a case is created

Both creation paths - the New Case modal and Quick log. validOne yields
'' for anything outside PRIORITIES, so absent, empty and junk values all
mean 'no priority' without failing the create.

QuickLogInput now has priority at two levels: newCustomer.priority is the
customer's, the new top-level one is the case's. A test pins both."
```

---

### Task 4: Change priority afterwards, logged in history

**Files:**
- Modify: `src/server/cases/service.ts` (new method after `setCaseStage`, line ~695)
- Modify: `src/server/cases/service.test.ts`
- Modify: `src/server/cases/rpc.ts`

**Interfaces:**
- Consumes: `loadVisibleCase(repo, user, id)`, `repo.updateCase`, `repo.logActivity`, all as
  used by `setCaseStage` at `service.ts:695`.
- Produces: `service.setCasePriority(user: CrmContext, id: string, priorityInput: unknown): Promise<{ ok: true }>`,
  registered as RPC `api_setCasePriority(caseId, priority)`.

- [ ] **Step 1: Write the failing tests**

```ts
  it('changes the priority and logs the change in history', async () => {
    const { repo, service } = makeService();
    repo.cases = [caseRow({ id: 'CASE-2026-0001', priority: 'Low' })];

    await service.setCasePriority(sales, 'CASE-2026-0001', 'High');

    expect((await repo.getCase('CASE-2026-0001'))?.priority).toBe('High');
    const logged = repo.activity.filter((entry) => entry.action === 'CASE_PRIORITY');
    expect(logged).toHaveLength(1);
    expect(logged[0].details).toBe('Low -> High');
    expect(logged[0].entity).toBe('CASE-2026-0001');
  });

  it('clears the priority when given an empty string', async () => {
    const { repo, service } = makeService();
    repo.cases = [caseRow({ id: 'CASE-2026-0001', priority: 'High' })];

    await service.setCasePriority(sales, 'CASE-2026-0001', '');

    expect((await repo.getCase('CASE-2026-0001'))?.priority).toBe('');
    expect(repo.activity.filter((e) => e.action === 'CASE_PRIORITY')[0].details).toBe('High -> -');
  });

  it('writes nothing and logs nothing when the priority is unchanged', async () => {
    const { repo, service } = makeService();
    repo.cases = [caseRow({ id: 'CASE-2026-0001', priority: 'Medium' })];

    await service.setCasePriority(sales, 'CASE-2026-0001', 'Medium');

    expect(repo.activity.filter((e) => e.action === 'CASE_PRIORITY')).toEqual([]);
  });

  it('rejects a priority outside the allowed list', async () => {
    const { repo, service } = makeService();
    repo.cases = [caseRow({ id: 'CASE-2026-0001', priority: 'Low' })];

    await expect(service.setCasePriority(sales, 'CASE-2026-0001', 'Urgent')).rejects.toThrow(/not a valid priority/i);
    expect((await repo.getCase('CASE-2026-0001'))?.priority).toBe('Low');
  });

  it('allows a priority change on a closed case', async () => {
    const { repo, service } = makeService();
    repo.cases = [caseRow({ id: 'CASE-2026-0001', priority: 'Low', outcome: 'Won', orderValue: 5000, wonCategories: ['Drives'], closedOn: '2026-08-01T00:00:00.000Z', assignee: '' })];

    await service.setCasePriority(sales, 'CASE-2026-0001', 'High');

    expect((await repo.getCase('CASE-2026-0001'))?.priority).toBe('High');
  });

  it('denies a user who cannot see the case, without revealing that it exists', async () => {
    const { repo, service } = makeService();
    repo.cases = [caseRow({ id: 'CASE-2026-0001', priority: 'Low' })];

    await expect(service.setCasePriority(outsider, 'CASE-2026-0001', 'High')).rejects.toThrow();
    expect((await repo.getCase('CASE-2026-0001'))?.priority).toBe('Low');
  });
```

**On the last test:** `outsider` must be a user who genuinely cannot see this case — not a
handler, not an owner, not the assignee. The attachments work found a pre-existing test whose
"outsider" was actually a registered handler, so it had never tested denial at all. **Verify
your chosen fixture is denied by checking an existing `loadVisibleCase`-based denial test in
this same file and reusing its user**, rather than constructing a new one and assuming.

Also confirm the fake exposes logged activity as `repo.activity` with `action`/`entity`/`details`
fields — read the fake before writing these assertions and adapt to what it actually records.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/server/cases/service.test.ts`
Expected: FAIL — `service.setCasePriority is not a function`.

- [ ] **Step 3: Implement the service method**

In `src/server/cases/service.ts`, immediately after `setCaseStage` ends:

```ts
    async setCasePriority(user: CrmContext, id: string, priorityInput: unknown) {
      const priority = asText(priorityInput);
      const { row } = await loadVisibleCase(repo, user, id);
      // '' is allowed and means "clear it" - priority is optional, so it must be removable.
      if (priority && !(DEFAULT_SETTINGS.PRIORITIES as readonly string[]).includes(priority)) {
        throw new Error(`"${priority}" is not a valid priority.`);
      }
      // No block on a closed case. setCaseStage refuses on Won/Lost because a closed case
      // has no meaningful stage; priority carries no such contradiction.
      if (row.priority === priority) return { ok: true };

      await repo.updateCase(id, { priority, updatedAt: nowIso() });
      await repo.logActivity({
        action: 'CASE_PRIORITY',
        entity: id,
        customerId: row.customerId,
        details: `${row.priority || '-'} -> ${priority || '-'}`,
        who: normalizeEmail(user.email)
      });
      return { ok: true };
    },
```

The access check runs on line two, before validation — so an outsider passing a junk priority
gets the access error, not a validation error that would confirm the case exists.

- [ ] **Step 4: Register the RPC**

In `src/server/cases/rpc.ts`, after the `api_setCaseStage` registration:

```ts
registerRpc(
  'api_setCasePriority',
  ({ args, context }) => service.setCasePriority(context, String(args[0] ?? ''), args[1]),
  { read: false }
);
```

- [ ] **Step 5: Run the tests to verify they pass**

```
npx vitest run src/server/cases/service.test.ts
npm test
```

Expected: PASS. If `src/server/rpc/api-parity.test.ts` fails, read it — it may maintain a list
of expected RPC names that the new one must join. Add it there; do not weaken the test.

- [ ] **Step 6: Commit**

```bash
git add src/server/cases/service.ts src/server/cases/service.test.ts src/server/cases/rpc.ts
git commit -m "feat(cases): api_setCasePriority, logged as CASE_PRIORITY

Modelled on setCaseStage: same loadVisibleCase access check, same
early-return on no-op, same 'old -> new' history format. Empty string
clears the priority, since the field is optional. Unlike stage, a closed
case is not blocked - a closed case has no meaningful stage, but priority
carries no such contradiction."
```

---

### Task 5: Filter by priority, and put it in the payloads

**Files:**
- Modify: `src/server/cases/service.ts` (`CaseListFilter` line 165, `formatCase` line 330, `listCases` predicate line 1088 and output map line 1107)
- Modify: `src/server/cases/service.test.ts`

**Interfaces:**
- Consumes: `CaseRow.priority` from Task 2.
- Produces: `api_listCases` accepts `priority` on its filter object; both the `api_getCase`
  and `api_listCases` payloads carry a `priority` string. Task 8's client reads both.

- [ ] **Step 1: Write the failing tests**

```ts
  it('filters the case list by priority', async () => {
    const { repo, service } = makeService();
    repo.cases = [
      caseRow({ id: 'CASE-2026-0001', priority: 'High' }),
      caseRow({ id: 'CASE-2026-0002', priority: 'Low' }),
      caseRow({ id: 'CASE-2026-0003', priority: '' })
    ];

    const listed = await service.listCases(sales, { priority: 'High' });

    expect(listed.map((row) => row.id)).toEqual(['CASE-2026-0001']);
  });

  it('returns every visible case when no priority filter is given', async () => {
    const { repo, service } = makeService();
    repo.cases = [
      caseRow({ id: 'CASE-2026-0001', priority: 'High' }),
      caseRow({ id: 'CASE-2026-0002', priority: '' })
    ];

    const listed = await service.listCases(sales, {});

    expect(listed.map((row) => row.id).sort()).toEqual(['CASE-2026-0001', 'CASE-2026-0002']);
  });

  it('carries the priority in the case list payload', async () => {
    const { repo, service } = makeService();
    repo.cases = [caseRow({ id: 'CASE-2026-0001', priority: 'Medium' })];

    const listed = await service.listCases(sales, {});

    expect(listed[0].priority).toBe('Medium');
  });

  // Documents the requirement at the service level. It passes before the SQL is
  // correct, because the in-memory fake merges objects and cannot reproduce a
  // missing `set` clause - the real defence is the casesUpdateSetColumns guard in
  // repository.test.ts. Kept deliberately, by the project owner's ruling: without
  // it nothing in the service layer states that editing a title must not wipe the
  // priority. Do not delete this test or this comment.
  it('leaves an existing priority intact when an unrelated field is edited', async () => {
    const { repo, service } = makeService();
    repo.cases = [caseRow({ id: 'CASE-2026-0001', priority: 'High' })];

    await service.updateCase(sales, 'CASE-2026-0001', { title: 'Renamed case' });

    const stored = await repo.getCase('CASE-2026-0001');
    expect(stored?.title).toBe('Renamed case');
    expect(stored?.priority).toBe('High');
  });

  it('carries the priority in the case detail payload', async () => {
    const { repo, service } = makeService();
    repo.cases = [caseRow({ id: 'CASE-2026-0001', priority: 'Medium' })];

    const detail = await service.getCase(sales, 'CASE-2026-0001');

    expect(detail.case.priority).toBe('Medium');
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/server/cases/service.test.ts`
Expected: FAIL. The filter test returns all three cases; the payload tests get `undefined`.

The `updateCase` regression test will very likely **pass** already, because the in-memory fake
merges objects and cannot reproduce a missing SQL `set` clause. Keep it anyway and say so in your
report: it documents the requirement at the service level, while Task 2's `casesUpdateSetColumns`
guard is what actually defends the SQL. Do not treat its passing as evidence the SQL is correct.

- [ ] **Step 3: Implement**

`CaseListFilter` (line 165) gains:
```ts
  priority: unknown;
```

In `listCases`, beside the existing `const stage = asText(filter.stage);`:
```ts
      const priority = asText(filter.priority);
```

and in the predicate, immediately after the existing stage line:
```ts
          if (priority && row.priority !== priority) return false;
```

In the `listCases` output map (line ~1110), after `stage: row.stage,`:
```ts
            priority: row.priority,
```

In `formatCase` (line 330), after `source: row.source,`:
```ts
    priority: row.priority,
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/server/cases/service.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/server/cases/service.ts src/server/cases/service.test.ts
git commit -m "feat(cases): priority filter and priority in both case payloads

In-memory filtering alongside the existing stage/outcome/query filters,
consistent with the rest of listCases. Pushing filters into SQL remains
the separately recorded pagination follow-up."
```

---

### Task 6: Show priority on the dashboard

The dashboard does **not** go through `listCases`. It builds its own payload, and widening
`CaseRow` will not reach it — the fields are enumerated by hand in two places.

**Files:**
- Modify: `src/server/dashboard/service.ts` (the `openMine` and `tickets` array types at lines 123-124, and the two `.push(...)` calls at lines 138 and 143)
- Modify: `src/server/dashboard/service.test.ts`

**Interfaces:**
- Consumes: `CaseRow.priority` from Task 2.
- Produces: `api_dashboard`'s `cases[]` and `tickets[]` entries each carry a `priority` string.
  Task 8's `openCasesHTML` reads it.

- [ ] **Step 1: Write the failing test**

```ts
  it('carries the case priority into both dashboard case lists', async () => {
    const { repo, dashboard } = makeService();
    repo.cases = [caseRow({ id: 'CASE-2026-0001', priority: 'High' })];

    const dash = await dashboard.dashboard(sales, sales.email);

    expect(dash.cases[0].priority).toBe('High');
    expect(dash.tickets[0].priority).toBe('High');
  });
```

**Read the file's existing dashboard tests first** and match their fixture style, their
`makeService()` shape. The destructuring and call above match
`src/server/dashboard/service.test.ts:411` and `:421` — `const { repo, dashboard } = makeService()`
then `await dashboard.dashboard(sales, sales.email)` — but confirm against the file. The fixture must be a case that is both **owned by** and
**assigned to** the subject, so that it lands in `openMine` (`dash.cases`) *and* `tickets`;
copy an existing test's fixture that already appears in both lists rather than constructing
one and hoping.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/server/dashboard/service.test.ts`
Expected: FAIL — `priority` is `undefined` on both.

- [ ] **Step 3: Implement**

Both array type annotations (lines 123-124) become:
```ts
    const openMine: Array<{ id: string; title: string; customerId: string; customerName: string; stage: string; priority: string }> = [];
    const tickets: Array<{ id: string; title: string; customerId: string; customerName: string; stage: string; priority: string }> = [];
```

Both pushes gain `priority: row.priority`:
```ts
        openMine.push({ id: row.id, title: row.title, customerId: row.customerId, customerName, stage: row.stage, priority: row.priority });
```
```ts
        tickets.push({ id: row.id, title: row.title, customerId: row.customerId, customerName, stage: row.stage, priority: row.priority });
```

- [ ] **Step 4: Run the tests to verify they pass**

```
npx vitest run src/server/dashboard/service.test.ts
npm test
npx tsc --noEmit
```

Expected: PASS, typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add src/server/dashboard/service.ts src/server/dashboard/service.test.ts
git commit -m "feat(dashboard): carry case priority into both dashboard case lists

The dashboard enumerates its payload fields by hand rather than passing
CaseRow through, so widening the row does not reach it. Both openMine and
tickets needed the field explicitly."
```

---

### Task 7: Carry priority into the customer detail cases table

**There is a fifth `public.cases` read site, and it lives in a different file.** The Cases card
on a customer page is *not* fed by `api_listCases`. It comes from
`src/server/customers/repository.ts:325`, `listCasesByCustomer`, which has its own SELECT, its
own row type, and its own mapper. Task 2's guards do not cover it, because they only parse
`src/server/cases/repository.ts`.

**Files:**
- Modify: `src/server/customers/repository.ts` (`CustomerCaseDbRow`, `toCustomerCase`, `listCasesByCustomer` line 325)
- Modify: `src/server/customers/service.ts` (`CustomerCaseSummary` line 78)
- Create: `src/server/customers/repository.test.ts`
- Modify: `src/server/customers/service.test.ts`

**Interfaces:**
- Consumes: `public.cases.priority` from Task 1.
- Produces: `CustomerCaseSummary.priority: string`, carried on every entry of the
  `api_getCustomer` payload's `cases[]`. Task 8 Step 8 renders it.

- [ ] **Step 1: Write the failing guard**

Create `src/server/customers/repository.test.ts`:

```ts
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const source = fs.readFileSync(path.join(__dirname, 'repository.ts'), 'utf8');

function methodBody(name: string): string {
  const start = source.indexOf(`async ${name}(`);
  if (start === -1) throw new Error(`method ${name} not found in repository.ts`);
  const next = source.indexOf('
  async ', start + 1);
  return source.slice(start, next === -1 ? source.length : next);
}

/**
 * The columns listCasesByCustomer selects off public.cases, aliased `c`.
 *
 * This is the fifth statement in the codebase reading public.cases, and the only
 * one outside src/server/cases/repository.ts - so the parity guards over there do
 * not see it. The customer detail page's Cases card is fed from here.
 */
function customerCaseSelectColumns(): string[] {
  const body = methodBody('listCasesByCustomer');
  return [...body.matchAll(/c\.([a-z_][a-z0-9_]*)/gi)].map((m) => m[1].toLowerCase());
}

describe('customers repository listCasesByCustomer', () => {
  it('parses a plausible column list, so a failed regex cannot pass vacuously', () => {
    const selected = customerCaseSelectColumns();
    expect(selected.length).toBeGreaterThan(5);
    expect(selected).toContain('case_id');
  });

  it('selects the case priority', () => {
    expect(
      customerCaseSelectColumns(),
      'the customer detail Cases card renders a priority badge; this query must supply it'
    ).toContain('priority');
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/server/customers/repository.test.ts`

Expected: the "plausible column list" test PASSES, the "selects the case priority" test FAILS.

**If the first test fails too, the regex found nothing and the guard is vacuous** — fix the
parser before going further.

- [ ] **Step 3: Write the failing service test**

Add to `src/server/customers/service.test.ts`, in the `getCustomer` describe block:

```ts
  it('carries each case priority into the customer detail payload', async () => {
    const { repo, service } = makeService();
    repo.customerCases = [
      { id: 'CASE-2026-0001', customerId: 'CUST-0001', title: 'Panel fault', stage: 'Lead', outcome: '', orderValue: '', quotedValue: '', owners: [sales.email], assignee: sales.email, updatedAt: '2026-07-01T00:00:00.000Z', priority: 'High' }
    ];

    const detail = await service.getCustomer(sales, 'CUST-0001');

    expect(detail.cases[0].priority).toBe('High');
  });
```

**Read the file's fake before writing this.** `repo.customerCases` is a guess at the fake's
field name for what `listCasesByCustomer` returns — use whatever the fake actually calls it,
and match the existing tests' fixture style rather than inventing one.

- [ ] **Step 4: Run it to verify it fails**

Run: `npx vitest run src/server/customers/service.test.ts`
Expected: FAIL — either a type error on the unknown `priority` property, or `undefined` received.

- [ ] **Step 5: Implement**

`CustomerCaseSummary` (`service.ts:78`) gains, after `stage: string;`:
```ts
  priority: string;
```

`CustomerCaseDbRow` in `repository.ts` gains:
```ts
  priority: string | null;
```

`toCustomerCase` gains, after its `stage` mapping:
```ts
    priority: row.priority ?? '',
```

`listCasesByCustomer`'s select list (line 338) gains `c.priority` after `c.stage`:
```ts
      select c.case_id, c.customer_id, c.title, c.stage, c.priority, c.outcome, c.order_value,
```

- [ ] **Step 6: Run everything**

```
npx vitest run src/server/customers/
npm test
npx tsc --noEmit
```

Expected: PASS. `tsc` may name further fixtures building a `CustomerCaseSummary`; give each
`priority: ''`, never `as any` and never an optional property.

- [ ] **Step 7: Commit**

```bash
git add src/server/customers/repository.ts src/server/customers/repository.test.ts src/server/customers/service.ts src/server/customers/service.test.ts
git commit -m "feat(customers): carry case priority into the customer detail payload

listCasesByCustomer is the fifth statement in the codebase reading
public.cases and the only one outside cases/repository.ts, so the parity
guards there do not see it. It gets its own guard."
```

---

### Task 8: The client

Eight sites in `docs/source-appscript/Index.html`. `priChip()` at line 351 is **used
unmodified** — it already renders High red, Medium amber, Low grey, and returns `''` for an
unset value, which is exactly the "existing cases look identical" requirement.

**Files:**
- Modify: `docs/source-appscript/Index.html`
- Regenerate: `src/app/crm/legacy-full.generated.ts` (via the script; **never** hand-edited)
- Modify: `tests/e2e/crm-smoke.spec.ts` (Step 9 only)

**Interfaces:**
- Consumes: `api_createCase` / `api_quickLog` accepting `priority` (Task 3); `api_setCasePriority`
  (Task 4); `priority` on the `api_listCases`, `api_getCase` (Task 5) and `api_dashboard`
  (Task 6) payloads.

- [ ] **Step 1: New case modal — the picker**

In `mNewCase` (line 1303), after the "Assign to" `frow` closes and before the
`fo_orderwrap` div, insert:

```js
      '<div class="frow"><div><label>Priority</label><select id="fo_pri">'+
        '<option value="">— none —</option>'+ selOptions(S.settings.priorities || ['High','Medium','Low'], '') +
      '</select><div class="hint">Optional. Leave as none if it is not urgent.</div></div></div>'+
```

`selOptions(list, sel)` is the file's existing helper at line 429.

The `|| ['High','Medium','Low']` fallback matters: `S.settings.priorities` comes from
`bootstrap()`, and `dashboard/service.ts:267` does send `priorities`. **Verify that key name
is exactly `priorities` before relying on it** — if it differs, use the real key and drop the
fallback.

- [ ] **Step 2: New case modal — send it**

In `saveNewCase` (line 1367), change the payload line:

```js
  var d = { title:v('fo_title'), details:v('fo_det'), assignee:v('fo_owner'), priority:v('fo_pri') };
```

- [ ] **Step 3: Quick log — picker and send**

In `mQuickLog` (line 1747), the body currently has a `frow` holding the title and the stage
select. Add a third field to that same row:

```js
    '<div><label>Priority</label><select id="ql_casepri"><option value="">— none —</option>'+ selOptions(S.settings.priorities || ['High','Medium','Low'], '') +'</select></div>'+
```

**The id is `ql_casepri`, not `ql_pri`.** `ql_pri` is already taken: `saveQuickLog` reads it at
line 1805 as the *new customer's* priority. Reusing it would silently make one field feed both
values — the exact confusion the spec's naming hazard warns about, manifesting in the DOM.

Then in `saveQuickLog` (line 1798), change only the first line:

```js
  var p = { title:v('ql_title'), stage:v('ql_stage'), priority:v('ql_casepri') };
```

Leave line 1805 (`p.newCustomer = { ..., priority:v('ql_pri') }`) **exactly as it is** — that
one is the customer's priority and is correct today.

- [ ] **Step 4: Case detail header — the badge**

In `renderCase` (line 1420), the `<div class="sub">` that opens with `caseStatusChip`:

```js
      '<div class="sub" style="margin-top:5px">'+caseStatusChip(o.stage,o.outcome)+' '+priChip(o.priority)+
```

- [ ] **Step 5: Case Status card — the control**

Inside `renderCase`'s `if(d.canEdit){` block, immediately after the closing of the Stage
`frow` (the one containing `stSel`, `stNote`, and the "Update stage" button) and before the
`display:flex` button row, insert:

```js
      html += '<div class="frow" style="align-items:flex-end"><div><label>Priority</label><select id="priSel">'+
        '<option value="">— none —</option>'+ selOptions(S.settings.priorities || ['High','Medium','Low'], o.priority||'') +
        '</select></div><div style="flex:0"><button class="btn" onclick="doPriority(\''+esc(o.id)+'\')">Update priority</button></div></div>';
```

This sits **outside** the `if(o.outcome!=='Won' && o.outcome!=='Lost')` guard that wraps the
stage control — priority is changeable on a closed case, stage is not.

Then add the handler beside `doStage` (line 1644):

```js
function doPriority(id){
  gs('api_setCasePriority', id, v('priSel')).then(function(){ toast('Priority updated.'); vCase(id); }).catch(oops);
}
```

- [ ] **Step 6: Cases list table — new column**

In `renderCases` (line 1726), the header gains `Priority` after `Status`:

```js
    var html = '<div style="overflow-x:auto"><table><tr><th>ID</th><th>Title</th><th>Customer</th><th>Status</th><th>Priority</th><th class="tnum-r">Value</th><th>Owners</th><th>Assigned to</th><th>Updated</th></tr>';
```

and the row gains a matching cell after the status cell:

```js
        '<td>'+caseStatusChip(o.stage,o.outcome)+'</td><td>'+(priChip(o.priority)||'<span class="sub">—</span>')+'</td>'+
```

**Count the header cells against the row cells.** Both must be 9.

The `—` fallback appears only inside a table cell, where an empty cell would look like a
rendering fault. The badge itself is still absent for an unset priority.

- [ ] **Step 7: Cases filter bar**

In `vCases` (line 1682), after the `cf_outcome` select and before the `cf_owned` checkbox:

```js
    '<select id="cf_priority" onchange="applyCaseF()"><option value="">All priorities</option>'+
    (S.settings.priorities || ['High','Medium','Low']).map(function(p){ return '<option'+(p===f.priority?' selected':'')+'>'+esc(p)+'</option>'; }).join('')+'</select>'+
```

In `applyCaseF` (line 1704):
```js
  S.caseF = { q:v('cf_q'), stage:v('cf_stage'), outcome:v('cf_outcome'), priority:v('cf_priority'),
              owned:!!(el('cf_owned') && el('cf_owned').checked),
              assigned:!!(el('cf_assigned') && el('cf_assigned').checked) };
```

The `S` initialiser at line 252 gains `priority:''` to the `caseF` object:
```js
  custQ:'', caseF:{owned:false, assigned:false, stage:'', outcome:'Open', priority:'', q:''},
```

And `goCases` (line 613), which rebuilds `S.caseF` wholesale from a dashboard click, gains
`priority:''` — without it, clicking through from the dashboard would leave `f.priority`
undefined and the select would render with nothing selected:
```js
function goCases(f){ S.caseF = {owned:!!(f.owned||f.mine), assigned:!!f.assigned, stage:f.stage||'', outcome:f.outcome||'', priority:'', q:''}; vCases(); }
```

- [ ] **Step 8: Customer detail cases table, and the dashboard list**

In `vCustomer`, the Cases card. The header at line 1179 becomes:

```js
      html += '<table><tr><th>ID</th><th>Title</th><th>Status</th><th>Priority</th><th class="tnum-r">Value</th><th>Owners</th><th>Assigned to</th><th class="tnum-r">Quotes</th><th>Updated</th></tr>';
```

and the status cell at line 1184 gains a sibling:

```js
          '<td>'+caseStatusChip(o.stage,o.outcome)+'</td><td>'+(priChip(o.priority)||'<span class="sub">—</span>')+'</td>'+
```

**Count header cells against row cells** — this table has 8 today, 9 after. Its `o.priority`
comes from the customers service, wired up in Task 7, not from `api_listCases`.

In `openCasesHTML` (line 597), after the stage chip:
```js
      '<div class="sub">'+esc(c.customerName)+'</div></div>'+stageChip(c.stage)+priChip(c.priority)+
```

- [ ] **Step 9: Regenerate, typecheck, test**

```
node scripts/port-legacy-index.mjs
npx tsc --noEmit
npm test
```

Expected: all pass. `src/app/crm/legacy-app.test.ts` has a guard asserting the generated
script parses (`new Function(legacyAppScript)` does not throw) — if that fails, the edit
introduced a syntax error; fix it in `Index.html` and regenerate, never in the generated file.

Then add one Playwright regression to `tests/e2e/crm-smoke.spec.ts`, in the style of the
existing mocked-session case tests: a case list whose mocked payload includes one case with
`priority: 'High'` and one with `priority: ''` renders a High badge on the first and no badge
on the second. **Read the neighbouring tests and reuse their mocking helper** rather than
building a new one.

Run Playwright with the env vars from the Global Constraints. Never pipe it through `tail`.

- [ ] **Step 10: Commit**

```bash
git add docs/source-appscript/Index.html src/app/crm/legacy-full.generated.ts tests/e2e/crm-smoke.spec.ts
git commit -m "feat(crm): show and set case priority in the client

Eight sites: pickers on both create paths, a badge on all four surfaces a
case renders, a filter on the Cases tab, and an update control in the case
Status card. priChip is reused unmodified - it already returns '' for an
unset priority, so existing cases render exactly as before.

The Status-card control sits outside the Won/Lost guard that wraps the
stage control: priority is changeable on a closed case, stage is not."
```

---

### Task 9: Gate, back up, migrate, deploy, verify

**Files:** `CONTEXT.md` only, unless a gate fails.

- [ ] **Step 1: Run the complete local gate**

```
npm run typecheck
npm test
npm run build
```
plus Playwright with the env vars from the Global Constraints.

Expected: typecheck clean, **at least 382 + the new tests** passing in vitest, **at least 23**
Playwright, build succeeds.

- [ ] **Step 2: Back up the database**

```bash
node scripts/backup-database.mjs
node scripts/verify-backup.mjs backups/<the-file-it-just-wrote>.json
```

`backups/` is gitignored because it holds the entire customer dataset in plaintext. Do not
commit it, do not print its contents.

This branch has a schema change, so this is a requirement, not a precaution — the free tier
takes no automatic backups.

- [ ] **Step 3: Apply the migration**

```bash
node scripts/apply-migrations.mjs
```

Expected: `0011_case_priority.sql` applied, no exception raised by its `do $$` block. If the
block raises, the migration has rolled itself back and the database is untouched — read the
message, fix the migration, re-run.

- [ ] **Step 4: Merge and deploy**

```bash
git checkout main
git merge --no-ff feat/case-priority
git push origin main
```

Vercel deploys `main` automatically.

**The migration is applied before the merge, deliberately.** The new column is additive and
the old code never names it, so a database that is ahead of the deployed app is harmless — the
reverse is not.

- [ ] **Step 5: Verify in production**

1. Open the Cases tab. Every case listed before is still listed. The new Priority column shows
   `—` for all of them, since nothing has a priority yet.
2. Create a case **without** a priority. It saves, and shows no badge.
3. Create a case **with** High. The badge is red on the case page, in the Cases list, on the
   customer's Cases table, and on the dashboard if it is assigned to you.
4. Change it to Low on the case page. The badge turns grey, and case history shows a
   `CASE_PRIORITY` entry reading `High -> Low`.
5. Clear it back to none. History shows `Low -> -`.
6. Filter the Cases tab by High. Only High cases appear. Clear the filter; everything returns.
7. Quick log a case with a priority. It carries through.
8. Edit an unrelated field on a case that has a priority — change its title, or its stage.
   **The priority must survive.** This is the `updateCase` defect made visible; if the
   priority vanishes here, roll back immediately.

- [ ] **Step 6: Update CONTEXT.md**

Add an entry under Current Production Status, and add `0011_case_priority.sql` to the
Migrations list under the Supabase section.

`CONTEXT.md` is **stale as of 2026-08-11** and its known-wrong claims should be corrected in
the same pass, since a future agent will read them as fact:
- Line ~287 says migrations `0005`-`0008` have not been applied to any database. They have.
- Line ~299 says `quotations.upload_data` is required for storing and downloading external
  uploads. Quotations now go to Google Drive.
- Line ~626 lists the `listCases` per-case `getCustomer` N+1 as outstanding. It was fixed in
  `51fd057`.
- The four features shipped 2026-08-13/14 (`ffa5678` Drive-first quotation upload, `e44a342`
  ticket handover notes + migration 0009, `51fd057` case-list batching, `cecce07` case
  attachments + migration 0010) have no entry at all.

- [ ] **Step 7: Commit and push the context update**

```bash
git add CONTEXT.md
git commit -m "docs: record case priority, and correct four stale CONTEXT claims"
git push origin main
```

- [ ] **Step 8: Rollback procedure, if anything is wrong**

`git revert` the merge commit and push. The column can stay — it is additive and the reverted
code never names it, so leaving it costs nothing and dropping it during an incident risks more
than it saves. Drop it later, deliberately, with `alter table public.cases drop column priority;`.

---

## Follow-ups deliberately excluded

1. **Sorting or grouping the case list by priority** — the owner explicitly declined High-first
   sorting; people rely on the current newest-updated order.
2. **Making `PRIORITIES` read live from `public.settings`** — the general settings-drift issue
   recorded in `CONTEXT.md`. This feature inherits exactly the behaviour `customers.priority`
   already has, and fixing the pattern needs its own spec.
3. **Pushing the priority filter into SQL** — part of the deferred `listCases` filtering and
   pagination work.
4. **Priority-based notifications, escalation, or SLAs.**
5. **`api_beginAttachmentUpload` has no `requireLevel`** — pre-existing, unrelated, still open.
