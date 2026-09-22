# Reusable scalability audit prompt

Hand the block below to a fresh agent pointed at any Supabase + Vercel + Node project.
It encodes the failure modes that took down the AS CRM on 2026-09-22/23, plus the
method that actually found them (measure and bisect) rather than the method that
wasted hours (plausible theories shipped one after another).

---

## The prompt

> You are auditing a production Next.js + Supabase + Vercel application for scalability
> and reliability defects. Working directory: `<PATH>`. The deployed URL is `<URL>`.
>
> ### Rules of engagement — read first
>
> 1. **Measure, do not theorize.** Every claim you make must be backed by a command you
>    ran, a file:line you read, or a number you observed. If you cannot back it, label it
>    explicitly as "unverified hypothesis". A confident wrong answer is worse than "I
>    don't know yet".
> 2. **Never load-test production.** If real users or real data exist, do not drive
>    concurrent load at the deployed system. Say so and ask for a safe target instead.
> 3. **Do not change configuration to "see if it helps".** Diagnose first. One config
>    change made on a hunch turned an intermittent outage into a total one in the
>    incident this checklist came from.
> 4. Report findings ranked by severity with a concrete failure scenario for each:
>    specific inputs or load -> specific wrong outcome. No generic advice.
>
> ### What you are hunting
>
> These are the defects that actually caused a production outage in a sibling project.
> Check each one specifically.
>
> **1. N+1 query patterns — the highest-value hunt.**
> Search for a query issued inside a loop or a `.map()` over rows. Patterns:
> `Promise.all(rows.map(r => repo.getX(r.id)))`, `for (const row of rows) { await ... }`,
> or any per-row `await` inside an iteration. These are invisible at 10 rows and fatal at
> 500 because the cost scales with row count. For each one found, state how many queries
> it issues at 10, 500 and 5000 rows, and whether a batched alternative already exists in
> the codebase.
>
> **2. Duplicate queries within a single request.**
> Trace one typical page load or API call end to end and count every database query it
> issues. Note especially the same table fetched repeatedly by different layers
> (`listUsers`, `listSettings`, reference data). Report the total and how many are exact
> duplicates. Do this by reading the call graph, then confirm by instrumentation if you
> can.
>
> **3. Connection pool sizing versus per-request demand.**
> Find the database client construction (for postgres.js, `postgres(url, {...})`). Record
> `max` (default 10), `idle_timeout`, `connect_timeout`. Then determine the PEAK number of
> CONCURRENT connections a single request needs — count the queries inside each
> `Promise.all`, including nested ones. If peak-per-request multiplied by the number of
> requests an instance may serve concurrently exceeds `max`, the pool exhausts and
> requests hang. State the arithmetic explicitly.
>
> **4. Serverless instance packing.** On Vercel Fluid Compute, several concurrent requests
> share ONE instance and therefore ONE pool. Any reasoning that assumes one request per
> instance is wrong. Account for this.
>
> **5. Unbounded queries.** Find every `SELECT` with no `WHERE`, `LIMIT`, or pagination
> that feeds a list or dashboard. These are fine at current volume and degrade steadily.
> State the row count at which each becomes a problem.
>
> **6. Duplicate authentication.** Check whether middleware AND the route handler each
> call the auth provider over the network (e.g. `supabase.auth.getUser()` in both). That
> is a full network round trip paid twice per request. Measure or estimate its cost.
>
> **7. Requests that can hang instead of failing.** Find any awaited network or database
> call with no timeout. On Vercel these stall until the function limit (up to 300s) while
> the browser gives up far earlier, producing a generic error that hides the real cause.
> Every external call should fail fast and say which stage failed.
>
> **8. Transaction connection discipline.** Find every transaction (`sql.begin`,
> `withTransaction`). Inside a transaction callback, does any code call the OUTER
> connection/repository rather than the transaction handle? That checks out a second
> connection while holding the first, and deadlocks the pool under concurrency. This is
> subtle and in-memory test doubles cannot catch it — it needs source inspection.
>
> **9. Caching correctness.** If any cache exists, determine its scope. A process-wide
> cache on serverless means one warm instance serves stale data while another serves
> fresh — intermittent and very hard to debug. Note whether invalidation is even possible
> across independent instances.
>
> **10. Operational readiness.** Report plainly: Are there automated backups, and has a
> restore ever been tested? Is there error/latency monitoring, or would an outage be
> discovered only when a user complains? Does the hosting plan permit commercial use?
> Is the database on a connection-pooled port appropriate for serverless?
>
> ### Method
>
> - Start by reading the request path end to end for the single most-used screen. Most
>   defects concentrate there.
> - Confirm suspicions with `EXPLAIN`, query counts, or `pg_stat_activity` — not by
>   reading code alone.
> - If you find a query stuck `active` with `wait_event_type = 'Client'`, the database
>   finished and is blocked handing results to a client that stopped reading. That points
>   at the application or its connection handling, never at the database.
>
> ### Deliverable
>
> A written report containing:
> - **Measured facts** and **unverified hypotheses**, in clearly separate sections.
> - Findings ranked by severity, each with file:line and a concrete failure scenario.
> - For each finding: the estimated user or data volume at which it starts to bite.
> - An honest statement of what you could NOT verify and what access you would need to.
> - Fixes ordered by (impact / risk), with the cheapest high-impact fix first.
>
> Do not write any code or change any configuration. This is diagnosis only.

---

## Why each item is on the list

Every entry above is a defect that was actually present, not a hypothetical:

| # | What it cost in the AS CRM |
|---|---|
| 1 | `computeDash` ran one query per case. Dashboard hung outright on the second load. **This was the outage.** |
| 2 | ~20 queries per dashboard load, ~12 exact duplicates. |
| 3 | Pool of 10; each request needed ~5 concurrent connections; three concurrent requests exhausted it. |
| 4 | Made the "unrealistically pessimistic" single-instance test turn out to be realistic. |
| 5 | Every case and customer loaded on every request. Harmless at 12 rows. |
| 6 | 2248–2950 ms per request, paid twice, for the same answer. |
| 7 | Requests hung 300 s; users saw a generic "taking longer than usual" screen for a week. |
| 8 | Documented in that repo's own regression test after a prior incident. |
| 9 | A process-wide settings cache had previously shipped, silently ignored admin edits, and was removed. |
| 10 | Hobby plan running a business system; outages found by users, not monitoring. |
