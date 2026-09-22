# Concurrency hardening — design spec

Date: 2026-09-23
Status: Approved (owner approved conditional on verification; verification completed, see below)

## Problem

Measured against production with the `/api/cap` probe (one request = one dashboard's data work,
fired as separate external HTTP requests so the platform spreads them across instances):

```
 2 users:  2/2  ok   p50 4554ms
10 users:  7/10 ok   p50 3115ms   3 failed (no response in 45s)
15 users:  5/15 ok   p50 3026ms  10 failed
20 users: 16/20 ok   p50 3151ms   4 failed
```

The system fails at **10 concurrent dashboard loads**, and successful requests take ~3.1s against a
2s target. These figures **exclude sign-in**, which adds a further 2.2–2.9s (measured) and one more
connection per request, so real usage is worse.

Mechanism: each request needs roughly **5 concurrent database connections** at its peak; the pool
holds **10 per instance**; Vercel Fluid Compute packs several concurrent requests onto one instance.
Three or more requests sharing an instance exhaust the pool, and the losers wait until killed.

The database is not the constraint — a 20-way raw query burst completes in ~1.5s, and the dataset is
12 cases, 10 customers, 99 activity rows.

## Verified facts

Each of these was checked directly, not assumed. Several corrected an earlier draft of this design.

1. **One `api_workspace` issues ~20 queries, ~12 of them exact duplicates.** By repository:
   - `caseRepository`: `listUsers` ×4, `listHandlers` ×3, `listCases` ×2, `getCustomersByIds` ×2, `listSettings` ×1, `listActivity` ×1
   - `customerRepository`: `listUsers` ×1, `listHandlers` ×1, `listSettings` ×1, `listCustomers` ×1, `countContactsByCustomer` ×1
2. **The duplicated SQL is byte-identical across repositories**, but the mapped return types differ
   (`CaseUserRow` vs `CustomerUserRow`). Sharing one cache between repositories would mean handing
   cases-typed rows to customers code. **Cross-repository deduplication is therefore out of scope.**
3. **All five RPC modules construct their services at module scope** from singleton repositories
   (`admin`, `cases`, `customers`, `dashboard`, `quotes`). Per-request construction is a uniform,
   contained change.
4. **Middleware can forward a header to the route handler, and `headers.set()` overwrites a
   client-supplied value of the same name.** Verified empirically in production: a request sending
   `x-mw-probe: SPOOFED` still arrived at the route as `middleware-ran`, while an unrelated client
   header passed through untouched — proving the overwrite does real work.

## Design

### Change 1 — Request-scoped repository memoization

`memoizeRepository(repo, readMethods)` returns a wrapper where each listed read method, called with
the same arguments, queries the database **once per request**.

- **Explicit allow-list of read methods per repository.** Not "anything that looks like a read" —
  a method is cached only if named.
- **Any method not on the allow-list clears the cache and passes through.** Fail-safe default: an
  unrecognised method is assumed to be a write. Adding a new write later cannot silently serve stale
  data.
- **Cache key:** method name plus a stable serialization of its arguments.
- **Lifetime:** one wrapper per request, created in the RPC handler. Two requests never share one.

Services move from module-scope construction to per-request construction, receiving the wrapper.
Service logic is unchanged — they already take the repository as a constructor argument.

Expected effect: ~20 queries → ~11, and peak concurrent connections per request from ~5 to ~2–3.

### Change 2 — One authentication per request

Middleware already validates the session; the route then validates it again over the network.

- Middleware sets `x-crm-user-email` on the forwarded request from the validated user,
  **unconditionally overwriting** any client-supplied value.
- `getRequestContext` reads that header instead of making a second `supabase.auth.getUser()` call.
- **If the header is absent, it falls back to the existing network call.** A request that somehow
  bypassed middleware still authenticates correctly rather than failing open or failing shut.
- The `public.users` lookup (role, tags, active) still happens — it is one cheap query, and is
  memoized by Change 1.

Removes one network round-trip per request.

## Edge cases

| Case | Required behaviour |
|---|---|
| Write then read in the same request | The write clears the cache; the following read re-queries and sees the write. |
| Two concurrent requests | Separate wrappers; no data crosses between them. |
| Work inside `withTransaction` | Repositories inside a transaction use the transaction handle, not the memoized wrapper, so transactional reads are never served from cache. |
| Auth header absent | Falls back to the network `getUser()` call; behaviour identical to today. |
| Auth header supplied by a client | Overwritten by middleware before the route sees it (verified). |
| Unauthenticated request | Unchanged: redirected to `/login`. |
| A repository gains a new write method | Not on the read allow-list, so it clears the cache by default. |

## Testing

Test-first throughout; every test must be watched failing before its implementation exists.

**Memoization unit tests** (against a counting fake repository, asserting real call counts):
- the same read twice → underlying repository called once
- the same read with different arguments → called twice
- a write between two identical reads → called twice, and the second reflects the write
- a method absent from the allow-list → passes through and clears the cache
- two separate wrappers → no shared state

**Auth tests:**
- route uses the forwarded header when present, making no network auth call
- route falls back to the network call when the header is absent
- middleware overwrites a client-supplied `x-crm-user-email`
- unauthenticated request still redirects to `/login`

**Integration:**
- one `api_workspace` issues a measurably reduced number of queries (asserted by counting through a
  instrumented repository, not by inspection)
- the full existing suite (760 tests) stays green — this is a performance change with **zero**
  behaviour change

## Success criteria

Not "it feels faster". All of:

1. **20 concurrent requests: zero failures, p95 under 2s**, measured with `/api/cap`.
2. The same, re-measured after seeding the database to several hundred and then a few thousand cases
   — answering the "any number of cases" question.
3. All existing tests green.

If (1) is not met after both changes, we continue — the owner's instruction is explicit that we do
not stop until 20 concurrent users work.

## Non-goals

- **Redis or any cross-request cache.** The duplication is a defect; removing it is the fix. A cache
  would make waste fast and reintroduce the intermittent staleness `settings/live.ts` explicitly
  warns against.
- **Cross-repository deduplication** — ruled out above on type-safety grounds.
- **Pagination / read-model rework.** Data is projected to stay in the low thousands.
- **Business rule changes.** Handler/assignee and location work is separate and follows this.
