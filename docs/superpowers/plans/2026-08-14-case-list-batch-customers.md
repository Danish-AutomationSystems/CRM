# Case List Customer Batching Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the case list's one-query-per-case customer lookup with a single batched query, removing a page-latency wall that scales with case count.

**Architecture:** `getCustomersByIds` already exists on the concrete Postgres repository and already serves the dashboard. It is simply not declared on `CaseRepository`, so the cases service cannot see it. Declare it, call it over the distinct customer ids, and implement it on the four in-memory test fakes.

**Tech Stack:** TypeScript, Next.js 15 App Router, `postgres.js`, vitest, Playwright.

## Global Constraints

- **Design spec:** `docs/superpowers/specs/2026-08-14-case-list-batch-customers-design.md`. Read it first — it contains the behaviour-equivalence analysis this whole change rests on.
- **This change must be invisible.** The case list's payload, filtering, ownership and visibility rules must all be byte-identical. The existing `listCases` tests are the real regression guard; **they must pass unchanged.** If you find yourself editing an existing `listCases` assertion, stop — that means behaviour shifted, which is a failure, not a test that needs updating.
- **No new SQL.** `getCustomersByIds` already exists at `src/server/cases/repository.ts:231`. Do not write another query, do not modify that one.
- **No migration.**
- **The fakes must match the real query's semantics.** In-memory fakes drifting from the SQL has already produced vacuous tests twice in this codebase — most recently `listActivityByEntity` ignoring its `limit 40`. `getCustomersByIds` returns only the rows that exist, in arbitrary order, and returns `[]` for an empty id list.
- **TDD is mandatory.** Every code change is preceded by a test that is run and *seen to fail* first.
- **Baseline that must not regress: 280 vitest tests and 22 Playwright tests currently pass.**
- Playwright needs env vars or the dev server will not boot:
  `$env:NEXT_PUBLIC_SUPABASE_URL="http://127.0.0.1:3999"; $env:NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY="dummy-key-for-e2e"; npx playwright test`
  **Never pipe Playwright through `tail` or `head`** — it masks the exit code and a failing run reports as success.
- **Never commit secrets.** Do not open, read, or echo `.env.local`.
- Run commands from the repo root: `D:\AutomationSystems\CRM\migrated-crm`. Windows; use the PowerShell tool.

---

## File Structure

| File | Responsibility | Change |
|---|---|---|
| `src/server/cases/service.ts` | Case business logic | **Modify** — declare `getCustomersByIds` on `CaseRepository`; replace the loop in `listCases` |
| `src/server/cases/service.test.ts` | Unit tests | **Modify** — add `getCustomersByIds` to `FakeCaseRepository`; new batching tests |
| `src/server/dashboard/service.test.ts` | Fake | **Modify** — add the method |
| `src/server/integration/concurrency.test.ts` | Fake | **Modify** — add the method |
| `src/server/integration/crm-flows.test.ts` | Fake | **Modify** — add the method |

`src/server/cases/repository.ts` is **not modified** — the method it needs is already there.

---

### Task 1: Batch the customer lookup

**Files:**
- Modify: `src/server/cases/service.ts` (the `CaseRepository` type around line 113; `listCases` at 629-642)
- Modify: `src/server/cases/service.test.ts` (`FakeCaseRepository` at line 20)
- Modify: `src/server/dashboard/service.test.ts` (fake at ~line 61), `src/server/integration/concurrency.test.ts` (~line 100), `src/server/integration/crm-flows.test.ts` (~line 131)

**Interfaces:**
- Consumes: `getCustomersByIds` as already implemented at `src/server/cases/repository.ts:231`:
  ```ts
  async getCustomersByIds(ids: string[]): Promise<CaseCustomerRow[]>
  ```
  Returns only rows that exist, arbitrary order, `[]` when `ids` is empty.
- Produces: nothing new for later tasks.

- [ ] **Step 1: Write the failing tests**

Add to `src/server/cases/service.test.ts`. First, give `FakeCaseRepository` a call counter so the tests can prove batching actually happened — add these two members alongside the existing fields:

```ts
  getCustomerCalls = 0;
  getCustomersByIdsCalls: string[][] = [];
```

Then increment `getCustomerCalls` inside the fake's existing `getCustomer`, and add the new method:

```ts
  async getCustomersByIds(ids: string[]): Promise<CaseCustomerRow[]> {
    this.getCustomersByIdsCalls.push([...ids]);
    if (ids.length === 0) return [];
    return this.customers.filter((customer) => ids.includes(customer.id));
  }
```

That mirrors the real SQL: only existing rows, no ordering guarantee, empty in / empty out.

Now the tests:

```ts
  it('fetches every case customer in one batched query rather than one per case', async () => {
    const { repo, service } = makeService();
    repo.customers.push(customer({ id: 'CUST-0002', name: 'Second Customer' }));
    repo.cases = [
      caseRow({ id: 'CASE-2026-0001', customerId: 'CUST-0001' }),
      caseRow({ id: 'CASE-2026-0002', customerId: 'CUST-0001' }),
      caseRow({ id: 'CASE-2026-0003', customerId: 'CUST-0002' })
    ];

    await service.listCases(sales);

    expect(repo.getCustomersByIdsCalls).toHaveLength(1);
    expect([...repo.getCustomersByIdsCalls[0]].sort()).toEqual(['CUST-0001', 'CUST-0002']);
    expect(repo.getCustomerCalls).toBe(0);
  });

  it('still lists cases whose customer no longer exists exactly as before', async () => {
    const { repo, service } = makeService();
    repo.cases = [
      caseRow({ id: 'CASE-2026-0001', customerId: 'CUST-0001' }),
      caseRow({ id: 'CASE-2026-0002', customerId: 'CUST-GONE' })
    ];

    const listed = await service.listCases(sales);

    expect(listed.map((row) => row.id)).toEqual(['CASE-2026-0001']);
  });

  it('issues no customer query at all when there are no cases', async () => {
    const { repo, service } = makeService();
    repo.cases = [];

    const listed = await service.listCases(sales);

    expect(listed).toEqual([]);
    expect(repo.getCustomersByIdsCalls.flat()).toEqual([]);
    expect(repo.getCustomerCalls).toBe(0);
  });
```

**Check the helpers before using them.** `customer()` and `caseRow()` are the file's existing factories — read their signatures and confirm they accept the overrides used above (`id`, `customerId`, `name`). If they do not, adapt to how the file's existing tests build multi-customer fixtures. Do not invent a parallel fixture style.

**On the second test:** verify what `listCases` does today with a case whose customer is missing, and assert exactly that. The spec's claim is that such a case is skipped, because `customersById` never gets an entry for it. **Confirm that against the real code before writing the assertion** — if today's behaviour differs, the test must pin *today's* behaviour, since this change is required to be invisible.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/server/cases/service.test.ts`

Expected: FAIL. The batching test fails because `getCustomersByIdsCalls` is empty and `getCustomerCalls` equals 3. The empty-case-list test may already pass; that is fine and expected — note it in your report rather than forcing it to fail.

- [ ] **Step 3: Write the implementation**

In `src/server/cases/service.ts`, add to the `CaseRepository` type (near the other read methods around line 113):

```ts
  getCustomersByIds(ids: string[]): Promise<CaseCustomerRow[]>;
```

Then replace the loop in `listCases`:

```ts
      const caseRows = await repo.listCases();
      const customerIds = [...new Set(caseRows.map((row) => row.customerId).filter(Boolean))];
      const [cases, customers, handlers, users, quotedValues] = await Promise.all([
        Promise.resolve(caseRows),
        repo.getCustomersByIds(customerIds),
        repo.listHandlers(),
        repo.listUsers(),
        repo.latestQuotedValueByCase()
      ]);
```

Leave the `customersById` reduce below it **exactly as it is**. It already tolerates a shorter array and already skips falsy entries, which is precisely why this change is invisible.

- [ ] **Step 4: Add the method to the other three fakes**

`npx tsc --noEmit` will name them. Each already has a `getCustomer`; add a `getCustomersByIds` beside it with the same semantics as the one in Step 1.

**Do not use `as any`, do not cast, and do not loosen `CaseRepository`.** If a fake's customer collection is shaped differently, adapt the implementation to that shape rather than the type to the fake.

- [ ] **Step 5: Run everything**

```
npx vitest run src/server/cases/service.test.ts
npm test
npx tsc --noEmit
```

Expected: all pass, 280 baseline plus your new tests, typecheck clean.

**If any pre-existing `listCases` test fails, stop and report it.** This change is required to be behaviour-preserving; a failing existing test means it is not, and the correct response is to investigate, not to update the assertion.

- [ ] **Step 6: Commit**

```bash
git add src/server/cases/service.ts src/server/cases/service.test.ts src/server/dashboard/service.test.ts src/server/integration/concurrency.test.ts src/server/integration/crm-flows.test.ts
git commit -m "perf(cases): batch the case list's per-case customer lookup

One query per case became ceil(K/10) waves of a ~90ms Mumbai-to-Tokyo
round trip: roughly 4.5s at 500 cases. The batched query already existed
and already served the dashboard; the cases service just could not see it.

Behaviour-preserving: the fetched rows are collapsed into a keyed map, so
array length, order and positional alignment were never observable."
```

---

### Task 2: Gate, deploy, verify

**Files:** none changed unless a gate fails.

- [ ] **Step 1: Run the complete local gate**

```bash
npm run typecheck
npm test
npm run build
```
plus Playwright with the env vars from the Global Constraints.

Expected: typecheck clean, **at least 280 vitest** and **22 Playwright** passing, build succeeds.

- [ ] **Step 2: Back up the database**

```bash
node scripts/backup-database.mjs
node scripts/verify-backup.mjs backups/<the-file-it-just-wrote>.json
```

There is no schema change in this branch, so this is precaution rather than necessity — but the free tier takes no automatic backups, so it costs a minute and removes a category of risk.

- [ ] **Step 3: Merge and deploy**

```bash
git checkout main
git merge --no-ff feat/case-list-batch-customers
git push origin main
```

**No migration to apply.** Vercel deploys `main` automatically.

- [ ] **Step 4: Verify in production**

1. Open the Cases tab. Every case that was listed before must still be listed, with the same customer names, same stages, same assignees.
2. Apply a filter — stage, outcome, and the mine/owned toggles. Results must match what they did before.
3. Open a case from the list. It must open normally.

There is no new user-visible behaviour to look for. **The success criterion is that nothing changed**, and that the list feels at least as fast.

- [ ] **Step 5: Rollback if anything looks wrong**

`git revert` the merge commit and push. There is no schema change and no data migration, so the revert is complete and immediate.

---

## Follow-ups deliberately excluded

1. **SQL-side filtering and pagination** for `listCases` / `listCustomers` — the change that reaches ~100–190 users. Rewrites the riskiest code in the system; needs its own spec.
2. **Connection-pool tuning** — `postgres(url, { prepare: false })` sets no `max`, `idle_timeout`, or `connect_timeout`.
3. **Region co-location** — compute in Mumbai, database in Tokyo, ~90 ms per round trip.
4. **The real-SQL integration test** deferred from the handover-notes work, which would let tests catch repository defects that source-parsing guards cannot.
