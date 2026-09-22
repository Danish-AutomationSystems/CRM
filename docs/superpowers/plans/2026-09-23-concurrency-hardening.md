# Concurrency Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Serve 20 concurrent dashboard loads with zero failures and p95 under 2s, by removing duplicate database work and the second network authentication per request.

**Architecture:** A request-scoped memoizing wrapper around the existing repository singletons means each distinct read runs once per request instead of up to five times. Services move from module-scope to per-request construction so they receive that wrapper. Separately, middleware forwards the already-validated user identity to the route, removing a second `supabase.auth.getUser()` network call.

**Tech Stack:** TypeScript, Next.js 15.5 (App Router, middleware), postgres.js, Supabase, Vitest.

## Global Constraints

- **Zero behaviour change.** This is a performance change. All 760 existing tests must stay green.
- **TDD is mandatory.** Write the test, run it, watch it fail for the right reason, then implement. Never write production code first.
- Never cache `lockCase`, `lockCustomerName` (they are `SELECT … FOR UPDATE`), `nextCaseId`, `nextCustomerId`, `nextContactId` (they increment counters), or `withTransaction`. Caching any of these corrupts data. `withTransaction` hands its callback a repository bound to the transaction handle, so reads inside a transaction bypass the wrapper entirely — that must stay true.
- A method not on a read allow-list is treated as a write: it clears the cache. Fail-safe by default.
- Cache the returned **promise**, not the resolved value, so concurrent identical calls in a `Promise.all` share one query.
- Evict a cache entry if its promise rejects, so a retry re-queries.
- Do not add Redis, cross-request caching, or pagination.
- Run `npx tsc --noEmit -p tsconfig.json` before every commit.

---

### Task 1: Request-scoped memoizing repository wrapper

**Files:**
- Create: `src/server/db/memoize-repository.ts`
- Create: `src/server/db/memoize-repository.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `memoizeRepository<T extends object>(repo: T, readMethods: readonly string[]): T`

- [ ] **Step 1: Write the failing tests**

```typescript
import { describe, expect, it } from 'vitest';

import { memoizeRepository } from './memoize-repository';

function makeRepo() {
  const calls: string[] = [];
  let users = ['a'];
  return {
    calls,
    async listUsers() {
      calls.push('listUsers');
      return [...users];
    },
    async getCustomer(id: string) {
      calls.push(`getCustomer:${id}`);
      return { id };
    },
    async addUser(name: string) {
      calls.push(`addUser:${name}`);
      users = [...users, name];
    },
    async boom() {
      calls.push('boom');
      throw new Error('nope');
    }
  };
}

const READS = ['listUsers', 'getCustomer', 'boom'] as const;

describe('memoizeRepository', () => {
  it('runs an identical read once per request', async () => {
    const repo = makeRepo();
    const memo = memoizeRepository(repo, READS);

    await memo.listUsers();
    await memo.listUsers();

    expect(repo.calls.filter((c) => c === 'listUsers')).toHaveLength(1);
  });

  it('shares one query between concurrent identical reads', async () => {
    const repo = makeRepo();
    const memo = memoizeRepository(repo, READS);

    await Promise.all([memo.listUsers(), memo.listUsers(), memo.listUsers()]);

    expect(repo.calls.filter((c) => c === 'listUsers')).toHaveLength(1);
  });

  it('treats different arguments as different reads', async () => {
    const repo = makeRepo();
    const memo = memoizeRepository(repo, READS);

    await memo.getCustomer('CUST-1');
    await memo.getCustomer('CUST-2');
    await memo.getCustomer('CUST-1');

    expect(repo.calls).toEqual(['getCustomer:CUST-1', 'getCustomer:CUST-2']);
  });

  it('clears the cache on a write so later reads see it', async () => {
    const repo = makeRepo();
    const memo = memoizeRepository(repo, READS);

    const before = await memo.listUsers();
    await memo.addUser('b');
    const after = await memo.listUsers();

    expect(before).toEqual(['a']);
    expect(after).toEqual(['a', 'b']);
    expect(repo.calls.filter((c) => c === 'listUsers')).toHaveLength(2);
  });

  it('does not share cached data between two wrappers', async () => {
    const repo = makeRepo();
    const first = memoizeRepository(repo, READS);
    const second = memoizeRepository(repo, READS);

    await first.listUsers();
    await second.listUsers();

    expect(repo.calls.filter((c) => c === 'listUsers')).toHaveLength(2);
  });

  it('re-runs a read whose previous attempt rejected', async () => {
    const repo = makeRepo();
    const memo = memoizeRepository(repo, READS);

    await expect(memo.boom()).rejects.toThrow('nope');
    await expect(memo.boom()).rejects.toThrow('nope');

    expect(repo.calls.filter((c) => c === 'boom')).toHaveLength(2);
  });

  it('never caches a transaction, and clears the cache around it', async () => {
    const repo = Object.assign(makeRepo(), {
      async withTransaction<T>(fn: () => Promise<T>): Promise<T> {
        repo.calls.push('withTransaction');
        return fn();
      }
    });
    const memo = memoizeRepository(repo, READS);

    await memo.listUsers();
    await memo.withTransaction(async () => 'done');
    await memo.withTransaction(async () => 'done');
    await memo.listUsers();

    expect(repo.calls.filter((c) => c === 'withTransaction')).toHaveLength(2);
    expect(repo.calls.filter((c) => c === 'listUsers')).toHaveLength(2);
  });

  it('passes through non-function properties untouched', () => {
    const repo = Object.assign(makeRepo(), { label: 'cases' });
    const memo = memoizeRepository(repo, READS);

    expect(memo.label).toBe('cases');
  });
});
```

- [ ] **Step 2: Run the tests and watch them fail**

Run: `npx vitest run src/server/db/memoize-repository.test.ts`
Expected: FAIL — `Cannot find module './memoize-repository'`.

- [ ] **Step 3: Implement the wrapper**

```typescript
/**
 * Serves each distinct read once for the life of one request.
 *
 * Cases and dashboards call `listUsers`/`listHandlers` up to five times per
 * request through different service layers; without this each of those is a
 * separate connection, and a handful of concurrent requests exhaust the pool.
 *
 * A method absent from `readMethods` is assumed to be a write and clears the
 * cache, so adding one later cannot silently serve stale data.
 */
export function memoizeRepository<T extends object>(repo: T, readMethods: readonly string[]): T {
  const cache = new Map<string, Promise<unknown>>();
  const reads = new Set<string>(readMethods);

  function keyFor(method: string, args: unknown[]): string | null {
    try {
      return `${method}:${JSON.stringify(args)}`;
    } catch {
      return null; // unserialisable argument - safer not to cache at all
    }
  }

  return new Proxy(repo, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (typeof value !== 'function' || typeof property !== 'string') return value;

      if (!reads.has(property)) {
        return (...args: unknown[]) => {
          cache.clear();
          const result = value.apply(target, args);
          return result instanceof Promise ? result.finally(() => cache.clear()) : result;
        };
      }

      return (...args: unknown[]) => {
        const key = keyFor(property, args);
        if (key === null) return value.apply(target, args);

        const hit = cache.get(key);
        if (hit) return hit;

        const result = Promise.resolve(value.apply(target, args));
        cache.set(key, result);
        return result.catch((error: unknown) => {
          cache.delete(key);
          throw error;
        });
      };
    }
  }) as T;
}
```

- [ ] **Step 4: Run the tests and watch them pass**

Run: `npx vitest run src/server/db/memoize-repository.test.ts`
Expected: PASS, 8 tests.

- [ ] **Step 5: Type check and commit**

```bash
npx tsc --noEmit -p tsconfig.json
git add src/server/db/memoize-repository.ts src/server/db/memoize-repository.test.ts
git commit -m "feat: request-scoped memoizing repository wrapper"
```

---

### Task 2: Read allow-lists and per-request service construction

**Files:**
- Create: `src/server/db/repository-reads.ts`
- Create: `src/server/db/repository-reads.test.ts`
- Modify: `src/server/dashboard/rpc.ts`
- Modify: `src/server/customers/rpc.ts`
- Modify: `src/server/cases/rpc.ts`

**Interfaces:**
- Consumes: `memoizeRepository` from Task 1.
- Produces: `CASE_READ_METHODS`, `CUSTOMER_READ_METHODS` (both `readonly string[]`).

- [ ] **Step 1: Write the failing test for the allow-lists**

The risk this guards: someone adds a write to a repository and it silently lands on a read list, or a lock/counter method gets listed and starts serving cached rows.

```typescript
import { describe, expect, it } from 'vitest';

import { CASE_READ_METHODS, CUSTOMER_READ_METHODS } from './repository-reads';

const MUST_NEVER_BE_CACHED = [
  'withTransaction',
  'lockCase',
  'lockCustomerName',
  'nextCaseId',
  'nextCustomerId',
  'nextContactId',
  'createCase',
  'updateCase',
  'createCustomer',
  'updateCustomer',
  'deleteCustomer',
  'addHandler',
  'removeHandler',
  'removeDirectHandlers',
  'logActivity',
  'createContact',
  'updateContact',
  'deleteContact',
  'createAttachments',
  'moveCustomerToRecycleBin'
];

describe('repository read allow-lists', () => {
  it('never lists a write, lock or counter method', () => {
    for (const forbidden of MUST_NEVER_BE_CACHED) {
      expect(CASE_READ_METHODS).not.toContain(forbidden);
      expect(CUSTOMER_READ_METHODS).not.toContain(forbidden);
    }
  });

  it('lists the reads that the dashboard path repeats', () => {
    for (const method of ['listUsers', 'listHandlers', 'listSettings', 'listCases', 'getCustomersByIds']) {
      expect(CASE_READ_METHODS).toContain(method);
    }
    for (const method of ['listUsers', 'listHandlers', 'listSettings', 'listCustomers']) {
      expect(CUSTOMER_READ_METHODS).toContain(method);
    }
  });

  it('contains no duplicates', () => {
    expect(new Set(CASE_READ_METHODS).size).toBe(CASE_READ_METHODS.length);
    expect(new Set(CUSTOMER_READ_METHODS).size).toBe(CUSTOMER_READ_METHODS.length);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run src/server/db/repository-reads.test.ts`
Expected: FAIL — `Cannot find module './repository-reads'`.

- [ ] **Step 3: Write the allow-lists**

```typescript
/**
 * Pure reads, safe to serve once per request.
 *
 * Deliberately excluded and never to be added: `lockCase`/`lockCustomerName`
 * (SELECT ... FOR UPDATE, whose whole purpose is to hit the database), and
 * `nextCaseId`/`nextCustomerId`/`nextContactId` (counter increments).
 */
export const CASE_READ_METHODS = [
  'findCustomerByName',
  'getCase',
  'getCustomer',
  'getCustomersByIds',
  'latestHandover',
  'latestQuotedValueByCase',
  'listActivity',
  'listActivityByEntity',
  'listAttachmentsByCase',
  'listCases',
  'listHandlers',
  'listQuotesByCase',
  'listSettings',
  'listUsers'
] as const satisfies readonly string[];

export const CUSTOMER_READ_METHODS = [
  'countContactsByCustomer',
  'findCustomerByName',
  'getContact',
  'getCustomer',
  'getSetting',
  'hasCases',
  'hasQuotations',
  'listCasesByCustomer',
  'listContactsByCustomer',
  'listCustomers',
  'listHandlers',
  'listQuotesByCustomer',
  'listSettings',
  'listUsers'
] as const satisfies readonly string[];
```

- [ ] **Step 4: Run it and watch it pass**

Run: `npx vitest run src/server/db/repository-reads.test.ts`
Expected: PASS, 3 tests.

- [ ] **Step 5: Wire dashboard RPC to per-request services**

Replace the module-scope `const service = ...` in `src/server/dashboard/rpc.ts` with a factory. The dashboard service, the customer service and the case service must share the **same** memoized repository instances, otherwise their reads do not deduplicate against each other.

```typescript
import { caseRepository } from '../cases/repository';
import { createCaseService } from '../cases/service';
import { customerRepository } from '../customers/repository';
import { createCustomerService } from '../customers/service';
import { memoizeRepository } from '../db/memoize-repository';
import { CASE_READ_METHODS, CUSTOMER_READ_METHODS } from '../db/repository-reads';
import { registerRpc } from '../rpc/registry';
import { createDashboardService } from './service';

// Built per request: the memoized repositories must not outlive one request,
// and the three services must share them to deduplicate against each other.
function dashboardService() {
  const cases = memoizeRepository(caseRepository, CASE_READ_METHODS);
  const customers = memoizeRepository(customerRepository, CUSTOMER_READ_METHODS);
  return createDashboardService(cases, {
    customerService: createCustomerService(customers),
    caseService: createCaseService(cases)
  });
}

registerRpc('api_bootstrap', ({ context }) => dashboardService().bootstrap(context));
registerRpc('api_workspace', ({ args, context }) => dashboardService().workspace(context, args[0] ?? {}));
registerRpc('api_dashboard', ({ args, context }) => dashboardService().dashboard(context, args[0]));
```

- [ ] **Step 6: Wire customers and cases RPC the same way**

In `src/server/customers/rpc.ts`, replace the module-scope service with a per-call factory using `memoizeRepository(customerRepository, CUSTOMER_READ_METHODS)`. In `src/server/cases/rpc.ts`, do the same with `memoizeRepository(caseRepository, CASE_READ_METHODS)`, preserving the existing Drive dependency object exactly as it is currently passed to `createCaseService`.

Leave `quotes/rpc.ts` and `admin/rpc.ts` unchanged — they are not on the measured hot path, and changing them adds risk without evidence of benefit.

- [ ] **Step 7: Run the full suite**

Run: `npx vitest run`
Expected: PASS, 760 tests. Any failure here means behaviour changed — fix the code, never the test.

- [ ] **Step 8: Type check and commit**

```bash
npx tsc --noEmit -p tsconfig.json
git add src/server/db/repository-reads.ts src/server/db/repository-reads.test.ts src/server/dashboard/rpc.ts src/server/customers/rpc.ts src/server/cases/rpc.ts
git commit -m "perf: build request-scoped memoized repositories per RPC call"
```

---

### Task 3: One authentication per request

**Files:**
- Modify: `src/middleware.ts`
- Modify: `src/server/auth/context.ts`
- Create: `src/server/auth/forwarded-identity.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: the request header contract `x-crm-user-email`.

Verified beforehand in production: middleware can forward request headers to the route, and `headers.set()` overwrites a client-supplied header of the same name, so the value cannot be spoofed.

- [ ] **Step 1: Write the failing tests**

```typescript
import { describe, expect, it } from 'vitest';

import { getRequestContext } from './context';

const USER_ROW = {
  email: 'danish@automationsystems.org',
  name: 'Danish',
  role: 'L4',
  allowed_tags: ['*'],
  active: true
};

describe('forwarded identity', () => {
  it('uses the forwarded header without a network auth call', async () => {
    let networkCalls = 0;
    const request = new Request('https://crm.test/api/rpc', {
      headers: { 'x-crm-user-email': 'danish@automationsystems.org' }
    });

    const context = await getRequestContext(request, {
      getAuthenticatedEmail: async () => {
        networkCalls += 1;
        return 'danish@automationsystems.org';
      },
      lookupUser: async () => USER_ROW
    });

    expect(context.email).toBe('danish@automationsystems.org');
    expect(networkCalls).toBe(0);
  });

  it('falls back to the network call when the header is absent', async () => {
    let networkCalls = 0;
    const request = new Request('https://crm.test/api/rpc');

    const context = await getRequestContext(request, {
      getAuthenticatedEmail: async () => {
        networkCalls += 1;
        return 'danish@automationsystems.org';
      },
      lookupUser: async () => USER_ROW
    });

    expect(context.email).toBe('danish@automationsystems.org');
    expect(networkCalls).toBe(1);
  });

  it('rejects a blank forwarded header rather than trusting it', async () => {
    const request = new Request('https://crm.test/api/rpc', {
      headers: { 'x-crm-user-email': '   ' }
    });

    await expect(
      getRequestContext(request, {
        getAuthenticatedEmail: async () => null,
        lookupUser: async () => USER_ROW
      })
    ).rejects.toThrow('Sign in to AS CRM.');
  });
});
```

- [ ] **Step 2: Run them and watch the first fail**

Run: `npx vitest run src/server/auth/forwarded-identity.test.ts`
Expected: the first test FAILS with `expected 1 to be 0` — the header is currently ignored, so the network call still happens. The other two should already pass; that is expected and fine.

- [ ] **Step 3: Read the forwarded header in `getRequestContext`**

In `src/server/auth/context.ts`, replace the body of `getRequestContext` with:

```typescript
export async function getRequestContext(
  request: Request,
  options: RequestContextOptions = {}
): Promise<CrmContext> {
  const getAuthenticatedEmail = options.getAuthenticatedEmail ?? getAuthenticatedEmailFromRequest;

  // Middleware has already validated the session and overwrites this header on
  // every request, so a client cannot supply it. Trusting it here removes a
  // second network round-trip to the auth service per request.
  const forwarded = request.headers.get('x-crm-user-email')?.trim();
  const email = forwarded || (await getAuthenticatedEmail(request));

  if (!email) {
    throw new Error('Sign in to AS CRM.');
  }

  return requireActiveCrmUser(email, options.lookupUser);
}
```

- [ ] **Step 4: Run them and watch all three pass**

Run: `npx vitest run src/server/auth/forwarded-identity.test.ts`
Expected: PASS, 3 tests.

- [ ] **Step 5: Set the header in middleware**

`getUser()` must run before the headers are built, and the cookies Supabase sets during a token refresh must survive onto the returned response. Replace the body of `middleware` in `src/middleware.ts` with:

```typescript
export async function middleware(request: NextRequest) {
  const cookieCarrier = NextResponse.next({ request });
  const supabase = createSupabaseMiddlewareClient(request, cookieCarrier);
  const {
    data: { user }
  } = await supabase.auth.getUser();

  if (!user && isProtectedPath(request.nextUrl.pathname)) {
    const loginUrl = new URL('/login', request.url);
    loginUrl.searchParams.set('next', request.nextUrl.pathname);
    return NextResponse.redirect(loginUrl);
  }

  // Always overwrite: a client may send this header, and it must never be trusted.
  const forwarded = new Headers(request.headers);
  forwarded.delete('x-crm-user-email');
  if (user?.email) forwarded.set('x-crm-user-email', user.email);

  const response = NextResponse.next({ request: { headers: forwarded } });
  // Carry over any refreshed auth cookies Supabase wrote while validating.
  cookieCarrier.cookies.getAll().forEach((cookie) => response.cookies.set(cookie));
  return response;
}
```

- [ ] **Step 6: Run the full suite**

Run: `npx vitest run`
Expected: PASS, 763 tests (760 existing plus the 3 new).

- [ ] **Step 7: Type check and commit**

```bash
npx tsc --noEmit -p tsconfig.json
git add src/middleware.ts src/server/auth/context.ts src/server/auth/forwarded-identity.test.ts
git commit -m "perf: authenticate once per request via forwarded identity"
```

---

### Task 4: Measure, and keep going until 20 concurrent users pass

**Files:**
- Create: `scripts/_seed_cases.js` (temporary, removed in Step 5)
- Modify: none

**Interfaces:**
- Consumes: the deployed result of Tasks 1–3.
- Produces: the measurements that decide whether the work is done.

- [ ] **Step 1: Deploy and re-measure the baseline load**

```bash
git push
```

Wait for the deployment, then ask the human partner to run (the sandbox blocks the agent from driving concurrent load at a remote host):

```
node scripts/_cap.js 10,15,20
```

Record the result. **Target: 20 users, zero failures, p95 under 2s.** If it misses, do not proceed to Step 2 — diagnose and fix first, then re-measure. Diagnosis must be evidence-based: count the queries actually issued and watch `pg_stat_activity`, rather than guessing.

- [ ] **Step 2: Seed several hundred cases and re-measure**

Write `scripts/_seed_cases.js` inserting cases with `case_id` values prefixed `LOADTEST-`, each referencing an existing `customer_id`, using a `stage` value already present in `public.cases` so the CHECK constraint is satisfied. Seed to ~500 cases, then have the human partner re-run the same command. Record the result.

- [ ] **Step 3: Seed to a few thousand and re-measure**

Extend the seed to ~3000 cases — beyond the projected two-to-three year volume — and re-run. Record the result. This answers the "any number of cases" question with a measurement rather than an opinion.

- [ ] **Step 4: Write the results into the capacity assessment**

Update `docs/reports/2026-09-23-capacity-assessment.md`: replace the estimated capacity table with measured figures, and state plainly what the ceiling now is and what it is limited by.

- [ ] **Step 5: Remove the temporary scaffolding**

```bash
rm -rf src/app/api/cap scripts/_cap.js scripts/_seed_cases.js
```

Delete every seeded row (`delete from public.cases where case_id like 'LOADTEST-%'`) and confirm the count returns to its pre-test value. `/api/cap` is unauthenticated and must not outlive the exercise.

```bash
npx tsc --noEmit -p tsconfig.json
npx vitest run
git add -A src/app/api scripts docs/reports
git commit -m "chore: record measured capacity and remove load-test scaffolding"
git push
```
