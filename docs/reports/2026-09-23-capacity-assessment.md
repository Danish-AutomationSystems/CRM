# AS CRM — Capacity Assessment and Scaling Plan

**Date:** 2026-09-23
**Author:** Claude (Opus 5), for Danish
**Status:** Assessment complete. Scaling work not started.

---

## 1. Honest summary

**If you launch today for 25–30 concurrent users, I expect it to fall over.** I would not do it.

For the 2–4 people using it now, it is in much better shape than it was yesterday — one real bug was found and fixed, and the worst failure mode (a five-minute silent hang) can no longer happen.

The uncomfortable part: **I have no valid measurement of how many concurrent users it actually supports.** My one attempt to measure it took production down, and the test was designed wrongly on top of that. So the numbers below separate what is *measured* from what is *estimated*. Do not let anyone, including me, present the estimates as facts.

---

## 2. What was wrong, and what was fixed

### The bug (fixed, verified)

`computeDash` issued **one database query per case** instead of one batched query for all of them. Because `bootstrap` awaits `computeDash`, every dashboard load paid this cost, and a second load on the same warm server instance exhausted the connection pool and hung outright.

That is the "Access pending" screen you and your manager kept hitting. It is also exactly why *first reload works, the next one fails* — your own observation, which is what cracked it.

**Fix:** commit `fca769c` — use the batched `getCustomersByIds` that already existed in the repository.

| Measurement | Before | After |
|---|---|---|
| `bootstrap` | 1945 ms | **666 ms** |
| `bootstrap`, second call same instance | **stalled, never returned** | **653 ms** |
| 4 consecutive `workspace` calls | 1st ok, rest stalled | **1468 / 1441 / 1443 / 1580 ms** |
| `/api/rpc` 504 timeouts | recurring | **zero since** |

### Safety net added

Each request stage now has a deadline (sign-in 15s, data 25s). Previously a stalled request sat for the full 300-second platform limit and the browser gave up first, showing a generic message with no clue what failed. Now it fails fast with a legible error. **This does not make anything faster — it makes failure honest.**

---

## 3. What is still slow, and why

One dashboard load issues roughly **20 database queries, of which about 12 are exact duplicates**:

| Query | Times per single request |
|---|---|
| `listUsers` | 5× |
| `listHandlers` | 4× |
| `listSettings` | 2× |
| `listCases` | 2× |
| `getCustomersByIds` | 2× |
| activity / customers / contacts / quotes | 1× each |

This happens because `bootstrap`, `computeDash`, `recentActivity`, `myCustomers` and `listCases` each independently fetch what they need, with nothing shared between them inside a request.

On top of that, **every request authenticates twice** over the network: the middleware calls Supabase `getUser()`, then the route handler calls it again. The sign-in stage measured **2248–2950 ms** across sampled requests.

Neither of these is a database capacity problem. The database is idle and tiny. It is the application asking for the same things repeatedly.

---

## 4. Capacity: what I know vs. what I am guessing

### Measured facts

- Database is very small: **12 cases, 10 customers, 99 activity rows, 4 users**. Data volume is not a constraint and will not be at your projected "low thousands".
- Postgres allows **60 connections** total (free tier).
- The connection pool is capped at **10 per server instance** (library default).
- A single `workspace` call needs roughly **5 concurrent connections** at its peak.
- Driving 5, 10 and 25 concurrent workspace calls **into one server instance** produced 1/5, 0/10 and 0/25 successes. During that run only 6 connections ever opened, with 5 stuck waiting to hand results back to a client that had stopped reading.

### Why that load test does not answer your question

It forced every request through **one** server instance sharing **one** pool of 10. Real traffic does not work that way: 25 users means 25 HTTP requests that Vercel spreads across **many** instances, each with its own pool. The test was a worst case, not a realistic one, and it overstates the problem.

It is still a meaningful warning, because Vercel's Fluid Compute deliberately packs several concurrent requests onto one instance. When that happens, you get the worst case for real.

### Honest estimate (NOT measured)

| Concurrent active users | My expectation | Confidence |
|---|---|---|
| 1–5 | Works. This is today's real usage. | High — observed |
| 6–10 | Probably works, degrading. Some slow loads. | Low — untested |
| 10–25 | Expect intermittent stalls and timeouts. | Low — untested |
| 25–30 | **Do not launch.** | — |

"Concurrent" means *loading a page at the same moment*, not *logged in*. 30 people with the CRM open, clicking occasionally, is far lighter than 30 simultaneous dashboard loads. Your real-world ceiling is likely better than the pessimistic reading — but **it is unverified, and unverified is not a launch criterion.**

The hard ceiling is arithmetic: 60 connections ÷ 10 per instance = **6 busy instances**, after which new work waits.

---

## 5. Risks that are not about speed

These matter more than performance for a system a business depends on.

1. **Backups — verify this before launch.** Confirm exactly what your Supabase plan retains and, more importantly, *restore from a backup once as a drill*. An untested backup is not a backup. This is the single biggest risk on this list: slow software annoys people, lost customer data ends relationships.
2. **Vercel Hobby prohibits commercial use** under Vercel's terms. You are running a business CRM on it. A licensing decision, not a technical one — but make it knowingly.
3. **No staging environment.** Every change is currently tested in production. This is also how I took the site down while load testing.
4. **No monitoring or alerting.** Yesterday's outage was discovered because you noticed. There is nothing watching error rates or latency.
5. **Free-tier Supabase pauses idle projects.** Daily use avoids this, but a quiet holiday week could trigger it.

---

## 6. Plan to reach 30 users

Four pieces, each independently shippable and verifiable, in this order.

| # | Sub-project | Purpose |
|---|---|---|
| **1** | **Staging environment** — second Supabase project + Vercel preview, seeded with realistic data | Nothing can be verified without it. Also ends load testing against production. |
| **2** | **Request-scoped deduplication** — each table fetched at most once per request | ~20 queries → ~8. Biggest win, lowest risk, no behaviour change. |
| **3** | **Authentication cost** — stop calling Supabase Auth twice per request | Removes the largest latency chunk (2.2–2.9 s). Touches security, so it gets its own spec and careful review. |
| **4** | **Load verification + regression guard** — prove 30 concurrent in staging, then keep it proven | Converts "we think it's fast" into "we know, and CI tells us when it stops being true." |

**Deliberately excluded: Redis and any caching layer.**

The ~12 duplicate queries are a *defect*, not a missing optimization. Caching them would pay to make waste fast instead of removing the waste. `settings/live.ts` carries an explicit warning against process-wide caching — someone previously shipped one, admin settings silently stopped applying, and it was removed. That scar is evidence, and overruling it needs a better reason than "might be faster."

Caching also trades correctness for speed, and invalidating a cache across independent serverless instances is genuinely hard without a shared store. Fix the duplication, remove the double authentication, **measure**, and only then consider caching. My expectation is that it will not be needed at this size.

**Target after #2 and #3:** dashboard load well under 2 s, no stalls at 30 concurrent users — the bar you set.

---

## 7. What I would do if launching mattered this week

1. Verify backups and perform one restore drill. *(Non-negotiable.)*
2. Ship #1 and #2. Together they are low-risk and remove most of the waste.
3. Measure honestly in staging at 30 concurrent.
4. Launch to a **subset** — 8–10 users — and watch before widening.
5. Ship #3, re-measure, then open to everyone.

Rolling out to a small group first is not timidity. It is how you find the failure you did not predict while it is still cheap.

---

## Appendix — evidence trail

- Root cause and fix: commit `fca769c`
- Stage deadlines: commit `d593996`
- Diagnosis method: temporary instrumented endpoints bisecting the call path, plus live `pg_stat_activity` observation. All diagnostic endpoints have been removed.
- Correction on record: an earlier change of mine (`max: 1` on the connection pool) made the outage worse, taking it from intermittent to total, and was reverted in `fddc381`. Transaction callbacks in this codebase can require a second connection while holding the first, so a one-connection pool deadlocks.
