# AS CRM — Overall Latency & Performance Optimization Design

**Date:** 2026-07-30
**Scope:** Multi-layer latency optimization across database indexes, server query projection, payload compression, and client SWR caching.
**Goal:** Deliver 0ms perceived tab switching and 5x faster query speeds across the CRM without altering business logic, security rules, or feature contracts, and with zero race conditions.

---

## Constraints & Parity Principles

1. **Zero business logic changes.** All RPC handlers, access control rules, role hierarchies, and data transformations must function identically.
2. **Zero race conditions.** Mutation write operations bypass caching, run sequentially, and immediately invalidate related read caches.
3. **TypeScript contract preservation.** All query data structures (`CustomerRecord`, `CaseRecord`, `DashboardData`) keep their exact type definitions.
4. **TDD Required.** All cache invalidation rules and query projection changes must have failing tests written first before implementation.
5. **Auditable Database Migration.** All database index additions must be declared in a new Supabase migration file (`supabase/migrations/0003_performance_indexes.sql`) using non-blocking B-tree/GIN definitions (`IF NOT EXISTS`).

---

## Architecture & Technical Strategy

### 1. Database Indexing (`supabase/migrations/0003_performance_indexes.sql`)

Add targeted, non-locking indexes on high-frequency query columns:

```sql
-- Customers Table
create index if not exists customers_status_created_idx on public.customers(status, created_at desc);
create index if not exists customers_type_priority_idx on public.customers(type, priority) where status = 'Active';

-- Cases Table
create index if not exists cases_customer_stage_idx on public.cases(customer_id, stage);
create index if not exists cases_owner_outcome_idx on public.cases(owner, outcome);

-- Actions Table
create index if not exists actions_case_due_idx on public.actions(case_id, due_date) where status = 'Open';
create index if not exists actions_customer_status_idx on public.actions(customer_id, status);

-- Quotations Table
create index if not exists quotations_customer_created_idx on public.quotations(customer_id, created_at desc);
```

### 2. Server-Side Query Projection & Payload Compression

- Refactor `src/server/customers/repository.ts` and `src/server/cases/repository.ts` list queries to select explicit column lists rather than `SELECT *` across unused binary bytea or snapshot blobs.
- Add HTTP compression response headers (`Content-Encoding: gzip / br`) in `src/app/api/rpc/route.ts` for all JSON payloads exceeding 1KB.

### 3. Client-Side Smart SWR Caching & Mutation Invalidation

- **Stale-While-Revalidate (SWR)** in `scripts/port-legacy-index.mjs`:
  - For read RPCs (`getDashboardData`, `getCustomersGrid`, `getCases`), return memory cache immediately for 0ms tab transitions.
  - Silently fetch fresh data in the background if cache age > 30 seconds.
- **Write Invalidation**:
  - `saveCustomer`, `saveCase`, `updateContact`, `deleteCustomer`, `saveQuotation`, `purgeCust` automatically purge related read cache entries.
  - Mutation RPC calls run sequentially without caching to guarantee strict write-after-read consistency.

---

## Verification & Testing Plan

### Test-Driven Development (TDD)
1. **Cache Invalidation Tests**:
   - Add unit test in `src/client/gs.test.ts` verifying `saveCustomer` purges `getCustomersGrid` cache.
2. **Query Contract Tests**:
   - Run existing suite `src/app/crm/legacy-app.test.ts` to ensure all fields expected by `LegacyFullCrmApp` are present.
3. **Concurrency & Integration Coverage**:
   - Run `src/server/integration/concurrency.test.ts` and `src/server/integration/crm-flows.test.ts`.

### Full Automated Verification
```bash
npm run typecheck
npm run test
npm run build
```
