# Case Aging Indicator Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show a yellow/red staleness badge on an Open case that's had no update for 2/3+ calendar
days (IST), on the Cases-tab admin list and the "My work" / "assigned to me" dashboard list.

**Architecture:** Two pure client-side helpers (`daysSinceIST`, `agingChip`) added to the legacy
client, applied at two existing render sites. One small server addition (`updatedOn` field on the
dashboard's ticket/case arrays, which don't currently send it) so the "My work" call site has the data
it needs. No migration, no new RPC, no new database column.

**Tech Stack:** Legacy Apps Script-ported client (`docs/source-appscript/Index.html`, generated into
`src/app/crm/legacy-full.generated.ts` via `node scripts/port-legacy-index.mjs`), TypeScript server
(`src/server/dashboard/service.ts`), Vitest + jsdom + Testing Library.

## Global Constraints

- Never hand-edit `src/app/crm/legacy-full.generated.ts`. Every client change goes into
  `docs/source-appscript/Index.html`, then regenerate with `node scripts/port-legacy-index.mjs`.
- Staleness clock = `cases.updated_at` (any field change resets it) — already available on every row
  this plan touches.
- Day math = calendar-day difference, computed against **Asia/Kolkata**, not elapsed-hours and not
  manual UTC-offset arithmetic. Mirror the approach `fmtDateTime()` already uses (`Intl.DateTimeFormat`
  with `timeZone: 'Asia/Kolkata'`).
- Bands: 0–1 days → nothing. 2 days → `b-amber` badge. 3+ days → `b-red` badge.
- The badge only ever appears when `outcome` is falsy (Open). Any truthy `outcome` → no badge,
  regardless of staleness. A **missing/undefined** `outcome` must be treated as open, not closed — the
  dashboard call site doesn't send an `outcome` field at all (its lists are pre-filtered to open-only
  server-side), and the helper must still work correctly there.
- Visual treatment reuses the existing `.badge.b-amber` / `.badge.b-red` CSS classes (already defined,
  already used by `priChip`/`stageChip`/`outcomeChip`) — do not add new CSS.
- Run `npm test` and `npm run typecheck` after every task; both must be clean before moving on.
- Design reference: `docs/superpowers/specs/2026-08-24-case-aging-indicator-design.md`.

---

## Task 1: Aging helpers — `daysSinceIST` and `agingChip`

**Files:**
- Modify: `docs/source-appscript/Index.html` (add two functions)
- Modify: `src/app/crm/legacy-full.generated.ts` (regenerated, not hand-edited)
- Test: `src/app/crm/legacy-app.test.ts`

**Interfaces:**
- Produces: `daysSinceIST(iso: string|null|undefined): number|null` — calendar-day difference between
  `iso`'s IST calendar date and today's IST calendar date; `null` for empty/unparseable input.
- Produces: `agingChip(updatedOn: string|null|undefined, outcome: string|null|undefined): string` — HTML
  string, `''`, `<span class="badge b-amber">Nd stale</span>`, or `<span class="badge b-red">Nd
  stale</span>`. Tasks 3 and 4 call this directly.

- [ ] **Step 1: Write the failing tests**

Open `src/app/crm/legacy-app.test.ts`. Find the existing `describe('IST timestamp formatting', ...)`
block (it ends around the `fmtDateTime` tests). Add a new sibling `describe` block immediately after it,
inside the same top-level `describe('legacy CRM full client', ...)`:

```typescript
  describe('case aging indicator', () => {
    async function bootDashboard() {
      mockRpc((fn) => {
        if (fn === 'api_workspace') return workspace('L6');
        throw new Error(`Unexpected RPC ${fn}`);
      });
      render(createElement(CrmApp));
      await screen.findByRole('heading', { name: 'Overview' });
    }

    afterEach(() => {
      vi.useRealTimers();
    });

    test('daysSinceIST measures a calendar-day difference in IST, not elapsed hours', async () => {
      await bootDashboard();
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-08-24T10:00:00.000Z')); // 2026-08-24, 3:30pm IST

      // 2026-08-23T19:00:00.000Z is IST 2026-08-24 00:30 - same IST calendar day as "now",
      // even though only ~15 real hours have passed. Must read as 0 days, proving this is
      // calendar-date subtraction, not an hours-elapsed countdown.
      expect(window.eval('daysSinceIST("2026-08-23T19:00:00.000Z")')).toBe(0);

      // 2026-08-21T19:00:00.000Z is IST 2026-08-22 00:30 - two IST calendar days before
      // 2026-08-24.
      expect(window.eval('daysSinceIST("2026-08-21T19:00:00.000Z")')).toBe(2);
    });

    test('daysSinceIST returns null for empty or unparseable input', async () => {
      await bootDashboard();

      expect(window.eval('daysSinceIST(null)')).toBeNull();
      expect(window.eval('daysSinceIST(undefined)')).toBeNull();
      expect(window.eval('daysSinceIST("")')).toBeNull();
      expect(window.eval('daysSinceIST("not-a-date")')).toBeNull();
    });

    test('agingChip is empty at 0-1 days, amber at exactly 2, red at 3+', async () => {
      await bootDashboard();
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-08-24T10:00:00.000Z'));

      expect(window.eval('agingChip("2026-08-23T10:00:00.000Z", "")')).toBe(''); // 1 day
      const two = window.eval('agingChip("2026-08-22T10:00:00.000Z", "")') as string;
      expect(two).toContain('b-amber');
      expect(two).toContain('2d');
      const five = window.eval('agingChip("2026-08-19T10:00:00.000Z", "")') as string;
      expect(five).toContain('b-red');
      expect(five).toContain('5d');
    });

    test('agingChip is empty whenever outcome is truthy, no matter how stale', async () => {
      await bootDashboard();
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-08-24T10:00:00.000Z'));

      expect(window.eval('agingChip("2026-08-01T10:00:00.000Z", "Won")')).toBe('');
      expect(window.eval('agingChip("2026-08-01T10:00:00.000Z", "Lost")')).toBe('');
      expect(window.eval('agingChip("2026-08-01T10:00:00.000Z", "Hold")')).toBe('');
    });

    test('agingChip treats a missing outcome as open (dashboard ticket rows never send one)', async () => {
      await bootDashboard();
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-08-24T10:00:00.000Z'));

      const result = window.eval('agingChip("2026-08-19T10:00:00.000Z", undefined)') as string;
      expect(result).toContain('b-red');
    });

    test('agingChip is empty for missing/invalid updatedOn', async () => {
      await bootDashboard();

      expect(window.eval('agingChip(null, "")')).toBe('');
      expect(window.eval('agingChip(undefined, "")')).toBe('');
      expect(window.eval('agingChip("", "")')).toBe('');
    });
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- legacy-app.test.ts`
Expected: FAIL — `daysSinceIST is not defined` / `agingChip is not defined`. Not a typo, not a setup
error — the functions genuinely don't exist yet.

- [ ] **Step 3: Implement `daysSinceIST`**

In `docs/source-appscript/Index.html`, add immediately after the `fmtDateTime` function (it ends with a
line that is just `}` around line 297, right before `function attachmentLinksHtml`):

```js
/* Calendar-day difference between `iso` and "now", both read as IST (Asia/Kolkata) wall-clock
   dates - e.g. a case updated at 11pm IST yesterday is "1 day old" the moment today starts, not
   after a full 24 hours. Deliberately NOT elapsed-hours math. Returns null for empty/unparseable
   input. Uses the 'en-CA' locale purely because Intl formats it as YYYY-MM-DD, which round-trips
   cleanly through `new Date(...)` for the day-count subtraction below. */
function daysSinceIST(iso){
  if(iso===null||iso===undefined||iso==='') return null;
  var d = new Date(iso);
  if(isNaN(d.getTime())) return null;
  var fmt = new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Kolkata',year:'numeric',month:'2-digit',day:'2-digit'});
  var thenMs = new Date(fmt.format(d)+'T00:00:00Z').getTime();
  var nowMs = new Date(fmt.format(new Date())+'T00:00:00Z').getTime();
  return Math.round((nowMs-thenMs)/86400000);
}
```

- [ ] **Step 4: Implement `agingChip`**

In `docs/source-appscript/Index.html`, add immediately after the `priChip` function (it ends with a
line that is just `}` around line 370, right before `function typeChip`):

```js
/* Staleness badge for an Open case with no update in 2+ IST calendar days. Empty outcome/undefined
   outcome both mean "open" - dashboard ticket rows never send an outcome field at all, because
   they're already pre-filtered to open-only server-side, and this must still work there. */
function agingChip(updatedOn, outcome){
  if(outcome) return '';
  var days = daysSinceIST(updatedOn);
  if(days===null || days<2) return '';
  return '<span class="badge '+(days>=3?'b-red':'b-amber')+'">'+days+'d stale</span>';
}
```

- [ ] **Step 5: Regenerate the client bundle**

Run: `node scripts/port-legacy-index.mjs`

- [ ] **Step 6: Run tests to verify they pass**

Run: `npm test -- legacy-app.test.ts`
Expected: PASS, all new tests green, no other test in the file broken.

- [ ] **Step 7: Typecheck**

Run: `npm run typecheck`
Expected: clean, no errors.

- [ ] **Step 8: Commit**

```bash
git add docs/source-appscript/Index.html src/app/crm/legacy-full.generated.ts src/app/crm/legacy-app.test.ts
git commit -m "feat: add daysSinceIST and agingChip helpers for case staleness"
```

---

## Task 2: Server — send `updatedOn` on the dashboard's ticket and case lists

**Files:**
- Modify: `src/server/dashboard/service.ts`
- Test: `src/server/dashboard/service.test.ts`

**Interfaces:**
- Consumes: nothing from Task 1 (independent; can happen in parallel with Task 1 in principle, but this
  plan runs it second for simplicity).
- Produces: `dash.tickets[].updatedOn` and `dash.cases[].updatedOn` (both `string`, taken from
  `row.updatedAt`) — Task 4's client change (`openCasesHTML`) depends on this field existing.

- [ ] **Step 1: Write the failing test**

Open `src/server/dashboard/service.test.ts`. Find the existing test `'carries the case priority into
both dashboard case lists'` (around line 505). Add a new test immediately after it, inside the same
`describe('dashboard service', ...)` block:

```typescript
  it('carries the case updatedOn into both dashboard case lists', async () => {
    const { repo, dashboard } = makeService();
    repo.cases = [caseRow({ id: 'CASE-2026-0001', updatedAt: '2026-08-20T09:00:00.000Z' })];

    const { dash } = await dashboard.dashboard(sales, sales.email);

    expect(dash.cases[0].updatedOn).toBe('2026-08-20T09:00:00.000Z');
    expect(dash.tickets[0].updatedOn).toBe('2026-08-20T09:00:00.000Z');
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/server/dashboard/service.test.ts`
Expected: FAIL — `expect(dash.cases[0].updatedOn).toBe(...)` receives `undefined`.

- [ ] **Step 3: Implement**

In `src/server/dashboard/service.ts`, find the two array type declarations (around line 125-126):

```typescript
    const openMine: Array<{ id: string; title: string; customerId: string; customerName: string; stage: string; priority: string }> = [];
    const tickets: Array<{ id: string; title: string; customerId: string; customerName: string; stage: string; priority: string }> = [];
```

Replace both with:

```typescript
    const openMine: Array<{ id: string; title: string; customerId: string; customerName: string; stage: string; priority: string; updatedOn: string }> = [];
    const tickets: Array<{ id: string; title: string; customerId: string; customerName: string; stage: string; priority: string; updatedOn: string }> = [];
```

Find the two push calls inside the `for (const row of cases)` loop (around lines 142 and 145):

```typescript
        openMine.push({ id: row.id, title: row.title, customerId: row.customerId, customerName, stage: row.stage, priority: row.priority });
```
```typescript
        tickets.push({ id: row.id, title: row.title, customerId: row.customerId, customerName, stage: row.stage, priority: row.priority });
```

Replace both with (add `updatedOn: row.updatedAt`):

```typescript
        openMine.push({ id: row.id, title: row.title, customerId: row.customerId, customerName, stage: row.stage, priority: row.priority, updatedOn: row.updatedAt });
```
```typescript
        tickets.push({ id: row.id, title: row.title, customerId: row.customerId, customerName, stage: row.stage, priority: row.priority, updatedOn: row.updatedAt });
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- src/server/dashboard/service.test.ts`
Expected: PASS, all tests in the file green (this file has other tests already passing — don't break
them).

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add src/server/dashboard/service.ts src/server/dashboard/service.test.ts
git commit -m "feat: send updatedOn on dashboard ticket and case lists"
```

---

## Task 3: Wire `agingChip` into the Cases tab table

**Files:**
- Modify: `docs/source-appscript/Index.html`
- Modify: `src/app/crm/legacy-full.generated.ts` (regenerated)
- Test: `src/app/crm/legacy-app.test.ts`

**Interfaces:**
- Consumes: `agingChip(updatedOn, outcome)` from Task 1.

- [ ] **Step 1: Write the failing test**

In `src/app/crm/legacy-app.test.ts`, inside the `describe('case aging indicator', ...)` block added in
Task 1, add a new test:

```typescript
    test('the Cases tab shows a stale badge on an Open case and none on a closed one', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-08-24T10:00:00.000Z'));

      mockRpc((fn) => {
        if (fn === 'api_workspace') return workspace('L6');
        if (fn === 'api_listCases') {
          return [
            {
              id: 'CASE-STALE',
              title: 'Stale open case',
              customerName: 'Acme Controls',
              stage: 'Lead',
              outcome: '',
              orderValue: '',
              owners: [],
              assignee: '',
              updatedOn: '2026-08-19T10:00:00.000Z'
            },
            {
              id: 'CASE-CLOSED',
              title: 'Old but closed',
              customerName: 'Acme Controls',
              stage: 'Lead',
              outcome: 'Won',
              orderValue: 5000,
              owners: [],
              assignee: '',
              updatedOn: '2026-08-19T10:00:00.000Z'
            }
          ];
        }
        throw new Error(`Unexpected RPC ${fn}`);
      });

      render(createElement(CrmApp));
      await screen.findByRole('heading', { name: 'Overview' });
      window.eval('nav("cases")');
      await screen.findByRole('heading', { name: 'Cases' });

      const main = document.getElementById('main') as HTMLElement;
      expect(main.innerHTML).toContain('5d stale');

      const rows = main.querySelectorAll('tr');
      const staleRow = Array.from(rows).find((row) => row.textContent?.includes('Stale open case'));
      const closedRow = Array.from(rows).find((row) => row.textContent?.includes('Old but closed'));
      expect(staleRow?.innerHTML).toContain('b-red');
      expect(closedRow?.innerHTML).not.toContain('b-red');
      expect(closedRow?.innerHTML).not.toContain('stale');
    });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- legacy-app.test.ts`
Expected: FAIL — `main.innerHTML` does not contain `'5d stale'` (the Cases tab doesn't render the chip
yet).

- [ ] **Step 3: Implement**

In `docs/source-appscript/Index.html`, find `function renderCases(list){`. The string
`fmtDateTime(o.updatedOn)` also appears in a different function (the customer-detail cases table) —
make sure you're editing the one inside `renderCases`, identifiable by the preceding `assignee` cell:

```js
        '<td class="sub">'+(o.outcome ? '<span class="sub">—</span>' : esc(o.assignee||'—'))+'</td>'+
        '<td class="sub mono">'+fmtDateTime(o.updatedOn)+'</td></tr>';
```

Replace with:

```js
        '<td class="sub">'+(o.outcome ? '<span class="sub">—</span>' : esc(o.assignee||'—'))+'</td>'+
        '<td class="sub mono">'+fmtDateTime(o.updatedOn)+' '+agingChip(o.updatedOn,o.outcome)+'</td></tr>';
```

- [ ] **Step 4: Regenerate the client bundle**

Run: `node scripts/port-legacy-index.mjs`

- [ ] **Step 5: Run test to verify it passes**

Run: `npm test -- legacy-app.test.ts`
Expected: PASS, all tests in the file green.

- [ ] **Step 6: Typecheck**

Run: `npm run typecheck`
Expected: clean.

- [ ] **Step 7: Commit**

```bash
git add docs/source-appscript/Index.html src/app/crm/legacy-full.generated.ts src/app/crm/legacy-app.test.ts
git commit -m "feat: show staleness badge on the Cases tab table"
```

---

## Task 4: Wire `agingChip` into the "My work" / assigned-to-me ticket card

**Files:**
- Modify: `docs/source-appscript/Index.html`
- Modify: `src/app/crm/legacy-full.generated.ts` (regenerated)
- Test: `src/app/crm/legacy-app.test.ts`

**Interfaces:**
- Consumes: `agingChip(updatedOn, outcome)` from Task 1, `dash.tickets[].updatedOn` from Task 2.

- [ ] **Step 1: Write the failing test**

In `src/app/crm/legacy-app.test.ts`, inside the `describe('case aging indicator', ...)` block, add:

```typescript
    test('the My work list (L1) shows a stale badge on an assigned ticket', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-08-24T10:00:00.000Z'));

      mockRpc((fn) => {
        if (fn === 'api_workspace') {
          const w = workspace('L1');
          w.boot.self.tickets = [
            {
              id: 'CASE-STALE',
              title: 'Stale ticket',
              customerId: 'CUST-1',
              customerName: 'Acme Controls',
              stage: 'Lead',
              priority: 'High',
              updatedOn: '2026-08-21T10:00:00.000Z'
            }
          ];
          return w;
        }
        throw new Error(`Unexpected RPC ${fn}`);
      });

      render(createElement(CrmApp));
      await screen.findByRole('heading', { name: 'My work' });

      const main = document.getElementById('main') as HTMLElement;
      expect(main.innerHTML).toContain('b-amber');
      expect(main.innerHTML).toContain('3d stale');
    });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- legacy-app.test.ts`
Expected: FAIL — `main.innerHTML` does not contain `'3d stale'`.

- [ ] **Step 3: Implement**

In `docs/source-appscript/Index.html`, find `function openCasesHTML(list){`. Find this line:

```js
      '<div class="sub">'+esc(c.customerName)+'</div></div>'+stageChip(c.stage)+priChip(c.priority)+
      '<button class="btn ghost sm" onclick="event.stopPropagation();mAssign(\''+esc(c.id)+'\')">Reassign</button></div>';
```

Replace with:

```js
      '<div class="sub">'+esc(c.customerName)+'</div></div>'+stageChip(c.stage)+priChip(c.priority)+agingChip(c.updatedOn,c.outcome)+
      '<button class="btn ghost sm" onclick="event.stopPropagation();mAssign(\''+esc(c.id)+'\')">Reassign</button></div>';
```

- [ ] **Step 4: Regenerate the client bundle**

Run: `node scripts/port-legacy-index.mjs`

- [ ] **Step 5: Run test to verify it passes**

Run: `npm test -- legacy-app.test.ts`
Expected: PASS, all tests in the file green.

- [ ] **Step 6: Typecheck**

Run: `npm run typecheck`
Expected: clean.

- [ ] **Step 7: Commit**

```bash
git add docs/source-appscript/Index.html src/app/crm/legacy-full.generated.ts src/app/crm/legacy-app.test.ts
git commit -m "feat: show staleness badge on the My work / assigned-to-me ticket list"
```

---

## Task 5: Full gate

**Files:** none (verification only).

**Interfaces:** none — this task produces no code, only a pass/fail gate for the whole branch.

- [ ] **Step 1: Full test suite**

Run: `npm test`
Expected: every test file passes, no failures, no new skips.

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: clean.

- [ ] **Step 3: Regeneration is up to date**

Run: `node scripts/port-legacy-index.mjs && git status --short`
Expected: no diff — proves `legacy-full.generated.ts` in the last commit already matches what the
generator produces from the final `Index.html` (catches a forgotten regeneration step in any earlier
task).

- [ ] **Step 4: Confirm scope**

Run: `git diff --stat origin/main...HEAD`
Expected: only the files touched by Tasks 1-4 above — `docs/source-appscript/Index.html`,
`src/app/crm/legacy-full.generated.ts`, `src/app/crm/legacy-app.test.ts`,
`src/server/dashboard/service.ts`, `src/server/dashboard/service.test.ts`.

- [ ] **Step 5: Report, do not merge**

Report gate status (test count, typecheck result, regeneration check, scope check) and stop. Merge to
`main` and push to production only on the project owner's explicit go-ahead — do not do it as part of
this task.
