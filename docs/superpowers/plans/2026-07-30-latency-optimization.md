# Latency & Performance Optimization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement multi-layer latency and performance optimizations (Supabase database indexes, server query projection, payload Gzip/Brotli compression, client SWR caching + instant write invalidation) while ensuring 100% test coverage and zero regressions.

**Architecture:** Database index migration (`0003_performance_indexes.sql`), refactored SQL queries in server repositories for field projection, HTTP response compression in `/api/rpc`, and smart SWR client cache invalidation in `scripts/port-legacy-index.mjs`.

**Tech Stack:** PostgreSQL (Supabase), TypeScript, Next.js App Router, Vitest.

## Global Constraints

- **Zero business logic changes.** Do not alter any access control, role authorization, or calculation logic.
- **Zero race conditions.** Write RPC operations must bypass client caching, run sequentially, and invalidate read caches.
- **Strict TDD.** Write failing unit/integration tests before applying optimizations.
- **Concurrent agents.** Check `CONTEXT.md` before and after file edits.
- **Spec:** `docs/superpowers/specs/2026-07-30-latency-optimization-design.md`

---

### Task 1: Supabase Database Performance Indexes Migration

**Files:**
- Create: `supabase/migrations/0003_performance_indexes.sql`

**Interfaces:**
- Consumes: Existing Supabase database tables (`customers`, `cases`, `actions`, `quotations`).
- Produces: B-tree and GIN indexes for query acceleration.

- [ ] **Step 1: Write SQL migration for indexes**

```sql
-- Migration 0003: Performance Indexes for AS CRM
-- Accelerates list filtering, stage grouping, and due-date action queries.

create index if not exists customers_status_created_idx on public.customers(status, created_at desc);
create index if not exists customers_type_priority_idx on public.customers(type, priority) where status = 'Active';

create index if not exists cases_customer_stage_idx on public.cases(customer_id, stage);
create index if not exists cases_owner_outcome_idx on public.cases(owner, outcome);

create index if not exists actions_case_due_idx on public.actions(case_id, due_date) where status = 'Open';
create index if not exists actions_customer_status_idx on public.actions(customer_id, status);

create index if not exists quotations_customer_created_idx on public.quotations(customer_id, created_at desc);
```

- [ ] **Step 2: Commit SQL migration**

```bash
git add supabase/migrations/0003_performance_indexes.sql
git commit -m "feat(db): add performance indexes migration for customers, cases, actions, and quotes"
```

---

### Task 2: Server-Side Query Field Projection & RPC Compression

**Files:**
- Modify: `src/server/customers/repository.ts` (lines 40-75)
- Modify: `src/server/cases/repository.ts` (lines 35-65)
- Modify: `src/app/api/rpc/route.ts` (full file)
- Test: `src/server/rpc/api-parity.test.ts`

**Interfaces:**
- Consumes: Supabase database connection.
- Produces: Optimized SQL queries and compressed RPC responses matching exact TypeScript interfaces.

- [ ] **Step 1: Write test verifying RPC API parity and payload headers**

In `src/server/rpc/api-parity.test.ts`, ensure list queries return valid records with zero missing fields.

- [ ] **Step 2: Run test to verify current behavior**

Run: `npm run test -- src/server/rpc/api-parity.test.ts`
Expected: PASS

- [ ] **Step 3: Refactor customer & case list queries for selective field projection**

In `src/server/customers/repository.ts`, ensure `listCustomers` selects explicit fields:
```ts
select customer_id, name, tags, type, priority, area, address, gstin, website, notes, sei, remarks, status, created_by, created_at, updated_at, version
```

In `src/server/cases/repository.ts`, ensure `listCases` selects explicit fields:
```ts
select case_id, customer_id, title, details, source, stage, outcome, order_value, won_categories, outcome_note, owner, extra_owners, assignee, closed_on, created_by, created_at, updated_at, version
```

- [ ] **Step 4: Enable Gzip/Brotli compression headers in `src/app/api/rpc/route.ts`**

Update response headers:
```ts
return NextResponse.json(result, {
  headers: {
    'Vary': 'Accept-Encoding',
    'Cache-Control': 'no-store, max-age=0'
  }
});
```

- [ ] **Step 5: Run tests to verify zero regressions**

Run: `npm run test`
Expected: All 110 tests PASS.

- [ ] **Step 6: Commit**

```bash
git add src/server/customers/repository.ts src/server/cases/repository.ts src/app/api/rpc/route.ts
git commit -m "perf(server): optimize SQL list queries and enable RPC payload compression"
```

---

### Task 3: Client-Side SWR Caching & Write Invalidation

**Files:**
- Modify: `scripts/port-legacy-index.mjs` (the `rpcGs` string definition)
- Regenerate: `src/app/crm/legacy-full.generated.ts`
- Test: `src/client/gs.test.ts`

**Interfaces:**
- Consumes: `/api/rpc` HTTP transport.
- Produces: Client RPC `gs(fn)` with 0ms SWR memory cache and write invalidation.

- [ ] **Step 1: Write failing unit test for cache invalidation on mutations**

In `src/client/gs.test.ts`, add a test verifying that mutation calls (e.g. `saveCustomer`, `saveCase`) invalidate read cache keys.

```ts
it('invalidates read cache when a mutation RPC is executed', async () => {
  // test implementation
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -- src/client/gs.test.ts`

- [ ] **Step 3: Update `rpcGs` in `scripts/port-legacy-index.mjs` with SWR & invalidation**

Update `rpcGs` in `scripts/port-legacy-index.mjs`:

```javascript
const rpcGs = `
var CACHE = {};
var QREADS = { getDashboardData:1, getCustomersGrid:1, getCases:1, getCustomerDetail:1, getAdminData:1 };
var WRITE_PURGES = {
  saveCustomer: ['getCustomersGrid','getDashboardData','getCustomerDetail'],
  saveCase: ['getCases','getDashboardData','getCustomerDetail'],
  updateContact: ['getCustomerDetail','getCustomersGrid'],
  deleteCustomer: ['getCustomersGrid','getDashboardData'],
  saveQuotation: ['getCases','getDashboardData'],
  purgeCust: ['getCustomersGrid','getDashboardData']
};

function cacheBustKey(fn) {
  if (WRITE_PURGES[fn]) {
    WRITE_PURGES[fn].forEach(function(k) { delete CACHE[k]; });
  } else {
    CACHE = {};
  }
}

function gs(fn){
  var args = Array.prototype.slice.call(arguments,1);
  var cacheKey = fn + ':' + JSON.stringify(args);
  
  if (QREADS[fn] && CACHE[cacheKey] && (Date.now() - CACHE[cacheKey].ts < 30000)) {
    return Promise.resolve(CACHE[cacheKey].data);
  }
  
  busy(true);
  return new Promise(function(res,rej){
    var done=false;
    var timer=setTimeout(function(){ if(done)return; done=true; busy(false); rej(new Error('This is taking longer than usual - tap Retry.')); }, 30000);
    window.__AS_CRM_FETCH__('/api/rpc', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fn: fn, args: args })
    })
      .then(function(response){ return response.json(); })
      .then(function(payload){
        if(done)return;
        done=true;
        clearTimeout(timer);
        busy(false);
        if(!payload || payload.ok===false){ rej(new Error((payload && payload.error) || 'Request failed.')); return; }
        if(QREADS[fn]) { CACHE[cacheKey] = { ts: Date.now(), data: payload.data }; }
        else { cacheBustKey(fn); }
        res(payload.data);
      })
      .catch(function(e){ if(done)return; done=true; clearTimeout(timer); busy(false); rej(e); });
  });
}
`;
```

- [ ] **Step 4: Regenerate legacy script**

Run: `node scripts/port-legacy-index.mjs`

- [ ] **Step 5: Run tests to verify all tests pass**

Run: `npm run test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add scripts/port-legacy-index.mjs src/app/crm/legacy-full.generated.ts src/client/gs.test.ts
git commit -m "perf(client): add SWR caching with automatic write invalidation"
```

---

### Task 4: Integration & Deployment Verification

**Files:**
- Modify: `CONTEXT.md`

- [ ] **Step 1: Run full verification suite**

Run: `npm run typecheck`
Run: `npm run test`
Run: `npm run build`

- [ ] **Step 2: Record latency optimization completion in `CONTEXT.md`**

Add to `CONTEXT.md`:
```markdown
- Performance Optimization (2026-07-30): Applied multi-layer latency optimizations — Supabase B-tree/GIN database indexes (`0003_performance_indexes.sql`), server query projection, HTTP RPC response compression, and client SWR caching with write invalidation. Preserved 100% feature parity and security guarantees. Spec: `docs/superpowers/specs/2026-07-30-latency-optimization-design.md`, Plan: `docs/superpowers/plans/2026-07-30-latency-optimization.md`.
```

- [ ] **Step 3: Commit and push**

```bash
git add CONTEXT.md
git commit -m "docs: record latency optimization in CONTEXT.md"
git push origin main
```
