# Eliminate the Case-Owner Layer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make account handlers the sole owners of every case on their account — derived live, never
stored on the case — and remove the standalone case-owner concept (columns, RPCs, UI) entirely.

**Architecture:** One new function, `caseHandlers(caseRecord, ownership)` in `src/server/auth/access.ts`,
becomes the only definition of "who owns a case": the account's real handlers, or the case's creator
when the account has none. Every read path switches to it; every write path and the two storage
columns (`cases.owner`, `cases.extra_owners`) are removed. The UI says "Handlers" instead of "Owners"
and loses the manage-owners modal.

**Tech Stack:** Next.js 15, TypeScript, postgres.js, Supabase Postgres, Vitest + jsdom, Playwright.
Legacy UI source `docs/source-appscript/Index.html`, generated into
`src/app/crm/legacy-full.generated.ts` by `node scripts/port-legacy-index.mjs`.

## Global Constraints

- Design reference: `docs/superpowers/specs/2026-09-18-eliminate-case-owner-layer-design.md`. Every
  decision in its "Scope" section is final — do not re-open any of them.
- **Never hand-edit `src/app/crm/legacy-full.generated.ts`.** Edit `Index.html`, then regenerate.
- **`caseHandlers`, `caseVisible` and `ensureCanSeeCase` take `ownership` as a REQUIRED parameter —
  no default value.** A default of "no handlers" would make the creator-fallback fire on accounts that
  DO have handlers, silently granting the creator access. This is a security property, not style.
- The creator fallback reads `cases.created_by` (pre-existing audit column). Do not add a column.
- API vocabulary: responses say `handlers` (display names) and `handlerList` (`{ email, name }[]`,
  case detail only). The words `owners`, `ownerEmails`, `ownerList` must not remain in any response.
- UI label: "Handlers", never "Owners", anywhere a case's owners were shown.
- Tests assert real behavior (returned values, rendered DOM, persisted rows) — never mock call counts
  as a stand-in for behavior. A test that passes on its first run proves nothing: prove it has teeth
  by temporarily breaking the production line it guards, watching it fail, then restoring exactly
  (edit in place — never `git checkout`/`git reset`).
- No dead code left behind: every function, type, repo method, fixture field and test that only
  existed to serve case-level ownership is deleted, not commented out.
- Every task ends with `npm test` (41+ files green, not doubled) and `npm run typecheck` clean.
  Report exact counts.
- Work only inside the feature worktree the controller gives you. Verify `pwd` and
  `git branch --show-current` before the first edit and again immediately before `git commit`.

---

## Task 1: Teach the schema-parity test parser about `drop column`

**Why first:** `src/server/db/cases-columns.test-helpers.ts`'s `allCasesColumns()` builds the set of
`public.cases` columns from `0001`'s CREATE TABLE plus every migration's `add column`. It has no
notion of `drop column`. Task 4's migration drops two columns; without this fix every parity guard
(`case-repository-writes.test.ts`, `case-write.test.ts`) keeps demanding `owner`/`extra_owners` in
every SELECT/INSERT forever. This task changes test infrastructure only — no production code.

**Files:**
- Modify: `src/server/db/cases-columns.test-helpers.ts` (`allCasesColumns`, ~line 76-83)
- Test: `src/server/db/cases-columns.test-helpers.test.ts` (create if it does not exist; if a test
  file for these helpers already exists, add to it instead — search first)

**Interfaces:**
- Produces: `allCasesColumns(migrationsDir)` now removes a column when any later migration contains
  `alter table public.cases ... drop column [if exists] <name>`. Signature unchanged. Also export a
  new pure helper `applyCasesColumnMigration(names: Set<string>, migrationSql: string): void` so the
  parsing can be tested on inline SQL without touching the real migrations directory.

- [ ] **Step 1: Write the failing tests**

```typescript
import { describe, expect, it } from 'vitest';

import { applyCasesColumnMigration } from './cases-columns.test-helpers';

describe('applyCasesColumnMigration', () => {
  it('adds columns from add column', () => {
    const names = new Set(['case_id']);
    applyCasesColumnMigration(names, 'alter table public.cases add column if not exists priority text;');
    expect([...names].sort()).toEqual(['case_id', 'priority']);
  });

  it('removes columns from drop column, with and without if exists', () => {
    const names = new Set(['case_id', 'owner', 'extra_owners']);
    applyCasesColumnMigration(
      names,
      'alter table public.cases drop column if exists owner;\nalter table public.cases drop column extra_owners;'
    );
    expect([...names]).toEqual(['case_id']);
  });

  it('ignores drop column on other tables', () => {
    const names = new Set(['case_id', 'owner']);
    applyCasesColumnMigration(names, 'alter table public.quotations drop column owner;');
    expect([...names].sort()).toEqual(['case_id', 'owner']);
  });

  it('does not treat drop constraint or drop not null as a column drop', () => {
    const names = new Set(['case_id', 'customer_id']);
    applyCasesColumnMigration(
      names,
      'alter table public.cases alter column customer_id drop not null;\nalter table public.cases drop constraint if exists cases_stage_check;'
    );
    expect([...names].sort()).toEqual(['case_id', 'customer_id']);
  });
});
```

- [ ] **Step 2: Run to verify RED**

Run: `node node_modules/vitest/vitest.mjs run src/server/db/cases-columns.test-helpers.test.ts`
Expected: FAIL — `applyCasesColumnMigration` is not exported.

- [ ] **Step 3: Implement**

In `cases-columns.test-helpers.ts`, add and export:

```typescript
/**
 * Apply one migration file's effect on the set of public.cases columns: `add column` adds,
 * `drop column` removes. `alter column ... drop not null` and `drop constraint` are not column
 * drops and are ignored - the regex requires the literal words `drop column`.
 */
export function applyCasesColumnMigration(names: Set<string>, migrationSql: string): void {
  const statements = migrationSql.matchAll(/alter\s+table\s+(?:only\s+)?public\.cases\b([\s\S]*?);/gi);
  for (const statement of statements) {
    for (const add of statement[1].matchAll(/add\s+column\s+(?:if\s+not\s+exists\s+)?"?([a-z_][a-z0-9_]*)"?/gi)) {
      names.add(add[1].toLowerCase());
    }
    for (const drop of statement[1].matchAll(/drop\s+column\s+(?:if\s+exists\s+)?"?([a-z_][a-z0-9_]*)"?/gi)) {
      names.delete(drop[1].toLowerCase());
    }
  }
}
```

Then replace the migration loop at the end of `allCasesColumns` (the `for (const file of ...)` block
that only handles `add column`) with:

```typescript
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
    applyCasesColumnMigration(names, fs.readFileSync(path.join(dir, file), 'utf8'));
  }
```

Leave `migrationAddedCasesColumns` unchanged — it deliberately answers a narrower question ("which
columns did a migration add") and is used to prove the parser is live.

- [ ] **Step 4: Run to verify GREEN, then the full suite**

Run: `node node_modules/vitest/vitest.mjs run src/server/db/cases-columns.test-helpers.test.ts` — PASS.
Run: `npm test` and `npm run typecheck` — both clean (no migration drops a column yet, so every
existing parity guard is unaffected).

- [ ] **Step 5: Commit**

```bash
git add src/server/db/cases-columns.test-helpers.ts src/server/db/cases-columns.test-helpers.test.ts
git commit -m "test: teach the cases column-parity parser about drop column"
```

---

## Task 2: Frontend — "Handlers" instead of "Owners", no manage-owners modal

**Why before the server:** `src/server/rpc/api-parity.test.ts` fails if `Index.html` still calls an
`api_*` that is not registered on the server. Removing the client's `api_addCaseOwner`/
`api_removeCaseOwner` calls first lets Task 3 delete the server RPCs without a red suite in between.
The jsdom and Playwright suites mock the RPC boundary, so this task is testable on its own.

**Files:**
- Modify: `docs/source-appscript/Index.html`
- Modify: `src/app/crm/legacy-full.generated.ts` (regenerated only)
- Test: `src/app/crm/legacy-app.test.ts`, `tests/e2e/crm-smoke.spec.ts`

**Interfaces:**
- Consumes (from Task 3, mocked here): `api_getCase` → `case.handlers: string[]` (names) and
  `case.handlerList: Array<{ email: string; name: string }>`; `api_listCases` rows and
  `api_getCustomer` → `cases[]` rows → `handlers: string[]`.
- Produces: the client never reads `owners`, `ownerEmails` or `ownerList`, and never calls
  `api_addCaseOwner`/`api_removeCaseOwner`.

- [ ] **Step 1: Update the shared jsdom fixture helper**

In `src/app/crm/legacy-app.test.ts`, change `caseDetail` (near the top of the file) from taking an
`ownerList` to taking a handler list:

```typescript
function caseDetail(handlerList: Array<{ name: string; email: string }>) {
  return {
    customer: { id: 'CUST-1', name: 'Acme Controls' },
    case: {
      id: 'CASE-1',
      title: 'Panel upgrade',
      customerId: 'CUST-1',
      stage: 'Lead',
      outcome: '',
      details: '',
      orderValue: '',
      wonCategories: [],
      handlers: handlerList.map((handler) => handler.name),
      handlerList
    },
    canEdit: true,
    canAssignTicket: true,
    quotes: [],
    history: []
  };
}
```

Every existing caller passes objects with a `source` key — drop that key at each call site
(`npm run typecheck` lists every one). Every other fixture in the file that builds a case, case-list
row or customer-detail case row with `owners:` / `ownerList:` becomes `handlers:` / `handlerList:`
(grep the file for `owners` and `ownerList` until zero hits remain). Do the same in
`tests/e2e/crm-smoke.spec.ts`'s payload builders (`rpcData`, `quotedCaseGetCasePayload`,
`unmappedCaseGetCasePayload` and any other case payload — grep for `owners`/`ownerList`).

- [ ] **Step 2: Delete the tests for the removed feature**

Delete, in full:
- `src/app/crm/legacy-app.test.ts`: the `describe('P10 - case owners are labelled by why they own the case', ...)` block.
- `tests/e2e/crm-smoke.spec.ts`: the test `'P10 - a case creator is not mislabelled as the account handler'`.

Keep `describe('P9 - Direct is a special, non-removable handler', ...)` — it tests the Customer page's
account-handler list, which is unchanged. If any test inside it asserts on the case-owner modal, remove
only that assertion and say so in your report.

- [ ] **Step 3: Write the failing tests**

Add a new block to `legacy-app.test.ts` (next to where the P10 block was), reusing the file's existing
`mockRpc`, `workspace`, `customerDetail`, `render`, `CrmApp` helpers:

```typescript
describe('case handlers replace case owners', () => {
  const handlers = [
    { name: 'Anita Rao', email: 'anita@automationsystems.org' },
    { name: 'Ravi Kumar', email: 'ravi@automationsystems.org' }
  ];

  async function openCase(detail: ReturnType<typeof caseDetail>) {
    mockRpc((fn) => {
      if (fn === 'api_workspace') return workspace('L6');
      if (fn === 'api_getCase') return detail;
      throw new Error(`Unexpected RPC ${fn}`);
    });
    render(createElement(CrmApp));
    await screen.findByRole('heading', { name: 'Overview' });
    window.eval('nav("case", "CASE-1")');
    await screen.findByRole('heading', { name: 'Panel upgrade' });
  }

  test('the case page lists the account handlers under "Handlers", never "Owners"', async () => {
    await openCase(caseDetail(handlers));
    const main = document.getElementById('main') as HTMLElement;
    expect(main.textContent).toContain('Handlers: Anita Rao, Ravi Kumar');
    expect(main.textContent).not.toContain('Owners');
  });

  test('there is nothing to manage per case: no manage link, no case-owners modal', async () => {
    await openCase(caseDetail(handlers));
    expect(screen.queryByRole('button', { name: 'manage' })).not.toBeInTheDocument();
    expect(window.eval('typeof mOwners')).toBe('undefined');
    expect(window.eval('typeof addOwner')).toBe('undefined');
    expect(window.eval('typeof removeOwner')).toBe('undefined');
  });

  test('a case with no handler shows a dash, not an empty label', async () => {
    await openCase(caseDetail([]));
    expect(document.getElementById('main')?.textContent).toContain('Handlers: —');
  });

  test('reassignment suggests the account handlers', async () => {
    await openCase(caseDetail(handlers));
    window.eval('mAssignCase()');
    await screen.findByRole('textbox', { name: 'Search for a user' });
    const modal = document.getElementById('mbody') as HTMLElement;
    expect(within(modal).getByRole('button', { name: 'Anita Rao' })).toBeInTheDocument();
    expect(within(modal).getByRole('button', { name: 'Ravi Kumar' })).toBeInTheDocument();
    expect(modal.textContent).toContain("Suggested — this account's handlers");
  });

  test('the Cases tab and the customer-detail case list label the column "Handlers"', async () => {
    mockRpc((fn) => {
      if (fn === 'api_workspace') return workspace('L6');
      if (fn === 'api_listCases') {
        return [{ id: 'CASE-1', title: 'Panel upgrade', customerName: 'Acme Controls', stage: 'Lead', outcome: '',
          orderValue: '', handlers: ['Anita Rao'], assignee: '', updatedOn: new Date().toISOString() }];
      }
      throw new Error(`Unexpected RPC ${fn}`);
    });
    render(createElement(CrmApp));
    await screen.findByRole('heading', { name: 'Overview' });
    window.eval('nav("cases")');
    await waitFor(() => expect(document.getElementById('caseRes')?.textContent).toContain('Anita Rao'));
    const headers = Array.from(document.querySelectorAll('#caseRes th')).map((th) => th.textContent);
    expect(headers).toContain('Handlers');
    expect(headers).not.toContain('Owners');
  });
});
```

Add one more test in the same block for the customer-detail case list: mock `api_getCustomer` with
`customerDetail({ cases: [{ id: 'CASE-1', title: 'Panel upgrade', stage: 'Lead', outcome: '',
orderValue: '', handlers: ['Anita Rao'], assignee: '', quotes: 0, updatedOn: new Date().toISOString() }] })`
(check the existing `customerDetail` helper and an existing customer-page test for the exact
navigation call and the required fields), navigate to the customer, and assert that the Cases table's
header row contains `Handlers`, not `Owners`, and a row shows `Anita Rao`.

In `tests/e2e/crm-smoke.spec.ts`, add one real-browser test using an existing case fixture: the case
page shows `Handlers:` with the fixture's handler names, and there is no `manage` link.

- [ ] **Step 4: Run to verify RED**

Run: `node node_modules/vitest/vitest.mjs run src/app/crm/legacy-app.test.ts -t 'case handlers replace case owners'`
Expected: FAIL — the page still renders "Owners:" and a "manage" link; `mOwners` is still defined.

- [ ] **Step 5: Implement in `docs/source-appscript/Index.html`**

1. Case page header (in `renderCase`, search for `Owners: <b>`). Replace
   ```js
         ' &nbsp; Owners: <b>'+esc((o.owners||[]).join(', ')||'—')+'</b>'+
         (d.canEdit?' <button class="btn lk" onclick="mOwners()">manage</button>':'')+
   ```
   with
   ```js
         ' &nbsp; Handlers: <b>'+esc((o.handlers||[]).join(', ')||'—')+'</b>'+
   ```
2. Delete the whole P10 comment plus `ownerSourceLabel`, `mOwners`, `addOwner`, `removeOwner`
   (search for `function ownerSourceLabel` — the four functions are contiguous).
3. `mAssignCase`: replace `(d.case.ownerList||[])` with `(d.case.handlerList||[])`.
4. `mRequestRevision`: replace `d.case.ownerList||[]` with `d.case.handlerList||[]`.
5. In `mAssign`'s suggestion bubbles, replace the hint text `Suggested — people who own this case`
   with `Suggested — this account's handlers`.
6. Cases-tab table (`renderCases`) and customer-detail case table: header `<th>Owners</th>` →
   `<th>Handlers</th>`, cell `esc((o.owners||[]).join(', ')||'—')` → `esc((o.handlers||[]).join(', ')||'—')`.
   Two tables, four edits — grep `Owners` and `o.owners` until zero hits remain.

Intentionally unchanged (accurate prose, not a label of case owners): the customer-grid hint
"Handlers are the owners; a customer with no user yet shows "Direct"." and `mNewCase`'s hint "The
account handlers are the owners." Leave them. The Cases-tab "Owned by me" checkbox label and its
`owned` wire field are also unchanged — only its server-side meaning changes (Task 3).

After editing: `grep -n "ownerList\|\.owners\|mOwners\|api_addCaseOwner\|api_removeCaseOwner\|ownerSourceLabel" docs/source-appscript/Index.html`
must return nothing.

- [ ] **Step 6: Regenerate and verify GREEN**

Run: `node scripts/port-legacy-index.mjs`, then
`node node_modules/vitest/vitest.mjs run src/app/crm/legacy-app.test.ts` — all green.
Prove teeth: temporarily change the header back to `Owners:` in `Index.html`, regenerate, confirm the
first new test fails, restore by editing, regenerate, confirm green. Record it.

- [ ] **Step 7: Full gate**

`npm test`, `npm run typecheck`. Playwright (pre-warm the dev server first; the suite needs
`NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:3999` and
`NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=playwright-fake-publishable-key` exported in the SAME shell that
runs `npx playwright test`, or every test silently skips): full suite green. Report exact counts.
`api-parity.test.ts` must still pass — the server still registers the two RPCs; the client just no
longer calls them.

- [ ] **Step 8: Commit**

```bash
git add docs/source-appscript/Index.html src/app/crm/legacy-full.generated.ts src/app/crm/legacy-app.test.ts tests/e2e/crm-smoke.spec.ts
git commit -m "feat(ui): show case handlers instead of case owners; remove the manage-owners modal"
```

---

## Task 3: Server — ownership is derived live from account handlers

**Files:**
- Modify: `src/server/auth/access.ts`, `src/server/domain/types.ts`
- Modify: `src/server/cases/service.ts`, `src/server/cases/rpc.ts`
- Modify: `src/server/quotes/service.ts` (the `ensureCanSeeCase` call only)
- Modify: `src/server/dashboard/service.ts`
- Modify: `src/server/customers/service.ts` (`getCustomer`'s case list only), `src/server/customers/repository.ts` (`listCasesByCustomer` only)
- Modify: `src/server/rpc/api-parity.test.ts` (unmigrated allowlist)
- Test: `src/server/auth/access.test.ts`, `src/server/cases/service.test.ts`,
  `src/server/customers/service.test.ts`, `src/server/dashboard/service.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks (Task 2's client already expects the shapes below).
- Produces:
  - `caseHandlers(caseRecord: CaseRecord, ownership: AccessOwnership): string[]` (exported, `access.ts`).
  - `caseVisible(user, customerAccess, caseRecord, ownership)` and
    `ensureCanSeeCase(user, customerAccess, caseRecord, ownership)` — 4th param required.
  - `CaseRecord = { id: string; customerId: string; title: string; createdBy: string; assignee: string }`.
  - Response shapes: `getCase` → `case.handlers: string[]`, `case.handlerList: {email,name}[]`;
    `listCases` rows → `handlers: string[]`; `getCustomer` → `cases[].handlers: string[]`.
  - `api_addCaseOwner`, `api_removeCaseOwner` no longer registered.

Note: this task stops READING `owner`/`extra_owners`. Case creation still WRITES them (harmlessly —
nothing reads them) until Task 4 removes the columns. That split keeps this task's diff about one
thing: where ownership comes from.

- [ ] **Step 1: Write the failing access tests**

In `src/server/auth/access.test.ts`, delete the `describe('caseOwners (materialised, P11)')` and
`describe('caseOwnerEntries (P10 owner sources)')` blocks and the `caseOwners`/`caseOwnerEntries`
imports; add `caseHandlers` to the import list. Remove the dead `assigneeEmailsByCustomerId`/
`extraOwnerEmailsByCustomerId` fields from the fixture that uses them (~line 94). Change the shared
`caseRecord` fixture near the top to:

```typescript
const caseRecord: CaseRecord = {
  id: 'CASE-2026-0001',
  customerId: customer.id,
  title: 'Panel enquiry',
  createdBy: 'creator@automationsystems.org',
  assignee: ''
};
```

Replace the existing `caseVisible` block with the two blocks below (they use the file's existing
`customer`, `caseRecord`, `user(role, tags)` and `ownership(overrides)` fixtures; `user('L2')` has
email `l2@automationsystems.org`, and so on). Update the existing `ensureCanSeeCase` assertions
(~lines 236, 244) to pass `ownership()` as the 4th argument. Keep the `accessLevel`, `ensureFull`,
`ensureAdmin` and `customerRealHandlers` tests.

```typescript
describe('caseHandlers', () => {
  const handlers = ownership({
    handlerEmailsByCustomerId: { [customer.id]: ['anita@automationsystems.org', 'ravi@automationsystems.org'] }
  });
  const directOnly = ownership({ handlerEmailsByCustomerId: { [customer.id]: ['direct'] } });

  it('returns the account real handlers and ignores the creator entirely', () => {
    expect(caseHandlers(caseRecord, handlers)).toEqual(['anita@automationsystems.org', 'ravi@automationsystems.org']);
  });
  it('falls back to the creator on a customerless case', () => {
    expect(caseHandlers({ ...caseRecord, customerId: '' }, handlers)).toEqual(['creator@automationsystems.org']);
  });
  it('falls back to the creator when the only handler is the virtual Direct account', () => {
    expect(caseHandlers(caseRecord, directOnly)).toEqual(['creator@automationsystems.org']);
  });
  it('falls back to the creator when the account has no handler rows at all', () => {
    expect(caseHandlers(caseRecord, ownership())).toEqual(['creator@automationsystems.org']);
  });
  it('returns nothing rather than inventing an owner when the creator is blank or Direct', () => {
    expect(caseHandlers({ ...caseRecord, createdBy: '' }, ownership())).toEqual([]);
    expect(caseHandlers({ ...caseRecord, createdBy: 'direct' }, ownership())).toEqual([]);
  });
  it('normalizes the creator email', () => {
    expect(caseHandlers({ ...caseRecord, createdBy: ' Creator@AutomationSystems.org ' }, ownership())).toEqual([
      'creator@automationsystems.org'
    ]);
  });
});

describe('caseVisible', () => {
  const creator = user('L2');
  const other = user('L1');
  const handler = { ...user('L2'), email: 'anita@automationsystems.org' };
  const created = { ...caseRecord, createdBy: creator.email };
  const handled = ownership({ handlerEmailsByCustomerId: { [customer.id]: [handler.email] } });

  it('L4+ sees every case, even with no customer access and no relationship', () => {
    expect(caseVisible(user('L4'), 'NONE', created, handled)).toBe(true);
  });
  it('a real handler sees the case through FULL customer access', () => {
    expect(caseVisible(handler, accessLevel(handler, customer, handled), created, handled)).toBe(true);
  });
  it('an unrelated L1 or tag-mismatched L3 user is denied', () => {
    expect(caseVisible(other, 'NONE', created, handled)).toBe(false);
    const l3 = user('L3', ['Gujarat']);
    expect(caseVisible(l3, accessLevel(l3, customer, handled), created, handled)).toBe(false);
  });
  it('the assignee sees the case whatever the handler state', () => {
    expect(caseVisible(other, 'NONE', { ...created, assignee: other.email }, handled)).toBe(true);
  });
  it('the creator sees a case whose account has no real handler', () => {
    expect(caseVisible(creator, 'NONE', created, ownership())).toBe(true);
  });
  it('the creator sees a customerless case', () => {
    expect(caseVisible(creator, 'NONE', { ...created, customerId: '' }, handled)).toBe(true);
  });
  it('the creator loses the case the moment the account gains a real handler', () => {
    expect(caseVisible(creator, 'NONE', created, handled)).toBe(false);
  });
  it('the creator keeps the case after a handler exists only by being the assignee', () => {
    expect(caseVisible(creator, 'NONE', { ...created, assignee: creator.email }, handled)).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify RED**

Run: `node node_modules/vitest/vitest.mjs run src/server/auth/access.test.ts`
Expected: FAIL — `caseHandlers` is not exported; `caseVisible` ignores its 4th argument.

- [ ] **Step 3: Implement `access.ts` and `types.ts`**

`src/server/domain/types.ts`:
```typescript
export type CaseRecord = {
  id: string;
  customerId: string;
  title: string;
  createdBy: string;
  assignee: string;
};

export type AccessOwnership = {
  handlerEmailsByCustomerId: Record<string, readonly string[]>;
};
```

`src/server/auth/access.ts`: remove `caseOwners`, `CaseOwnerSource`, `CaseOwnerEntry`,
`caseOwnerSource`, `caseOwnerEntries`, and the `parsePipe` import if nothing else uses it. Update the
`customerRealHandlers` doc comment's reference to `caseOwners` so it points at `caseHandlers`. Add:

```typescript
/**
 * Who owns a case: its account's real handlers, derived live - ownership is never stored on
 * the case. When the account has no real handler (a customerless case, or one handled only by
 * the virtual Direct account) the case's creator stands in so the case is never orphaned. The
 * moment the account gains a real handler, the creator's claim ends.
 *
 * `ownership` has no default on purpose: "no handlers" would trigger the creator fallback on
 * accounts that do have handlers.
 */
export function caseHandlers(caseRecord: CaseRecord, ownership: AccessOwnership): string[] {
  const handlers = customerRealHandlers(caseRecord.customerId, ownership);
  if (handlers.length > 0) return handlers;
  const creator = normalizeEmail(caseRecord.createdBy);
  return creator && !isDirect(creator) ? [creator] : [];
}

export function caseVisible(
  user: CrmUser,
  customerAccess: CustomerAccessLevel,
  caseRecord: CaseRecord,
  ownership: AccessOwnership
): boolean {
  if (seesAll(user)) return true;
  if (customerAccess === 'FULL') return true;

  const email = normalizeEmail(user.email);
  if (normalizeEmail(caseRecord.assignee) === email) return true;
  return caseHandlers(caseRecord, ownership).includes(email);
}
```

`ensureCanSeeCase` gains the same required 4th parameter and passes it to `caseVisible`.

- [ ] **Step 4: Run access tests GREEN**

Run: `node node_modules/vitest/vitest.mjs run src/server/auth/access.test.ts` — PASS. Prove teeth:
temporarily add a default `= { handlerEmailsByCustomerId: {} }` to `caseHandlers`'s `ownership`
parameter and remove the argument from one `caseVisible` call site in the test's creator-loses-access
case — confirm that test fails (the creator is wrongly let in). Restore exactly.

- [ ] **Step 5: Write failing service tests**

`src/server/cases/service.test.ts`:
- Delete every test of `addCaseOwner`/`removeCaseOwner` and every assertion on `ownerList`,
  `ownerEmails`, or `owners`.
- Add (use the file's existing fake repository and user fixtures):
  - `getCase` returns `case.handlers` = names of the account's real handlers and `case.handlerList` =
    `[{ email, name }]` for the same people; the response has no `owners`, `ownerEmails` or `ownerList` key
    (assert with `expect(detail.case).not.toHaveProperty('owners')`, same for the other two).
  - `getCase` on a customerless case created by user X returns `handlers` = `[X's name]`.
  - `listCases({ owned: true })` for a handler returns that account's cases; for the case's creator on
    an account that HAS a different real handler it does NOT return the case (unless they're the
    assignee — `listCases({ assigned: true })` still returns it then).
  - Closed-case liveness (spec decision 2): create a case, close it Won, then add a handler to the
    customer through the fake repo's handler rows; `getCase` on the closed case now lists the new handler.
  - The service object no longer has `addCaseOwner`/`removeCaseOwner`:
    `expect('addCaseOwner' in service).toBe(false)` (same for remove).
- `src/server/rpc/registry.test.ts` or a new assertion in `api-parity.test.ts`: after importing
  `../../server/cases/rpc`, `hasRpc('api_addCaseOwner')` and `hasRpc('api_removeCaseOwner')` are false.

`src/server/customers/service.test.ts`: `getCustomer` FULL response's `cases[].handlers` lists the
customer's real handlers by name; for a Direct-only customer each case lists its own creator; no
`owners` key on any case row.

`src/server/dashboard/service.test.ts`: the "my open cases" bucket (`dash.cases`) for a real handler
contains the account's open cases; for a user who is neither handler nor creator nor assignee it is
empty; for the creator of a case on a handler-less account it contains that case. Existing tests that
seeded `extraOwners` to make someone an owner must be rewritten to make them a handler instead (or
deleted if they only tested manual ownership) — say which in your report.

- [ ] **Step 6: Run to verify RED**

Run: `node node_modules/vitest/vitest.mjs run src/server/cases/service.test.ts src/server/customers/service.test.ts src/server/dashboard/service.test.ts`
Expected: FAIL for the new tests (and typecheck errors in production files — that is expected until
Step 7).

- [ ] **Step 7: Implement the callers**

`src/server/cases/service.ts`:
- Imports: drop `caseOwnerEntries`, `caseOwners`; add `caseHandlers`.
- `caseForAccess(row)` returns `{ id: row.id, customerId: row.customerId, title: row.title, createdBy: row.createdBy, assignee: row.assignee }`.
- `visibleCase` and `ensureVisible` pass `ownership` as the 4th argument to `ensureCanSeeCase`.
- Replace `ownerEmails(row)` with
  ```typescript
  function handlerEmails(row: CaseRow, ownership: Ownership): string[] {
    return caseHandlers(caseForAccess(row), ownership);
  }
  ```
  (`cases/service.ts`'s local `Ownership` type is `{ handlerEmailsByCustomerId: Record<string, string[]> }`
  — structurally an `AccessOwnership`, so it passes straight through. `customers/service.ts` uses a
  differently-keyed `{ handlersByCustomerId }` and must go through its existing `accessOwnership()`
  converter, as the `getCustomer` snippet below does.)
- Delete `realHandlerEmails` (its only caller is `removeCaseOwner`).
- `formatCase`: replace the `owners`/`ownerEmails`/`ownerList` fields (and the P10 comment) with
  ```typescript
      handlers: handlers.map((email) => nameOf(users, email)),
      handlerList: handlers.map((email) => ({ email, name: nameOf(users, email) })),
  ```
  where `const handlers = handlerEmails(row, ownership);` replaces `const owners = ownerEmails(row);`.
- `listCases`: `isOwned = wantOwned && handlerEmails(row, ownership).includes(me)`; the row field
  `owners:` becomes `handlers: handlerEmails(row, ownership).map((email) => nameOf(idx, email))`.
  Update the comment near the `owned` filter to say "owned = the case's account is one I handle, or
  I created it and the account has no handler".
- Delete the `addCaseOwner` and `removeCaseOwner` methods.

`src/server/cases/rpc.ts`: delete the `api_addCaseOwner` and `api_removeCaseOwner` registrations.

`src/server/rpc/api-parity.test.ts`: `docs/source-appscript/Code.gs` (the archived legacy server —
do NOT edit it) still defines both functions, so the second test needs them accounted for. Set:
```typescript
    // Retired 2026-09-18: case-level ownership was eliminated; a case's owners are its account's
    // handlers. See docs/superpowers/specs/2026-09-18-eliminate-case-owner-layer-design.md.
    const intentionallyUnmigrated: string[] = ['api_addCaseOwner', 'api_removeCaseOwner'];
```

`src/server/quotes/service.ts`: the `ensureCanSeeCase(user, ..., row)` call (~line 280) becomes
`ensureCanSeeCase(user, ..., row, ownership)` — `ownership` is already in scope from
`ensureFullCustomer`. `row` is a `QuoteCaseRow`, which already has `createdBy`.

`src/server/dashboard/service.ts`:
- Import `caseHandlers` instead of `caseOwners`.
- `caseRecord(row)` returns `{ id, customerId, title, createdBy: row.createdBy, assignee }`.
- The `caseVisible(...)` call passes `ownership` as its 4th argument.
- `const owners = caseOwners(caseRecord(row));` → `const handlers = caseHandlers(caseRecord(row), ownership);`
  and `owners.includes(subjectEmail)` → `handlers.includes(subjectEmail)`. Keep the Direct-subject
  branch (`directSubject ? subjectHandles.has(row.customerId) : ...`) unchanged; update its P9 comment
  to say "case handler set" instead of "case's owner set".

`src/server/customers/repository.ts` `listCasesByCustomer`: delete the `-- P11` comment, the
`case when cardinality(so.owners) ...` expression and the `left join lateral (...) so on true` block;
select `c.created_by` instead. In the row types: `CustomerCaseDbRow.owners` → `created_by: string | null`;
`toCustomerCase` sets `createdBy: normalizeEmail(row.created_by)` instead of `owners`.
`src/server/customers/service.ts`: `CustomerCaseSummary.owners: string[]` → `createdBy: string`. In
`getCustomer`'s FULL branch:
```typescript
        cases: cases.map(({ createdBy, ...caseRow }) => ({
          ...caseRow,
          handlers: caseHandlers(
            { id: caseRow.id, customerId: caseRow.customerId, title: caseRow.title, createdBy, assignee: caseRow.assignee },
            accessOwnership(ownership)
          ).map((email) => nameOf(idx, email))
        })),
```
This deletes the SQL-side duplicate of the ownership rule — there is now exactly one implementation.

- [ ] **Step 8: Run GREEN, prove teeth, full gate**

Focused: the four test files above — PASS. Teeth: temporarily make `caseHandlers` return
`customerRealHandlers(...)` only (no creator fallback); confirm the customerless/handler-less tests in
access, cases, customers and dashboard all fail; restore. Then `npm test`, `npm run typecheck`.
`grep -rn "caseOwners\|caseOwnerEntries\|caseOwnerSource\|ownerList\|ownerEmails" src --include=*.ts`
returns nothing outside test files that Task 4 will delete (list any remaining hits in your report).

- [ ] **Step 9: Commit**

```bash
git add -A src/server
git commit -m "feat: derive case ownership live from account handlers; retire case-owner RPCs"
```
(Check `git status` first — only `src/server/**` files should be staged.)

---

## Task 4: Drop the columns and every write path

**Files:**
- Create: `supabase/migrations/0014_drop_case_owner_columns.sql`
- Create: `src/server/db/drop-case-owner-migration.test.ts`
- Modify: `src/server/db/case-write.ts`, `src/server/cases/repository.ts` (`listCases` select),
  `src/server/cases/service.ts` (`CaseRow`, `createCase`, `quickLog`, `seedOwners`),
  `src/server/quotes/service.ts` (`QuoteCaseRow`, auto-case creation),
  `src/server/customers/service.ts` (`addHandler`, `CaseOwnerRow`, repository interface, L5/L6 message),
  `src/server/customers/repository.ts` (`listCaseOwnerRows`, `setCaseExtraOwners`)
- Delete: `src/server/cases/owner-seed.ts`, `src/server/cases/owner-seed.test.ts`
- Modify tests: every fixture/fake still carrying `owner`/`extraOwners`/`listCaseOwnerRows`/`setCaseExtraOwners`
  (`npm run typecheck` lists them), `src/server/customers/handler-cleanup.test.ts`,
  `src/server/db/case-repository-writes.test.ts`, `src/server/integration/*.test.ts`

**Interfaces:**
- Consumes: `caseHandlers` (Task 3); `applyCasesColumnMigration` (Task 1) — this task's migration is
  what makes Task 1 matter.
- Produces: `public.cases` has no `owner`/`extra_owners` columns and no `cases_owner_outcome_idx`;
  `CaseRow`, `QuoteCaseRow`, `CaseWriteRow`, `CaseWriteDbRow` have no `owner`/`extraOwners` fields.

- [ ] **Step 1: Write the failing migration test**

`src/server/db/drop-case-owner-migration.test.ts`, following the style of
`src/server/db/customerless-migration.test.ts` (read it first):

```typescript
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { allCasesColumns } from './cases-columns.test-helpers';

const migrationsDir = path.join(__dirname, '../../../supabase/migrations');
const migrationPath = path.join(migrationsDir, '0014_drop_case_owner_columns.sql');

function statements(sql: string): string[] {
  return sql
    .replace(/do \$\$[\s\S]*?\$\$;/g, '')
    .replace(/--[^\n]*/g, '')
    .split(';')
    .map((s) => s.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
}

describe('drop case owner columns migration', () => {
  const sql = fs.existsSync(migrationPath) ? fs.readFileSync(migrationPath, 'utf8') : '';
  const structural = statements(sql).filter((s) => /^(alter table|drop index)/.test(s));

  it('exists', () => {
    expect(fs.existsSync(migrationPath)).toBe(true);
  });

  it('drops exactly owner and extra_owners from public.cases, and nothing else', () => {
    const dropped = structural.filter((s) => s.startsWith('alter table')).map((s) => s.match(/drop column (?:if exists )?(\w+)/)?.[1]);
    expect(dropped.sort()).toEqual(['extra_owners', 'owner']);
    for (const s of structural.filter((x) => x.startsWith('alter table'))) {
      expect(s).toMatch(/^alter table public\.cases drop column /);
    }
  });

  it('drops the owner index', () => {
    expect(structural).toContain('drop index if exists public.cases_owner_outcome_idx');
  });

  it('sets a lock timeout and verifies its own post-conditions', () => {
    expect(statements(sql)).toContain("set local lock_timeout = '3s'");
    expect(sql.match(/raise exception/g)?.length).toBe(2);
  });

  it('leaves the column-parity parser with neither column', () => {
    const columns = allCasesColumns(migrationsDir);
    expect(columns).not.toContain('owner');
    expect(columns).not.toContain('extra_owners');
    expect(columns).toContain('created_by');
  });
});
```

- [ ] **Step 2: Run RED**

Run: `node node_modules/vitest/vitest.mjs run src/server/db/drop-case-owner-migration.test.ts`
Expected: FAIL — the migration file does not exist.

- [ ] **Step 3: Write the migration**

`supabase/migrations/0014_drop_case_owner_columns.sql`:
```sql
-- Case ownership is no longer stored on the case. A case's owners are its account's handlers,
-- derived live (src/server/auth/access.ts caseHandlers), with the case creator (created_by) as
-- the fallback when the account has no real handler. The two columns that materialised
-- case-level ownership, and the index on one of them, are removed.
--
-- Backups taken before this migration still carry owner/extra_owners on public.cases rows.
-- scripts/restore-database.mjs inserts every key it finds, so strip those two keys before
-- restoring such a backup into a post-0014 schema.
--
-- scripts/apply-migrations.mjs wraps each file in a single transaction; do not BEGIN/COMMIT here.

set local lock_timeout = '3s';

drop index if exists public.cases_owner_outcome_idx;
alter table public.cases drop column if exists owner;
alter table public.cases drop column if exists extra_owners;

do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'cases' and column_name in ('owner', 'extra_owners')
  ) then
    raise exception 'public.cases.owner and extra_owners must be gone after this migration';
  end if;

  if exists (select 1 from pg_indexes where schemaname = 'public' and indexname = 'cases_owner_outcome_idx') then
    raise exception 'cases_owner_outcome_idx must be gone after this migration';
  end if;
end $$;
```

Before relying on it, confirm by reading every migration and `src/` that nothing else depends on
these columns (views, functions, RLS policies, triggers): `grep -rn "extra_owners\|cases.owner\|\bowner\b" supabase/migrations`.
Only `0001`, `0003`, `0005`, `0006` should hit — all historical, already applied, and they run
before `0014` on a fresh database. Report what you found.

- [ ] **Step 4: Remove the columns from every read and write path**

- `src/server/db/case-write.ts`: remove `owner` and `extraOwners` from `CASE_WRITE_FIELDS`,
  `CASE_WRITE_COLUMNS`, `CaseWriteRow`, `CaseWriteDbRow`, `toCaseWriteRow`, `toCaseWriteValues`, both
  SELECTs (`selectCaseRow`, `selectCaseRowForUpdate`) and `insertCaseRow` (column list AND values —
  count them: the VALUES list must match the column list exactly).
- `src/server/cases/repository.ts` `listCases`: remove `owner, extra_owners` from the SELECT.
- `CaseRow` (`cases/service.ts`) and `QuoteCaseRow` (`quotes/service.ts`): remove `owner` and `extraOwners`.
- `cases/service.ts`: in `createCase` and `quickLog`, delete the `owner:` and `extraOwners:` lines and
  the P11 comment above them; delete `seedOwners` and its doc comment. `createdBy` is already set on
  both paths — confirm it.
- `quotes/service.ts` auto-case creation (~line 416): delete `owner:` and `extraOwners: []`; confirm
  `createdBy` is set.
- `customers/service.ts`: delete `CaseOwnerRow` and `listCaseOwnerRows`/`setCaseExtraOwners` from the
  repository interface; in `addHandler` delete the propagation loop and its P11 comment (keep the
  transaction — it still makes `removeDirectHandlers` + `addHandler` + `logActivity` atomic). Change
  the L5/L6 rejection message to
  `` `L5 and L6 users cannot be account handlers. ${nameOf(idx, email)} can still be a ticket assignee.` ``
  and its comment to "They remain fully eligible as ticket assignees." (they already see every case as L4+).
- `customers/repository.ts`: delete `listCaseOwnerRows` and `setCaseExtraOwners` and any now-unused imports.
- Delete `src/server/cases/owner-seed.ts` and `src/server/cases/owner-seed.test.ts` (a frozen
  reference implementation of migration `0005`'s old derivation; nothing imports it but its own test).

- [ ] **Step 5: Sweep the tests**

Run `npm run typecheck` and fix every error in test files by removing `owner`/`extraOwners` fixture
fields and the two fake repo methods. Then:
- `src/server/db/case-repository-writes.test.ts`: remove the `owner`/`extraOwners` entries from its
  column/value fixture table (its `satisfies` type forces this).
- `src/server/customers/handler-cleanup.test.ts`: delete only the
  `'no case loses an owner across the migration, because ownership is materialised'` test, the
  `caseOwners` import, and `owner`/`extraOwners` from its local `Case` type. Keep the two tests about
  the historical `0006` migration's SQL.
- `src/server/customers/service.test.ts`: delete tests asserting that adding a handler writes
  `extra_owners` onto active cases / skips closed ones. Add: adding a handler performs no case write
  at all (the fake repo's case rows are byte-identical before and after) AND the new handler now sees
  both an active and a closed case of that customer via `caseHandlers`.
- `src/server/integration/crm-flows.test.ts` and `concurrency.test.ts`: replace assertions on
  `owner`/`extraOwners` with the equivalent handler assertion (e.g. "case owners unchanged" becomes
  "`caseHandlers` for the case still equals the account's handlers"), or delete an assertion that only
  existed to prove materialisation. List every change in your report.
- **The three creation paths now agree** (spec requirement; before this change the auto-case path
  seeded no handlers while `createCase`/`quickLog` did). Add one test to
  `src/server/integration/crm-flows.test.ts`, reusing its existing `makeServices()` harness: for one
  customer with one real handler H, created by the same user U — an L3 whose tags match the customer,
  so U has FULL access by tag without ever being a handler (both `createCase` and quotation creation
  require FULL access; an L2 would be rejected) — create a case three ways —
  `caseService.createCase(U, customerId, {...})`, `caseService.quickLog(U, {...})` with that
  customer, and a first quotation saved as Sent with no `caseId` (which auto-creates the case in
  `quotes/service.ts`). Assert `getCase(...).case.handlerList.map((h) => h.email)` is exactly `[H]` for
  all three, and that none of the three responses contains U unless U is H. Then repeat the three
  creations against a Direct-only customer and assert all three return exactly `[U]`. Read the
  existing tests in that file for the exact `createCase`/`quickLog`/`createQuotation` input shapes
  rather than guessing field names.

- [ ] **Step 6: GREEN, teeth, full gate**

`node node_modules/vitest/vitest.mjs run src/server/db/drop-case-owner-migration.test.ts` — PASS.
Teeth: temporarily delete the `extra_owners` line from the migration; confirm the drop-exactly test
and the parity-parser test both fail; restore. Then `npm test`, `npm run typecheck`, `npm run build`.
Finally: `grep -rn "extraOwners\|extra_owners\|caseOwners\|CaseOwnerRow\|listCaseOwnerRows\|setCaseExtraOwners\|seedOwners" src tests`
must return nothing, and `grep -rn "\.owner\b\|owner:" src/server --include=*.ts` must return nothing
that refers to the case owner column (report any remaining hit and why it is unrelated).

- [ ] **Step 7: Dry-run the migration against the real schema (read-only)**

Using the gitignored `.env.local` `DATABASE_URL` (never print it):
`node scripts/apply-migrations.mjs --through 0014 --dry-run` — it must list exactly `0014` as pending.
Do NOT run it without `--dry-run`: applying to production is the project owner's call, made after
merge. Report the dry-run output.

- [ ] **Step 8: Commit**

```bash
git add -A supabase/migrations/0014_drop_case_owner_columns.sql src/server
git commit -m "feat: drop case-level ownership columns; case owners are account handlers"
```
(`git status` first — confirm `owner-seed.ts`/`owner-seed.test.ts` show as deleted and nothing outside
`src/server/**` and the migration is staged.)

---

## Task 5: Documentation and the before/after report

**Files:**
- Modify: `CONTEXT.md`
- Create: `docs/reports/2026-09-18-case-owner-layer-removal.md`

**Interfaces:** none — documentation only. No code changes.

- [ ] **Step 1: `CONTEXT.md`**

Add a "Current Production Status" entry in the file's existing style: the goal, the `caseHandlers`
rule (handlers, else creator; live; no freeze on closed cases), the removed RPCs and UI, migration
`0014` (NOT applied — applying it is a separate owner-approved step), the backup-restore caveat, and
the two confirmed access reductions (creator loses access once a handler exists unless assignee;
manually-added case owners lose access). Also correct every older passage that now describes the
removed model as current — search for `extra_owners`, `caseOwners`, `P10`, `P11`, `manage owners`,
`case owner` and add a one-line "superseded 2026-09-18 by ..." note rather than rewriting history.
Update the `Last updated:` line.

- [ ] **Step 2: The report**

`docs/reports/2026-09-18-case-owner-layer-removal.md`: a short statement of the goal and how it was
achieved (one paragraph each), then this table, filled in from the actual shipped code — every row
must be true of the code at HEAD, verified by reading it, not copied from the spec:

| What changed | Previous behavior | New behavior |
|---|---|---|
| Who owns a case | | |
| Where ownership is stored | | |
| Account with no real handler (customerless / Direct-only) | | |
| Closed (Won/Lost/Hold) cases when handlers change | | |
| Adding a handler to a customer | | |
| Removing a handler from a customer | | |
| Manually adding/removing a case owner | | |
| Case creator's access | | |
| Case visibility rule | | |
| "Owned by me" filter / dashboard "my cases" | | |
| Case page / Cases tab / customer case list label | | |
| Reassignment suggestions | | |
| RPC surface | | |
| Database schema | | |
| Number of implementations of the ownership rule | | |

End with the verification numbers (unit/integration tests, Playwright, typecheck, build) and the
explicit note that migration `0014` has not been applied.

- [ ] **Step 3: Commit**

```bash
git add CONTEXT.md docs/reports/2026-09-18-case-owner-layer-removal.md
git commit -m "docs: record elimination of the case-owner layer, with before/after report"
```
