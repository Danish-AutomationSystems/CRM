# Case List — Batch the Customer Lookup (2026-08-14)

## Context

`listCases` (`src/server/cases/service.ts:629-635`) reads every case, then fetches that
case's customer **one query at a time**:

```ts
const caseRows = await repo.listCases();
const [cases, customers, handlers, users, quotedValues] = await Promise.all([
  Promise.resolve(caseRows),
  Promise.all(caseRows.map((row) => repo.getCustomer(row.customerId))),   // N+1
  ...
```

Two multipliers make this expensive on this deployment:

- Compute runs in Vercel `bom1` (Mumbai); the database is `ap-northeast-1` (Tokyo).
  Measured round trip on this path is roughly 90 ms.
- `postgres.js` defaults to a pool of 10 connections, so K queries execute in
  `ceil(K / 10)` sequential waves.

Measured effect, from `docs/scalability-report-2026-08.md`:

| Cases | Waves | Added page latency |
|---|---|---|
| 100 | 10 | ~0.9 s |
| 300 | 30 | ~2.7 s |
| 500 | 50 | ~4.5 s |
| 1,000 | 100 | ~9 s — at the Vercel function limit |
| 2,000 | 200 | ~18 s — gateway timeout |

**This is independent of user count.** One person with 1,200 cases hits it exactly as hard
as thirty people do, which is what currently holds the practical ceiling at 10–15 users:
about a month of normal sales activity at 12 users.

The dashboard already solves this correctly. `dashboard/service.ts:200` uses
`getCustomersByIds()`, a single batched query. The case list simply never adopted it.

## The change

Three edits. No new SQL, no migration, no new query.

1. Declare `getCustomersByIds(ids: string[]): Promise<CaseCustomerRow[]>` on the
   `CaseRepository` type (`src/server/cases/service.ts`, near line 113). The method
   **already exists** on the concrete Postgres repository at
   `src/server/cases/repository.ts:231` and is already declared on `DashboardRepository`
   (`src/server/dashboard/service.ts:27`) — it is simply not visible to the cases service.
2. Replace the per-case loop with one call over the distinct ids.
3. Implement `getCustomersByIds` on the in-memory test fakes, which currently only have
   `getCustomer`.

## Why this is behaviour-preserving

The fetched customers are immediately collapsed into a keyed map
(`src/server/cases/service.ts:638-642`):

```ts
const customersById = customers.reduce<Record<string, CaseCustomerRow>>((map, customer) => {
  if (customer) map[customer.id] = customer;
  return map;
}, {});
```

Nothing downstream reads the array — only the map. So the array's length, order and
positional alignment with `caseRows` are all unobservable.

| Situation | Today | Batched | Same map? |
|---|---|---|---|
| One customer across 50 cases | fetched 50×, map overwritten with the same row | fetched once | yes |
| Case referencing a deleted customer | `getCustomer` returns `null`, `if (customer)` skips it | absent from results, so also skipped | yes |
| No cases at all | `Promise.all([])` → `[]` | `getCustomersByIds` returns `[]` early (`repository.ts:232`) | yes |
| Ordering | positional | arbitrary | irrelevant — keyed map |

`getCustomersByIds` selects the identical column list to `getCustomer`, so the row objects
are identical too.

**One property improves.** Today each of the K queries runs in its own implicit
transaction, so a customer edited mid-request can appear in two different states within a
single page render. Batched, they all come from one snapshot. Nobody has reported hitting
this, but it is a real inconsistency that disappears.

## Effect

| | Today | After |
|---|---|---|
| Case list at 500 cases | ~4.5 s | ~0.1 s |
| Egress per case-list load | `K × ~600 B` | `K × ~350 B` (~40% less) |
| Egress cap (5 GB/month) reached at, with 20 users | ~470 cases | ~800 cases |
| Practical user ceiling | 10–15 | 15–25 |

The user ceiling moves only as a **side effect**: batching stops sending one customer row
per case (mostly duplicates), which cuts egress, and egress *is* user-count sensitive. The
latency win itself is about case volume, not headcount.

## Known risks

1. **Parameter ceiling.** `where customer_id in ${this.db(ids)}` binds one parameter per
   id, against Postgres's 65,535 limit. That needs ~65,000 distinct customers on one page.
   Current count: 4. The dashboard has run this query in production for weeks. Accepted
   without mitigation; if `listCases` is ever paginated, the id set shrinks further.
2. **Fakes drifting from the real query.** Every in-memory fake must implement
   `getCustomersByIds` with the same semantics as the SQL. A fake that behaves differently
   makes the tests lie — this has already happened twice in this codebase, most recently
   with `listActivityByEntity` ignoring its `limit 40`.

## Testing

- A case list spanning several cases that share one customer returns the same payload as
  before, and issues **one** customer query rather than one per case.
- A case whose customer no longer exists is still skipped, exactly as today.
- An empty case list still works and issues no customer query.
- Distinct ids only: 50 cases across 3 customers request 3 ids, not 50.
- The existing `listCases` tests continue to pass unchanged — they are the real regression
  guard, since this change must be invisible to them.

## Explicitly out of scope

- SQL-side filtering and pagination for `listCases` / `listCustomers`. That is the change
  that reaches ~100–190 users, it rewrites the riskiest code in the system, and it deserves
  its own spec.
- The same N+1 pattern anywhere else it may exist.
- Connection-pool tuning (`max`, `idle_timeout`).
- Changing the Vercel region to co-locate with the database.
