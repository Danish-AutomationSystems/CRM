# Ticket Handover Notes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the person reassigning a ticket attach an optional internal handover note, shown in the case history beside the reassignment and near the top of the case page.

**Architecture:** A new `note` column on `activity_log`, written only by the cases repository's `logActivity`. `assignTicket` gains an optional third argument. The case page's "latest note" comes from a dedicated query joined into `getCase`'s existing `Promise.all`, rather than being derived from the 40-row history window where it could silently vanish on busy cases.

**Tech Stack:** TypeScript, Next.js 15 App Router, `postgres.js`, Supabase Postgres, vitest, Playwright.

## Global Constraints

- **Design spec:** `docs/superpowers/specs/2026-08-14-ticket-handover-notes-design.md`. Read it before starting.
- **The note is optional.** Reassigning without one must behave **byte-identically** to today: same `details` string, same return value, no behavioural change whatsoever.
- **Notes are immutable.** No edit or delete path anywhere.
- **Cap: 2000 characters.** Reject longer before any database write. Whitespace-only counts as no note.
- **Only the cases `logActivity` writes the column.** There are four separate `logActivity` implementations — `src/server/cases/repository.ts:428`, `src/server/customers/repository.ts:531`, `src/server/quotes/repository.ts:507`, `src/server/admin/service.ts:1045`. The other three must remain untouched and must keep working; the column's default is what makes that safe.
- **No new access rules.** `loadVisibleCase` already gates the case; do not add or reorder any authorisation check.
- **Client changes go through `docs/source-appscript/Index.html`**, regenerated with `node scripts/port-legacy-index.mjs`. **Never hand-edit `src/app/crm/legacy-full.generated.ts`** — it is generated and a hand edit is silently overwritten.
- **TDD is mandatory.** Every code change is preceded by a test that is run and *seen to fail* first.
- **Baseline that must not regress: 263 vitest tests and 21 Playwright tests currently pass.** Any reduction stops the work.
- Playwright needs env vars or the dev server will not boot:
  `$env:NEXT_PUBLIC_SUPABASE_URL="http://127.0.0.1:3999"; $env:NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY="dummy-key-for-e2e"; npx playwright test`
  **Never pipe Playwright through `tail` or `head`** — it masks the exit code and a failing run reports as success. That has produced a false green in this repo before.
- **Never commit secrets.** Do not open, read, or echo `.env.local`.
- Run commands from the repo root: `D:\AutomationSystems\CRM\migrated-crm`. Windows; use the PowerShell tool.

---

## File Structure

| File | Responsibility | Change |
|---|---|---|
| `supabase/migrations/0009_activity_log_note.sql` | The column | **Create** |
| `src/server/cases/repository.ts` | Case data access | **Modify** — `logActivity` writes `note`; `listActivityByEntity` selects it; new `latestHandoverNote` |
| `src/server/cases/repository.test.ts` | Column-parity guard | **Create** |
| `src/server/cases/service.ts` | Case business logic | **Modify** — `assignTicket` validation; `getCase` output; two type additions |
| `src/server/cases/service.test.ts` | Unit tests | **Modify** |
| `src/server/cases/rpc.ts` | RPC registration | **Modify** — pass a third argument |
| `docs/source-appscript/Index.html` | Client (source of truth) | **Modify** — modal textarea, history line, case-page block |
| `src/app/crm/legacy-full.generated.ts` | Generated client | **Regenerated only**, never hand-edited |
| `src/app/crm/legacy-app.test.ts` | Client tests | **Modify** |

---

### Task 1: Add the `note` column

**Files:**
- Create: `supabase/migrations/0009_activity_log_note.sql`

**Interfaces:**
- Consumes: nothing.
- Produces: `public.activity_log.note`, type `text`, `not null default ''`. Every later task depends on this column existing.

- [ ] **Step 1: Write the migration**

Create `supabase/migrations/0009_activity_log_note.sql`:

```sql
-- Ticket handover notes: an optional internal note attached to a reassignment.
--
-- `not null default ''` rather than nullable, so the three logActivity
-- implementations that do NOT write this column (customers, quotes, admin)
-- keep working untouched. Only src/server/cases/repository.ts writes it.
--
-- NOTE: scripts/apply-migrations.mjs already wraps each file in a single
-- transaction (sql.begin), so this file must NOT issue its own BEGIN/COMMIT -
-- doing so would commit before the schema_migrations bookkeeping row is
-- written. Everything below is atomic.

alter table public.activity_log
  add column if not exists note text not null default '';

do $$
declare
  col_type text;
  col_nullable text;
begin
  select data_type, is_nullable
    into col_type, col_nullable
    from information_schema.columns
   where table_schema = 'public'
     and table_name = 'activity_log'
     and column_name = 'note';

  if col_type is null then
    raise exception 'activity_log.note was not created';
  end if;

  if col_type <> 'text' then
    raise exception 'activity_log.note has type %, expected text', col_type;
  end if;

  if col_nullable <> 'NO' then
    raise exception 'activity_log.note must be NOT NULL';
  end if;

  if exists (select 1 from public.activity_log where note is null) then
    raise exception 'activity_log.note contains nulls after backfill';
  end if;
end $$;
```

The `do $$ ... end $$` block is the in-SQL self-verification pattern this repo already uses (see `supabase/migrations/0007_backfill_customer_locations.sql`) — it aborts its own transaction if the migration did not do what it claimed.

- [ ] **Step 2: Dry-run the migration**

Run: `node scripts/apply-migrations.mjs --through 0009 --dry-run`

Expected: it reports that `0009` would be applied, and does not error.

You need `DATABASE_URL` in the environment. It is in the git-ignored `.env.local`. **Do not print it, echo it, or paste it anywhere.** In PowerShell:

```powershell
$env:DATABASE_URL = (Select-String -Path .env.local -Pattern '^DATABASE_URL=').Line.Substring(13).Trim('"')
```

- [ ] **Step 3: Do NOT apply it to production yet**

Applying to the live database happens in Task 6, after the code that uses the column is written, reviewed and merged. A column that exists before its writer is harmless; a column applied and then reverted is not.

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/0009_activity_log_note.sql
git commit -m "feat(db): add activity_log.note for ticket handover notes

not null default '' so the three logActivity implementations that do not
write this column keep working untouched."
```

---

### Task 2: Repository writes and reads the note

**Files:**
- Modify: `src/server/cases/repository.ts` (`logActivity` at line 428, `listActivityByEntity` at line 371)
- Modify: `src/server/cases/service.ts` (the `CaseActivityRow` type at line 84, `CaseActivityLogEntry` at line 91, and the `CaseRepository` type at line 99)
- Create: `src/server/cases/repository.test.ts`

**Interfaces:**
- Consumes: the column from Task 1.
- Produces, relied on by Tasks 3 and 4:
  ```ts
  export type CaseActivityRow = {
    when: string;
    who: string;
    action: string;
    details: string;
    note: string;
  };

  export type CaseActivityLogEntry = {
    action: string;
    entity: string;
    customerId: string;
    details: string;
    who: string;
    note?: string;
  };

  // new member on CaseRepository
  latestHandoverNote(caseId: string): Promise<string>;
  ```
  `note` on `CaseActivityLogEntry` is **optional** so the ~40 existing `logActivity` call sites compile unchanged.

- [ ] **Step 1: Write the failing parity guard**

Create `src/server/cases/repository.test.ts`. Mirror the structure of the existing guard in `src/server/quotes/repository.test.ts` — read that file first and follow its approach of parsing SQL out of the source text. Do not connect to a database.

```ts
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const source = fs.readFileSync(path.join(__dirname, 'repository.ts'), 'utf8');

function methodBody(name: string): string {
  const start = source.indexOf(`async ${name}(`);
  if (start === -1) throw new Error(`method ${name} not found in repository.ts`);
  const next = source.indexOf('\n  async ', start + 1);
  return source.slice(start, next === -1 ? source.length : next);
}

function insertColumns(): string[] {
  const body = methodBody('logActivity');
  const match = body.match(/insert into public\.activity_log \(([^)]*)\)/);
  if (!match) throw new Error('logActivity insert column list not found');
  return match[1].split(',').map((c) => c.trim()).filter(Boolean);
}

function insertValueCount(): number {
  const body = methodBody('logActivity');
  const match = body.match(/values \(([\s\S]*?)\)\s*`/);
  if (!match) throw new Error('logActivity values list not found');
  let depth = 0;
  let count = 1;
  for (const ch of match[1]) {
    if (ch === '(') depth += 1;
    else if (ch === ')') depth -= 1;
    else if (ch === ',' && depth === 0) count += 1;
  }
  return count;
}

describe('cases repository activity_log statements', () => {
  it('parses a plausible column list, so a failed regex cannot pass vacuously', () => {
    expect(insertColumns().length).toBeGreaterThan(3);
  });

  it('logActivity writes the note column', () => {
    expect(insertColumns()).toContain('note');
  });

  it('logActivity supplies exactly one value per inserted column', () => {
    expect(insertValueCount()).toBe(insertColumns().length);
  });

  it('listActivityByEntity reads the note column', () => {
    expect(methodBody('listActivityByEntity')).toMatch(/\bnote\b/);
  });
});
```

The first test is deliberate: without it, a regex that stopped matching would compare two empty lists and the guard would pass while checking nothing.

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/server/cases/repository.test.ts`
Expected: FAIL — `logActivity writes the note column` and `listActivityByEntity reads the note column` both fail, because neither statement mentions `note` yet.

- [ ] **Step 3: Write the implementation**

In `src/server/cases/service.ts`, add `note` to the two types (exact shapes in the Interfaces block above) and add `latestHandoverNote(caseId: string): Promise<string>;` to the `CaseRepository` type.

In `src/server/cases/repository.ts`, update `logActivity`:

```ts
  async logActivity(entry: CaseActivityLogEntry): Promise<void> {
    await this.db`
      insert into public.activity_log (who, action, entity, customer_id, details, note)
      values (${entry.who}, ${entry.action}, ${entry.entity}, ${entry.customerId || null}, ${entry.details}, ${entry.note ?? ''})
    `;
  }
```

Update `listActivityByEntity` to select and return `note`:

```ts
  async listActivityByEntity(entity: string): Promise<CaseActivityRow[]> {
    const rows = (await this.db`
      select created_at as when, who, action, details, note
      from public.activity_log
      where entity = ${entity}
      order by created_at desc
      limit 40
    `) as Array<{ when: string | Date; who: string; action: string; details: string; note: string | null }>;

    return rows.map((row) => ({
      when: dateString(row.when),
      who: normalizeEmail(row.who),
      action: row.action,
      details: row.details,
      note: row.note ?? ''
    }));
  }
```

Add the new method next to it:

```ts
  async latestHandoverNote(caseId: string): Promise<string> {
    const rows = (await this.db`
      select note
      from public.activity_log
      where entity = ${caseId}
        and action = 'CASE_ASSIGN'
        and note <> ''
      order by created_at desc
      limit 1
    `) as Array<{ note: string }>;

    return rows[0]?.note ?? '';
  }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/server/cases/repository.test.ts`
Expected: PASS.

Then: `npm test` and `npx tsc --noEmit`.

`tsc` will likely fail in test files that build a fake `CaseRepository` — adding `latestHandoverNote` to the type means every fake must implement it, and adding `note` to `CaseActivityRow` means every fake activity row needs it. Fix those fakes properly; **do not use `as any` or loosen the types.**

- [ ] **Step 5: Prove the guard actually works**

Temporarily delete `note` from the `logActivity` insert column list, run `npx vitest run src/server/cases/repository.test.ts`, confirm it fails and names the column, then restore. Record the transcript in your report — a guard nobody has seen fail is not known to work.

- [ ] **Step 6: Commit**

```bash
git add src/server/cases/repository.ts src/server/cases/repository.test.ts src/server/cases/service.ts
git commit -m "feat(cases): read and write activity_log.note

Includes a parity guard over the logActivity insert. The previous piece of
work shipped an insert that silently omitted not-null-default columns and
wrote empty strings without error; this migration creates the same shape."
```

---

### Task 3: `assignTicket` accepts a note, `getCase` returns it

**Files:**
- Modify: `src/server/cases/service.ts` (`assignTicket` at line 565, `getCase` at line 581)
- Modify: `src/server/cases/rpc.ts` (the `api_assignTicket` registration at line 38)
- Test: `src/server/cases/service.test.ts`

**Interfaces:**
- Consumes: everything from Task 2.
- Produces, relied on by Task 4:
  - `assignTicket(user, caseId, who, note?)`
  - `getCase` returns `latestHandoverNote: string` at the top level, and each `history` entry gains `note: string`.

- [ ] **Step 1: Write the failing tests**

Add these to `src/server/cases/service.test.ts`, inside the existing `describe('case service ownership and assignment', ...)` block, after the test named `'lets any visible open case be reassigned to any active user and blocks inactive targets'` (around line 281).

They use the file's real fixtures: `makeService()` (line 170), which returns `{ repo, service }` with `CUST-0001` and a user roster already seeded; `caseRow({ ... })`, the case factory used throughout; and `sales`, the standard `CrmContext`. The target `'other'` resolves to `other@automationsystems.org`, whose display name is **`Other Sales`** — the details string is therefore `Working on -> Other Sales`.

```ts
  it('stores a handover note against the reassignment', async () => {
    const { repo, service } = makeService();
    repo.cases = [caseRow({ assignee: 'worker@automationsystems.org' })];

    await service.assignTicket(sales, 'CASE-2026-0001', 'other', 'Quoted, waiting on their PO.');

    const logged = repo.logs.find((entry) => entry.action === 'CASE_ASSIGN')!;
    expect(logged.note).toBe('Quoted, waiting on their PO.');
    expect(logged.details).toBe('Working on -> Other Sales');
  });

  it('reassigning without a note behaves exactly as before', async () => {
    const { repo, service } = makeService();
    repo.cases = [caseRow({ assignee: 'worker@automationsystems.org' })];

    const result = await service.assignTicket(sales, 'CASE-2026-0001', 'other');

    expect(result).toEqual({ ok: true, assignee: 'Other Sales', assigneeEmail: 'other@automationsystems.org' });
    const logged = repo.logs.find((entry) => entry.action === 'CASE_ASSIGN')!;
    expect(logged.note ?? '').toBe('');
    expect(logged.details).toBe('Working on -> Other Sales');
  });

  it('treats a whitespace-only handover note as no note', async () => {
    const { repo, service } = makeService();
    repo.cases = [caseRow({ assignee: 'worker@automationsystems.org' })];

    await service.assignTicket(sales, 'CASE-2026-0001', 'other', '   \n\t  ');

    const logged = repo.logs.find((entry) => entry.action === 'CASE_ASSIGN')!;
    expect(logged.note ?? '').toBe('');
  });

  it('rejects a handover note over 2000 characters without writing anything', async () => {
    const { repo, service } = makeService();
    repo.cases = [caseRow({ assignee: 'worker@automationsystems.org' })];

    await expect(
      service.assignTicket(sales, 'CASE-2026-0001', 'other', 'x'.repeat(2001))
    ).rejects.toThrow(/2000 characters/);

    expect(repo.logs.filter((entry) => entry.action === 'CASE_ASSIGN')).toHaveLength(0);
    expect(repo.cases[0].assignee).toBe('worker@automationsystems.org');
  });

  it('still refuses to reassign a closed case, note or not', async () => {
    const { repo, service } = makeService();
    repo.cases = [caseRow({ assignee: 'worker@automationsystems.org', outcome: 'Won' })];

    await expect(
      service.assignTicket(sales, 'CASE-2026-0001', 'other', 'a handover note')
    ).rejects.toThrow(/closed/);

    expect(repo.logs.filter((entry) => entry.action === 'CASE_ASSIGN')).toHaveLength(0);
  });

  it('getCase returns the latest handover note even when it falls outside the 40-entry history window', async () => {
    const { repo, service } = makeService();
    repo.cases = [caseRow({ assignee: 'worker@automationsystems.org' })];

    await service.assignTicket(sales, 'CASE-2026-0001', 'other', 'The handover note.');
    for (let i = 0; i < 45; i += 1) {
      await repo.logActivity({
        action: 'CASE_NOTE',
        entity: 'CASE-2026-0001',
        customerId: 'CUST-0001',
        details: `filler ${i}`,
        who: sales.email
      });
    }

    const result = await service.getCase(sales, 'CASE-2026-0001');

    expect(result.latestHandoverNote).toBe('The handover note.');
    expect(result.history.some((entry) => entry.details === 'Working on -> Other Sales')).toBe(false);
  });
```

**The last test is the important one.** It is the regression test for the `limit 40` window problem that the dedicated query exists to solve, and its final assertion is what gives it teeth: it proves the reassignment really has fallen out of the history window, so `latestHandoverNote` cannot be passing by accident via `history`.

For it to be meaningful, `FakeCaseRepository.listActivityByEntity` must actually apply a 40-row limit like the real query does, and `latestHandoverNote` must not. **Read the fake and check.** If it returns everything, fix it to model the limit — a fake that does not reproduce the constraint makes this test pass vacuously, and vacuous tests are precisely how the last piece of work nearly shipped a broken INSERT.

`caseRow` may not accept `outcome` as an override — check its signature and set the field however the file's existing closed-case tests do it.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/server/cases/service.test.ts`
Expected: FAIL — `assignTicket` ignores its fourth argument, and `getCase` returns no `latestHandoverNote`.

- [ ] **Step 3: Write the implementation**

In `src/server/cases/service.ts`, change `assignTicket`:

```ts
    async assignTicket(user: CrmContext, caseId: string, who: unknown, noteInput?: unknown) {
      const { row } = await loadVisibleCase(repo, user, caseId);
      if (row.outcome) throw new Error('This opportunity is closed - the ticket can no longer be reassigned.');
      const note = asText(noteInput);
      if (note.length > 2000) throw new Error('That handover note is too long - please keep it under 2000 characters.');
      const users = userIndex(await repo.listUsers());
      const email = resolveUser(users, who);
      await repo.updateCase(caseId, { assignee: email, updatedAt: nowIso() });
      await repo.logActivity({
        action: 'CASE_ASSIGN',
        entity: caseId,
        customerId: row.customerId,
        details: `Working on -> ${nameOf(users, email)}`,
        who: normalizeEmail(user.email),
        note
      });
      return { ok: true, assignee: nameOf(users, email), assigneeEmail: email };
    },
```

`asText` (line 181) already trims, which is what makes a whitespace-only note collapse to `''`. Confirm that by reading it rather than assuming. The length check runs **before** `updateCase`, so an over-long note writes nothing.

In `getCase`, add the new query to the existing `Promise.all` so it resolves in parallel:

```ts
      const [users, quotes, history, latestHandoverNote] = await Promise.all([
        repo.listUsers(),
        repo.listQuotesByCase(id),
        repo.listActivityByEntity(id),
        repo.latestHandoverNote(id)
      ]);
```

Add `latestHandoverNote` to the returned object, and add `note` to each mapped history entry:

```ts
        history: history.slice().reverse().slice(0, 40).map((item) => ({
          when: item.when,
          who: nameOf(idx, item.who),
          action: item.action,
          details: item.details,
          note: item.note
        })),
        latestHandoverNote,
```

In `src/server/cases/rpc.ts`, pass the third argument through:

```ts
registerRpc(
  'api_assignTicket',
  ({ args, context }) => service.assignTicket(context, String(args[0] ?? ''), args[1], args[2]),
  { read: false }
);
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/server/cases/service.test.ts`, then `npm test`, then `npx tsc --noEmit`.
Expected: all pass, tsc clean.

- [ ] **Step 5: Check the error message reaches the user**

`src/server/rpc/errors.ts` allow-lists user-facing messages by regex; anything unmatched becomes a generic `Something went wrong.` at HTTP 500. Read `USER_FACING_PATTERNS` and confirm the new "too long" message matches one of them. If it does not, add a specific pattern and a test asserting the message survives `normalizeRpcError` with a 400-class status.

This is not hypothetical — the equivalent message in the previous piece of work was silently swallowed into a 500 and had to be fixed after review.

- [ ] **Step 6: Commit**

```bash
git add src/server/cases/service.ts src/server/cases/service.test.ts src/server/cases/rpc.ts
git commit -m "feat(cases): optional handover note when reassigning a ticket

getCase gets the latest note from a dedicated query joined into its existing
Promise.all, rather than from the 40-row history window where it would
silently vanish on the busiest cases."
```

---

### Task 4: Client — capture the note and show it

**Files:**
- Modify: `docs/source-appscript/Index.html` (`mAssignCase` around line 1500, `doAssign` at 1528, history rendering at 1472, `renderCase` at 1403)
- Regenerate: `src/app/crm/legacy-full.generated.ts` (via the generator, never by hand)
- Test: `src/app/crm/legacy-app.test.ts`

**Interfaces:**
- Consumes: `api_assignTicket(caseId, email, note)` and `getCase`'s `latestHandoverNote` plus per-entry `note`, both from Task 3.
- Produces: nothing consumed by later tasks.

- [ ] **Step 1: Write the failing tests**

Add to `src/app/crm/legacy-app.test.ts`, mirroring the harness the existing tests use — `mockRpc`, `workspace('L6')`, `render(createElement(CrmApp))`, `window.eval`. Read a nearby test that drives a case view and copy its mechanics exactly.

```ts
  test('the reassign modal sends the handover note', async () => {
    let sentArgs: unknown[] = [];
    mockRpc((fn, args) => {
      if (fn === 'api_workspace') return workspace('L6');
      if (fn === 'api_listUsers') return [{ email: 'other@automationsystems.org', name: 'Other User' }];
      if (fn === 'api_assignTicket') { sentArgs = args; return { ok: true, assignee: 'Other User' }; }
      throw new Error(`Unexpected RPC ${fn}`);
    });

    // open the reassign modal, pick a user, type a note, submit
    // (follow the existing modal-driving pattern in this file)

    expect(sentArgs[2]).toBe('Quoted, waiting on their PO.');
  });

  test('the case page shows the latest handover note', async () => {
    // mock api_getCase to return latestHandoverNote: 'Quoted, waiting on their PO.'
    expect(document.getElementById('main')!.innerHTML).toContain('Quoted, waiting on their PO.');
  });

  test('a case with no handover note renders no note block', async () => {
    // mock api_getCase with latestHandoverNote: '' and history entries whose note is ''
    expect(document.getElementById('main')!.innerHTML).not.toContain('Handover note');
  });
```

Check whether `mockRpc` in this file passes `args` to its callback. If it only passes `fn`, extend it — that is a fixture improvement, not a deviation. Say so in your report.

**Fixture warning, this has cost real time before.** These views issue several RPCs, and the harness throws `Unexpected RPC ${fn}` for any it does not handle. If a container renders empty or a query times out, **read the console for `Unexpected RPC` first** and add the missing mock. Do not start changing product code on the assumption that the client is broken.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/app/crm/legacy-app.test.ts`
Expected: FAIL — there is no textarea, the note is not sent, and the case page renders no note block.

- [ ] **Step 3: Write the implementation**

All edits go in `docs/source-appscript/Index.html`.

In `mAssignCase`'s modal body, after the existing `wk_sel` hint div and before the closing hint paragraph, add:

```js
      '<div class="frow" style="margin-top:10px"><div><label>Handover note <span class="sub">(optional)</span></label>'+
      '<textarea id="wk_note" maxlength="2000" placeholder="What has been done so far, and what the next person needs to know."></textarea></div></div>'+
```

In `doAssign`, send it as the third argument:

```js
function doAssign(){
  if(!S._wk || !S._wk.pick){ toast('Pick a user first.', true); return; }
  var id=S._wk.id, nm=S._wk.pick.name;
  gs('api_assignTicket', id, S._wk.pick.email, v('wk_note')).then(function(){ closeModal(); toast('Ticket reassigned to '+nm+'.'); if(S.route==='case') vCase(id); else vDash(); }).catch(oops);
}
```

In the history rendering line (1472), append the note as its own line when present:

```js
      d.history.forEach(function(r){ html += '<li><div class="w">'+esc(r.when)+' · '+esc(r.who)+' · '+esc(r.action)+'</div><div class="d">'+esc(r.details)+'</div>'+(r.note?'<div class="d" style="margin-top:4px;font-style:italic">'+esc(r.note)+'</div>':'')+'</li>'; });
```

In `renderCase`, after the `</div></div>` that closes the `pagehead` block, add the latest-note block:

```js
    if(d.latestHandoverNote) html += '<div class="card" style="margin-bottom:12px"><div class="ovl">Latest handover note</div><div class="d">'+esc(d.latestHandoverNote)+'</div></div>';
```

Use `esc()` on every interpolated value. This file has an XSS regression test (`window.__AS_CRM_XSS__`); a raw interpolation will trip it.

- [ ] **Step 4: Regenerate the client**

Run: `node scripts/port-legacy-index.mjs`

The generator normalises CRLF and asserts its anchors, so it fails loudly if an edit moved something it needs. If it throws, read the error — it names the anchor it could not find.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run src/app/crm/legacy-app.test.ts`, then `npm test`, then `npx tsc --noEmit`.
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add docs/source-appscript/Index.html src/app/crm/legacy-full.generated.ts src/app/crm/legacy-app.test.ts
git commit -m "feat(crm): capture and display the ticket handover note"
```

---

### Task 5: End-to-end coverage

**Files:**
- Test: `tests/e2e/crm-smoke.spec.ts`

**Interfaces:**
- Consumes: Tasks 1-4.
- Produces: nothing.

- [ ] **Step 1: Write the test**

The existing suite drives modal workflows already — the quotation Drive tests at lines 621 and 688 are the closest model. Read one and mirror its mechanics.

```ts
test('reassigning a ticket with a handover note shows it on the case page', async ({ context, page }) => {
  // Mock api_assignTicket to capture its third argument.
  // Mock api_getCase to return latestHandoverNote on the second call.
  // Open a case, click reassign, pick a user, type a note, submit.
  await expect(page.getByText('Latest handover note')).toBeVisible();
  await expect(page.getByText('Quoted, waiting on their PO.')).toBeVisible();
});
```

Fill in the mock bodies and navigation by copying the nearest existing test. Every RPC the flow issues must be mocked.

- [ ] **Step 2: Run the suite**

```powershell
$env:NEXT_PUBLIC_SUPABASE_URL="http://127.0.0.1:3999"
$env:NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY="dummy-key-for-e2e"
npx playwright test
```

Expected: 22 passed (21 baseline plus yours).

**Do not pipe this through `tail` or `head`** — it masks the exit code and a failing run reports as success.

- [ ] **Step 3: Commit**

```bash
git add tests/e2e/crm-smoke.spec.ts
git commit -m "test(e2e): cover reassigning a ticket with a handover note"
```

---

### Task 6: Full gate, migrate, deploy, verify

**Files:** none changed unless a gate fails.

- [ ] **Step 1: Run the complete local gate**

```bash
npm run typecheck
npm test
npm run build
```
plus Playwright with the env vars above.

Expected: typecheck clean, **at least 263 vitest** and **at least 21 Playwright** passing, build succeeds. A count below baseline means a test was deleted rather than updated — investigate before continuing.

- [ ] **Step 2: Back up the database**

```bash
node scripts/backup-database.mjs
node scripts/verify-backup.mjs backups/<the-file-it-just-wrote>.json
```

The free tier takes no automatic backups, so this is the only restore point. The backup holds the full customer dataset in plaintext — it belongs in the gitignored `backups/` directory and must never be committed.

- [ ] **Step 3: Apply the migration to production**

```bash
node scripts/apply-migrations.mjs --through 0009 --dry-run
node scripts/apply-migrations.mjs --through 0009
```

The migration's own `do $$` block aborts the transaction if the column is wrong, so a successful run is itself the verification.

**Order matters: the migration goes first.** The column must exist before code that writes it is serving traffic. Adding a column no code writes yet is harmless; deploying code that writes a column that does not exist is an outage.

- [ ] **Step 4: Merge and deploy**

```bash
git checkout main
git merge --no-ff feat/ticket-handover-notes
git push origin main
```

Vercel deploys `main` automatically. Wait for the deployment to report ready.

- [ ] **Step 5: Verify in production**

1. Reassign a real ticket **with** a note. Confirm the note appears in the case history under the reassignment, and in the "Latest handover note" block on the case page.
2. Reassign a ticket **without** a note. Confirm it behaves exactly as before and no empty note block renders.
3. Confirm the column is being written:

```sql
select count(*) as assigns, count(nullif(note,'')) as with_note
from public.activity_log
where action = 'CASE_ASSIGN';
```

Expected: `with_note` is at least 1 after step 1. **If it is 0, stop** — the insert is not writing the column, which is exactly the defect class Task 2's guard exists to catch.

- [ ] **Step 6: Update CONTEXT.md**

Record: `activity_log.note` exists and is written only by the cases repository; handover notes are captured on reassignment; the other three `logActivity` implementations deliberately do not write it.

```bash
git add CONTEXT.md
git commit -m "docs: record ticket handover notes in the project context"
git push origin main
```

**Rollback:** `git revert` the merge commit and push. Leave the column in place — it is `not null default ''`, nothing else reads it, and dropping it under time pressure is riskier than leaving an unused column.

---

## Follow-ups deliberately excluded

1. Editing or deleting a note after it is written.
2. Notes on actions other than reassignment.
3. Notifying the user who receives the ticket.
4. Consolidating the four `logActivity` implementations.
5. A retention policy for `activity_log` — already the fastest-growing table at ~80% of structured growth, and this feature adds to it.
