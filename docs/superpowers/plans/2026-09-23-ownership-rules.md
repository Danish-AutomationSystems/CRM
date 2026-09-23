# Ownership Rules Implementation Plan (Track A: P1–P4)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A case's handler is its customer's account handler, always. The creator fallback is replaced by Direct, a case can never exist without a customer, creators own what they create, and ownership can never reach zero.

**Architecture:** Ownership stays derived, never stored. `caseHandlers()` returns the customer's handler rows (which include the virtual `direct`) instead of falling back to the creator. Every customer is guaranteed at least one handler row by a backfill migration, by customer creation, and by a floor on handler removal.

**Tech Stack:** TypeScript, Next.js 15.5, postgres.js, Supabase, Vitest.

Spec: `docs/superpowers/specs/2026-09-23-ownership-and-location-rules-design.md`

## Global Constraints

- **TDD is mandatory.** Write the test, run it, watch it fail for the right reason, then implement. Never write production code first. Never weaken a test to make it green.
- The full existing suite (**793 tests**) must stay green. A pre-existing failure means behaviour changed — fix the code, not the test.
- `direct` (the constant `DIRECT_EMAIL` in `src/server/domain/direct.ts`) is a **virtual** handler. No real account has that email, so it must never grant access to any human.
- Ownership is **derived**. Never write a case-level owner column; the 2026-09-18 work deliberately removed those.
- L5 and L6 can never be an account handler.
- Run `npx tsc --noEmit -p tsconfig.json` before every commit.
- Do not push. The coordinator verifies and pushes.

---

### Task 1: Direct replaces the creator fallback

**Files:**
- Modify: `src/server/auth/access.ts`
- Modify: `src/server/auth/access.test.ts`
- Create: `supabase/migrations/0015_backfill_direct_handlers.sql`

**Interfaces:**
- Produces: `caseHandlers(caseRecord, ownership)` now returns the account's handler rows, falling back to `[DIRECT_EMAIL]` when there are none — never the creator.

- [ ] **Step 1: Write the failing tests**

Add to `src/server/auth/access.test.ts`. Read the existing file first and match its helper style and imports; these are the behaviours, not necessarily the literal helper names:

```typescript
describe('caseHandlers — Direct replaces the creator fallback', () => {
  it('returns Direct, not the creator, when the account has no real handler', () => {
    const ownership = { handlerEmailsByCustomerId: { 'CUST-1': ['direct'] } };
    const caseRecord = { id: 'CASE-1', customerId: 'CUST-1', createdBy: 'l2@automationsystems.org', assignee: '' };

    expect(caseHandlers(caseRecord, ownership)).toEqual(['direct']);
  });

  it('returns Direct even when the account has no handler row at all', () => {
    const ownership = { handlerEmailsByCustomerId: {} };
    const caseRecord = { id: 'CASE-1', customerId: 'CUST-1', createdBy: 'l2@automationsystems.org', assignee: '' };

    expect(caseHandlers(caseRecord, ownership)).toEqual(['direct']);
  });

  it('returns the real handlers when they exist, never the creator', () => {
    const ownership = { handlerEmailsByCustomerId: { 'CUST-1': ['handler@automationsystems.org'] } };
    const caseRecord = { id: 'CASE-1', customerId: 'CUST-1', createdBy: 'creator@automationsystems.org', assignee: '' };

    expect(caseHandlers(caseRecord, ownership)).toEqual(['handler@automationsystems.org']);
  });
});

describe('caseVisible — the ghost-visibility fix', () => {
  const l2 = { email: 'creator@automationsystems.org', role: 'L2', allowedTags: [] };

  it('denies the creator a Direct-held case they are not assigned', () => {
    const ownership = { handlerEmailsByCustomerId: { 'CUST-1': ['direct'] } };
    const caseRecord = { id: 'CASE-1', customerId: 'CUST-1', createdBy: 'creator@automationsystems.org', assignee: '' };

    expect(caseVisible(l2, 'NONE', caseRecord, ownership)).toBe(false);
  });

  it('still allows the creator when they are the assignee', () => {
    const ownership = { handlerEmailsByCustomerId: { 'CUST-1': ['direct'] } };
    const caseRecord = {
      id: 'CASE-1',
      customerId: 'CUST-1',
      createdBy: 'creator@automationsystems.org',
      assignee: 'creator@automationsystems.org'
    };

    expect(caseVisible(l2, 'NONE', caseRecord, ownership)).toBe(true);
  });

  it('grants nobody access merely because Direct holds the account', () => {
    const ownership = { handlerEmailsByCustomerId: { 'CUST-1': ['direct'] } };
    const caseRecord = { id: 'CASE-1', customerId: 'CUST-1', createdBy: 'someone@automationsystems.org', assignee: '' };
    const unrelated = { email: 'other@automationsystems.org', role: 'L3', allowedTags: [] };

    expect(caseVisible(unrelated, 'NONE', caseRecord, ownership)).toBe(false);
  });

  it('still lets L4+ see everything', () => {
    const ownership = { handlerEmailsByCustomerId: { 'CUST-1': ['direct'] } };
    const caseRecord = { id: 'CASE-1', customerId: 'CUST-1', createdBy: 'someone@automationsystems.org', assignee: '' };
    const l4 = { email: 'boss@automationsystems.org', role: 'L4', allowedTags: [] };

    expect(caseVisible(l4, 'FULL', caseRecord, ownership)).toBe(true);
  });
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `npx vitest run src/server/auth/access.test.ts`
Expected: the Direct tests FAIL because the creator is returned instead (`expected [ 'creator@...' ] to deeply equal [ 'direct' ]`), and the ghost-visibility test FAILS with `expected true to be false`. That second failure **is the bug being fixed** — confirm you see it before changing anything.

- [ ] **Step 3: Replace the fallback**

In `src/server/auth/access.ts`, replace `caseHandlers` and update the doc comment above it. The creator fallback goes entirely:

```typescript
/**
 * Who owns a case: its account's handlers, derived live - ownership is never stored on the case.
 * An account with no real handler is held by the virtual `direct` account, which is a real row in
 * public.handlers. Direct is an owner for display and reporting only: no human holds that email,
 * so it grants access to nobody. The creator has no claim on a case merely for having created it.
 */
export function caseHandlers(caseRecord: CaseRecord, ownership: AccessOwnership): string[] {
  const handlers = customerHandlers(caseRecord.customerId, ownership);
  return handlers.length > 0 ? handlers : [DIRECT_EMAIL];
}
```

`customerHandlers` is the module-private helper that returns every handler row including `direct`. Import `DIRECT_EMAIL` from `../domain/direct`. Leave `customerRealHandlers` in place — it answers "is this person a real account handler" and other callers rely on it.

- [ ] **Step 4: Run them and watch them pass**

Run: `npx vitest run src/server/auth/access.test.ts`
Expected: PASS. Other tests in this file may now fail **if they asserted the old creator-fallback behaviour** — those assertions encoded the defect. Update only assertions that are specifically about the creator fallback, and say exactly which ones you changed and why in your report. Do not touch any other failing assertion; report it instead.

- [ ] **Step 5: Write the backfill migration**

Four customers have no handler row (`CUST-0002`, `CUST-0007`, `CUST-0008`, `CUST-0011`). Read `supabase/migrations/0014_*.sql` first and follow the house pattern exactly (`set local lock_timeout`, and a post-condition `do $$ ... raise exception` block asserting the invariant holds).

```sql
insert into public.handlers (customer_id, user_email, assigned_by, assigned_at)
select c.customer_id, 'direct', 'migration-0015', now()
from public.customers c
where not exists (select 1 from public.handlers h where h.customer_id = c.customer_id);
```

The post-condition must assert that **zero** customers remain without a handler row.

- [ ] **Step 6: Run the full suite, type check, commit**

```bash
npx vitest run
npx tsc --noEmit -p tsconfig.json
git add src/server/auth/access.ts src/server/auth/access.test.ts supabase/migrations/0015_backfill_direct_handlers.sql
git commit -m "feat: Direct owns a case with no account handler, replacing the creator fallback"
```

---

### Task 2: A case cannot be created without a customer

**Files:**
- Modify: `src/server/cases/service.ts`
- Modify: `src/server/cases/service.test.ts`

**Interfaces:**
- Consumes: Task 1's ownership rule (a customerless case can no longer exist, so Direct never has to cover one).

- [ ] **Step 1: Write the failing tests**

```typescript
describe('createCase requires a customer', () => {
  it('rejects a case with no customer', async () => {
    const { service, context } = makeService();

    await expect(service.createCase(context, '', { title: 'No company' })).rejects.toThrow(
      /customer|company/i
    );
  });

  it('still creates a case when a customer is given', async () => {
    const { service, context } = makeService();

    const created = await service.createCase(context, 'CUST-0001', { title: 'With company' });

    expect(created).toBeTruthy();
  });
});
```

Match the existing file's helper for building a service and context — read it first rather than inventing `makeService`.

- [ ] **Step 2: Run and watch the first test fail**

Run: `npx vitest run src/server/cases/service.test.ts`
Expected: the rejection test FAILS because an empty customer is currently allowed.

- [ ] **Step 3: Require a customer in every creation path**

In `createCase`, immediately after `customerId = asText(customerId);`, reject an empty value:

```typescript
if (!customerId) {
  throw new Error('Select a company for this case. A case cannot be created without one.');
}
```

Then apply the same guard to the other two creation paths: `quickLog` in the same file, and the auto-case-from-quotation path in `src/server/quotes/service.ts`. Find them by searching for `createCase` and for where a case row is inserted. If a path genuinely cannot supply a customer, STOP and report it rather than inventing a workaround.

- [ ] **Step 4: Run and watch them pass**

Run: `npx vitest run src/server/cases/service.test.ts`
Expected: PASS. Existing tests that created a case without a customer will now fail — those encoded the behaviour being removed. Update them to pass a customer, and list each one in your report.

- [ ] **Step 5: Remove the client's "create without customer" control**

In `docs/source-appscript/Index.html` and the generated `src/app/crm/legacy-full.generated.ts`, find the control that lets a user proceed without selecting a customer (search for the new-case modal `mNewCase` and for wording about creating without a customer/company). Remove the control **and the branch behind it**, so the customer field is mandatory.

`legacy-full.generated.ts` is generated from `docs/source-appscript/Index.html` by `scripts/port-legacy-index.mjs`. Change the source, then regenerate rather than hand-editing the generated file. If regeneration is unclear, STOP and report instead of editing both by hand.

- [ ] **Step 6: Full suite, type check, commit**

```bash
npx vitest run
npx tsc --noEmit -p tsconfig.json
git commit -am "feat: require a customer on every case-creation path"
```

---

### Task 3: The creator owns the customer they create

**Files:**
- Modify: `src/server/customers/service.ts`
- Modify: `src/server/customers/service.test.ts`

**Interfaces:**
- Consumes: `DIRECT_EMAIL` from `src/server/domain/direct.ts`.

- [ ] **Step 1: Write the failing tests**

```typescript
describe('createCustomer assigns the account handler', () => {
  it('makes an L2 creator the account handler', async () => {
    const { service, repo } = makeService();
    const l2 = { email: 'l2@automationsystems.org', role: 'L2', allowedTags: ['Punjab'], name: 'L2', active: true };

    const created = await service.createCustomer(l2, { name: 'Acme', tags: ['Punjab'] });

    expect(repo.handlersFor(created.id)).toEqual(['l2@automationsystems.org']);
  });

  it('makes an L4 creator the account handler', async () => {
    const { service, repo } = makeService();
    const l4 = { email: 'l4@automationsystems.org', role: 'L4', allowedTags: [], name: 'L4', active: true };

    const created = await service.createCustomer(l4, { name: 'Beta', tags: ['Punjab'] });

    expect(repo.handlersFor(created.id)).toEqual(['l4@automationsystems.org']);
  });

  it('gives a customer created by L6 to Direct, never to the creator', async () => {
    const { service, repo } = makeService();
    const l6 = { email: 'l6@automationsystems.org', role: 'L6', allowedTags: [], name: 'L6', active: true };

    const created = await service.createCustomer(l6, { name: 'Gamma', tags: ['Punjab'] });

    expect(repo.handlersFor(created.id)).toEqual(['direct']);
    expect(repo.handlersFor(created.id)).not.toContain('l6@automationsystems.org');
  });

  it('gives a customer created by L5 to Direct', async () => {
    const { service, repo } = makeService();
    const l5 = { email: 'l5@automationsystems.org', role: 'L5', allowedTags: [], name: 'L5', active: true };

    const created = await service.createCustomer(l5, { name: 'Delta', tags: ['Punjab'] });

    expect(repo.handlersFor(created.id)).toEqual(['direct']);
  });
});
```

Read the existing test file first and reuse its fake-repository helper; add a `handlersFor` accessor to it if one does not already exist.

- [ ] **Step 2: Run and watch them fail**

Run: `npx vitest run src/server/customers/service.test.ts`
Expected: FAIL — no handler is assigned at creation today.

- [ ] **Step 3: Assign the handler inside the existing creation transaction**

In `createCustomer`, inside the `repo.withTransaction` callback that already inserts the customer, insert a handler row: the creator's email when `roleLevel(user) <= 4`, otherwise `DIRECT_EMAIL`. Use `trx` (the transaction handle), never the outer `repo` — using the outer one checks out a second pooled connection while holding the first, which is the deadlock documented in `src/server/settings/no-live-settings-in-transaction.test.ts`.

- [ ] **Step 4: Run and watch them pass**

Run: `npx vitest run src/server/customers/service.test.ts`
Expected: PASS.

- [ ] **Step 5: Full suite, type check, commit**

```bash
npx vitest run
npx tsc --noEmit -p tsconfig.json
git commit -am "feat: the creator becomes the account handler, or Direct for L5/L6"
```

---

### Task 4: Ownership can never reach zero

**Files:**
- Modify: `src/server/customers/service.ts`
- Modify: `src/server/customers/service.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
describe('removeHandler keeps ownership non-empty', () => {
  it('leaves the remaining handlers when one of several is removed', async () => {
    const { service, repo, admin } = makeService();
    repo.setHandlers('CUST-1', ['a@automationsystems.org', 'b@automationsystems.org']);

    await service.removeHandler(admin, 'CUST-1', 'a@automationsystems.org');

    expect(repo.handlersFor('CUST-1')).toEqual(['b@automationsystems.org']);
  });

  it('falls back to Direct when the last real handler is removed', async () => {
    const { service, repo, admin } = makeService();
    repo.setHandlers('CUST-1', ['only@automationsystems.org']);

    await service.removeHandler(admin, 'CUST-1', 'only@automationsystems.org');

    expect(repo.handlersFor('CUST-1')).toEqual(['direct']);
  });
});
```

- [ ] **Step 2: Run and watch the second test fail**

Run: `npx vitest run src/server/customers/service.test.ts`
Expected: the Direct-floor test FAILS — the customer is left with no handler at all.

- [ ] **Step 3: Add the floor, inside a transaction**

`removeHandler` currently removes the row outside any transaction (`src/server/customers/service.ts:928-949`). Wrap the removal and the floor together in `repo.withTransaction`, using `trx` throughout: remove the handler, re-read that customer's handlers, and if no real (non-`direct`) handler remains, insert a `direct` row. Removing and inserting must not be separable — a crash between them would strand the customer with no owner.

Keep the existing permission check and the `HANDLER_REMOVE` activity log exactly as they are.

- [ ] **Step 4: Run and watch them pass**

Run: `npx vitest run src/server/customers/service.test.ts`
Expected: PASS.

- [ ] **Step 5: Full suite, type check, commit**

```bash
npx vitest run
npx tsc --noEmit -p tsconfig.json
git commit -am "feat: removing the last account handler falls back to Direct"
```
