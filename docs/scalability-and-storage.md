# Scalability and Storage — P4

Manager review point: *"Check & discuss scalability of the system for more users with an
estimate of storage."*

Scope: read-only analysis, workstream D. No source files were changed to produce this
document. All numbers below are either (a) computed arithmetically from the actual column
types in `supabase/migrations/0001_initial_schema.sql` / `0002_external_quote_upload_data.sql`
/ `0003_performance_indexes.sql`, or (b) explicitly labelled **ASSUMPTION** with a stated
reasoning range. Nothing here is a measured production number — this repo has no access to
the live database's row counts, `pg_stat`, Supabase billing/usage dashboard, or Vercel
analytics, and that limitation is called out wherever it matters.

---

## 1. Headline risk

The schema is fine. The query pattern is not. `listCustomers()` and `listCases()` do:

```sql
select ... from public.customers      -- customers/repository.ts:220-225, no WHERE
select ... from public.cases          -- cases/repository.ts:297-303, no WHERE
```

Every filter (status, mine/owned/assigned, stage, outcome, search text) happens in JavaScript
*after* the full table is pulled into the Node process — `customers/service.ts:381-388`
(`activeRows(customers).filter(...)`), `cases/service.ts:612-625` (`.filter(...)`). On top of
that, both the dashboard and the case list re-fetch the customer for every single case with
one query per row (`cases/service.ts:597`, `dashboard/service.ts:94`) — classic N+1. The 14
indexes added across migrations 0001 and 0003 are consequently **mostly dead weight today**:
an index on `customers.type` or `cases.stage` cannot be used by a query with no `WHERE`
clause at all. They only help the few queries that do have a `WHERE` (`getCustomer`,
`listCasesByCustomer`, `listQuotesByCustomer`, `countContactsByCustomer`).

Storage itself is not the near-term risk at 20-100 users — the near-term risk is that every
request to `/crm/customers`, `/crm/cases`, and the dashboard does `O(customers + cases)` work
against a single Supabase transaction-pooler connection pool, in-JS, per request, with no
pagination. This degrades gradually (more milliseconds per request) rather than failing
suddenly, which makes it easy to miss until it's already bad.

The one storage number that *is* worth tracking closely: `quotations.upload_data bytea`
(migration `0002_external_quote_upload_data.sql`) stores uploaded quotation files **inline in
the Postgres row**, capped at ~8 MB each (`src/server/quotes/service.ts:544`,
`dataB64.length > 11_000_000` on the base64 string ⇒ ~8.25 MB raw). This is the only part of
the system whose storage genuinely scales with usage in a way worth modelling explicitly (Section 3).

---

## 2. Query patterns — the real story

### 2.1 `listCustomers()` / `listCases()`: full-table reads, filtered in JS

- `src/server/customers/repository.ts:220-228` — `listCustomers()`: `select ... from
  public.customers` with **no WHERE, no LIMIT**. Called from `searchCustomers`
  (`customers/service.ts:374`), `myCustomers` (`:414`), `allCustomers` (`:436`) — i.e. on
  essentially every Customers-tab request.
- `src/server/cases/repository.ts:297-306` — `listCases()`: same shape, `select ... from
  public.cases`, no WHERE, no LIMIT. Called from `cases/service.ts:594` on every Cases-tab
  request and from `dashboard/service.ts:91` on every dashboard load (`bootstrap`,
  `dashboard`, `workspace`).
- Filtering then happens in application code: `customers/service.ts:381-388` (name/tag/area/type
  substring match), `cases/service.ts:612-625` (visibility, owned/assigned, stage, outcome,
  free-text search). `allCustomers`/`myCustomers` do cap the *response* at
  `.slice(0, 400)`/full list (`customers/service.ts:427,447`) and `listCases` caps at
  `.slice(0, 300)` (`cases/service.ts:627`) — but the cap is applied **after** the full table
  was already fetched from Postgres and fully materialised in Node memory, so it saves
  response payload size, not query cost.

**Why this scales badly, concretely:**
- Bytes transferred pooler→Node scale linearly with total row count, not with what's shown.
- CPU cost of the JS `.filter()`/`.map()`/`.sort()` passes is `O(n)` to `O(n log n)` per
  request, repeated on every single page load by every user, not cached across users.
- Memory: each invocation holds the *entire* customers or cases table (with joined-in
  handlers/users context) in the Node process's heap simultaneously per request. On Vercel's
  serverless Node runtime this competes with the per-invocation memory limit (plan-dependent,
  commonly 1024 MB–3008 MB — **needs confirmation against the actual Vercel plan**, not
  visible from this repo).

**Where it starts to hurt (reasoned range, not measured):**
- At ~20 users and the assumed row counts in Section 4 (low hundreds to low thousands of
  customers/cases in year 1), each row is a few hundred bytes (Section 3) — a full-table pull
  is sub-megabyte and the JS pass is sub-millisecond-to-low-tens-of-ms. Not yet felt.
- Once a table crosses roughly **5,000–10,000 rows**, the full select + JS filter/sort
  becomes the dominant cost of the request (tens to low hundreds of ms of pure JS work on a
  serverless CPU, on top of network transfer of the full row set every time) — this is a
  **reasoned range**, not a benchmark; the actual crossing point depends on row width,
  Vercel's serverless CPU allocation, and Supabase pooler round-trip latency (bom1 ↔
  ap-northeast-1 — see Section 5), none of which this analysis can execute to measure.
- Past roughly **50,000 rows** in either table, this pattern is very likely the primary
  latency complaint on every Customers/Cases/Dashboard page load, independent of how many
  concurrent users there are — one user alone loading a page that pulls 50k rows will notice.

### 2.2 N+1: one `getCustomer` per case

- `src/server/cases/service.ts:593-601` (`listCases`):
  ```ts
  const caseRows = await repo.listCases();
  const [cases, customers, handlers, users, quotedValues] = await Promise.all([
    Promise.resolve(caseRows),
    Promise.all(caseRows.map((row) => repo.getCustomer(row.customerId))),
    ...
  ]);
  ```
  This issues **one `select ... from public.customers where customer_id = $1` per case row**,
  fired concurrently via `Promise.all`. For `N` cases that's `N` round trips to the pooler in
  parallel, all sharing one client connection pool (Section 5).
- `src/server/dashboard/service.ts:89-97` (`computeDash`) does the identical thing for every
  dashboard render (bootstrap `self`, `/api dashboard` for any subject, `workspace`):
  ```ts
  const caseRows = await repo.listCases();
  const [cases, customers, handlers, users] = await Promise.all([
    Promise.resolve(caseRows),
    Promise.all(caseRows.map((row) => repo.getCustomer(row.customerId))),
    ...
  ]);
  ```
- `dashboard/service.ts:163-197` (`recentActivity`) issues a further `getCustomer` **inside a
  sequential loop**, not even parallelised, but only when the viewing user is below L4 and the
  activity row isn't their own (`:180-186`) — so it's conditional, not per-row, but still
  worst-case up to 250 sequential `getCustomer` calls (bounded by `listActivity(250)` at
  `:165`) for an L1–L3 user paging through a busy feed. This is the single worst-case latency
  path in the codebase: 250 sequential (not parallel) round trips.

**Why this scales badly, concretely:** Postgres round-trip over the transaction pooler from
Vercel `bom1` to Supabase `ap-northeast-1` is realistically **tens of milliseconds each**
(cross-region; exact figure not measurable from this repo — reasoned range 20–80 ms per
round trip is typical for that geography, not a measured number). With `N` cases:
- `N = 50` cases → ~50 concurrent round trips fired via `Promise.all`. Concurrency is bounded
  by the pool size configured in `db/client.ts` (Section 5) and by Postgres itself, so they
  don't literally all execute simultaneously — expect low hundreds of ms total, not `50 ×
  latency`.
- `N = 500` cases → 500 concurrent connection requests against a pool that, as configured, has
  **no explicit `max`** (Section 5) — this is where the pattern stops being "slow" and starts
  being a real risk of exhausting the Supabase pooler's connection slots.
- `recentActivity`'s sequential path is worse per-request: 250 sequential 20–80 ms round trips
  is 5–20 **seconds** in the worst case (L1/L2 user, busy activity feed, most rows not their
  own) — this is a genuine correctness-adjacent latency bug today, independent of total data
  volume, and gets *worse*, not better, as the company adds more L1/L2 users generating more
  activity that a low-role viewer can't see directly.

### 2.3 Repeated full-table reads of `handlers` and `users`

- `listHandlers()` — `customers/repository.ts:423-430`, `cases/repository.ts:266-273` — full
  unfiltered `select * from public.handlers`.
- `listUsers()` — `customers/repository.ts:455-462`, `cases/repository.ts:275-282` — full
  unfiltered `select * from public.users`.

Both are called on nearly every service method that needs to compute ownership/visibility:
`searchCustomers`, `myCustomers`, `allCustomers`, `getCustomer`, `createCase`, every case
mutation (`addCaseOwner`, `removeCaseOwner`, `assignTicket`, `getCase`, `listCases`), and both
dashboard functions. At **20-100 users this table stays tiny** (a few hundred bytes × user
count — Section 3) so this specific pattern is not a near-term problem in isolation. It
compounds the two problems above: every one of those requests already pays the cost of a full
`customers`/`cases` scan, and now pays two more full-table reads on top, all sequentially
`Promise.all`'d together rather than cached or joined server-side.

### 2.4 Where indexes actually help vs. don't

Migration 0001 and 0003 add indexes on `customers.status`, `.type`, `.priority`, `.area`,
`.sei`, `.remarks`, `.tags` (GIN), `.name_key`, `(status, created_at)`, `(type, priority)
where status='Active'`; on `cases.customer_id`, `.assignee`, `.outcome`, `.stage`,
`.updated_at`, `.closed_on`, `(customer_id, stage)`, `(owner, outcome)`; on
`quotations.customer_id`, `.case_id`, `.status`, `(customer_id, created_at)`.

**Actually used by current code paths:**
- `customers_name_key_idx` — used by `findCustomerByName` (`customers/repository.ts:242-248`,
  `cases/repository.ts:231-239`), which does have a `WHERE name_key = $1`. Genuinely useful.
- `cases_customer_id_idx` — used by `listCasesByCustomer`
  (`customers/repository.ts:324-354`, `WHERE c.customer_id = $1`). Genuinely useful.
- `quotations_customer_id_idx`, `quotations_customer_created_idx` — used by
  `listQuotesByCustomer` (`customers/repository.ts:356-366`). Genuinely useful.
- `quotations_case_id_idx` — used by `listQuotesByCase` (`cases/repository.ts:349-357`).
  Genuinely useful.
- `contacts_customer_id_idx` — used by `listContactsByCustomer`
  (`customers/repository.ts:313-322`). Genuinely useful.
- `handlers_user_email_idx` — no code path in the repositories reviewed here filters
  `handlers` by `user_email` server-side (ownership is computed in JS after `listHandlers()`
  pulls everything); this index is currently **not exercised** by the reviewed query paths.

**Not usable by the reviewed code today, because the query that would use them doesn't exist:**
- `customers_status_idx`, `customers_type_idx`, `customers_priority_idx`, `customers_area_idx`,
  `customers_sei_idx`, `customers_remarks_idx`, `customers_tags_idx` (GIN),
  `customers_status_created_idx`, `customers_type_priority_idx` — all built for filters that
  `listCustomers()` (no WHERE at all) never applies in SQL. They sit idle: Postgres still has
  to maintain them on every insert/update (write-amplification cost with zero read benefit
  today).
- `cases_assignee_idx`, `cases_outcome_idx`, `cases_stage_idx`, `cases_updated_at_idx`,
  `cases_closed_on_idx`, `cases_customer_stage_idx`, `cases_owner_outcome_idx` — same
  situation: `listCases()` has no WHERE, so none of these can be used by the planner for that
  query. They would immediately become valuable the day `listCases()`/`listCustomers()` gain
  real `WHERE` clauses (Section 6, fix #1) — they were evidently added in anticipation of that
  rewrite (see `CONTEXT.md`'s 2026-07-30 "Performance & Latency Optimizations" entry), but the
  filtering side of that work was never finished.

This is worth saying plainly in the report: **the indexing work already done is not wasted,
it's premature** — it will pay off the moment the query layer is fixed to actually filter in
SQL, and until then it's pure write overhead with no matching read benefit.

---

## 3. Storage — row size model from real column types

Postgres row overhead: ~23-28 bytes of header per row (`t_xmin`, `t_xmax`, `t_cid`, etc.) plus
alignment padding; `text`/`varchar`/`bytea` are stored out-of-line via TOAST only past
~2 KB per value (short strings stay inline, roughly 1 byte length + content for the common
case). The estimates below use a **conservative per-row overhead of 28 bytes** plus summed
column content, which is standard practice for this kind of sizing exercise, not a Supabase-
specific measured number.

### 3.1 `customers` (migration 0001, columns at `0001_initial_schema.sql:18-37`)

| column | type | assumed content size |
|---|---|---|
| customer_id | text | 9 (`CUST-0001` style, `CRM_ID_FORMATS.customers` width 4, `db/schema.ts:29`) |
| name | text | ~30 |
| name_key | text (generated) | ~30 |
| tags | text[] | ~20 (1-2 short location tags) |
| type, priority, area | text ×3 | ~10 each = 30 |
| address | text | ~60 |
| gstin | text | ~15 |
| website | text | ~25 |
| notes, remarks | text ×2 | ~80 each = 160 |
| sei | text (P8 will make this `text[]`, still small) | ~20 |
| status | text | 7 |
| created_by | text (FK, email) | ~28 |
| created_at, updated_at | timestamptz ×2 | 8 each = 16 |
| version | bigint | 8 |
| row header + alignment | — | 28 |

**≈ 490 bytes/row.** Round to **500 bytes** for headroom (TOAST pointer overhead, index
tuple space is separate — see below).

### 3.2 `contacts` (`0001_initial_schema.sql:39-50`)

id(6) + customer_id(9) + name(20) + designation(15) + phone(12) + email(28) + notes(40) +
created_by(28) + 2×timestamptz(16) + header(28) ≈ **200 bytes/row**.

### 3.3 `handlers` (`0001_initial_schema.sql:52-62`)

customer_id(9) + user_email(28) + assigned_by(28) + assigned_at(8) + header(28) ≈
**100 bytes/row**. Small, bounded by (customers × handlers-per-customer), not by activity.

### 3.4 `cases` (`0001_initial_schema.sql:64-92`)

case_id(9, `CASE-2026-0001` style, yearly) + customer_id(9) + title(40) + details(150,
free-text case notes) + source(15) + stage(9) + outcome(4) + order_value numeric(8) +
won_categories(30) + outcome_note(60) + owner(28) + extra_owners(40) + assignee(28) +
closed_on timestamptz(8) + created_by(28) + 2×timestamptz(16) + version(8) + header(28) ≈
**≈ 520 bytes/row.** Round to **550 bytes**.

### 3.5 `quotations` — the important one (`0001_initial_schema.sql:110-136`, plus `upload_data
bytea` added in `0002_external_quote_upload_data.sql:1-3`)

Metadata-only columns (quote_no, rev, case_id, customer_id, title, source, file_name,
upload_mime_type, template_id/name, status, 5×numeric, currency, valid_until, notes,
doc_link, pdf_link, created_by, 2×timestamptz) sum to **≈ 350 bytes/row** for a row with
**no** `upload_data` (i.e. every `Generated`-source quote, and every `External` quote whose
bytes ended up saved to Drive instead — per `CONTEXT.md`'s Drive-save feature).

`upload_data bytea` is only populated for `source = 'External'` uploads that were **not**
(yet, or ever) pushed to Drive. Where populated, it stores the **raw file bytes inline in the
row**, capped at ~8 MB by `src/server/quotes/service.ts:544`
(`dataB64.length > 11_000_000` on the base64 string). Realistic external quote files
(scanned PDFs, vendor quote PDFs, Excel BOQs) are more commonly in the **200 KB – 3 MB**
range — **ASSUMPTION**, reasoned from typical PDF/Excel quotation-document sizes, not
measured against this project's real uploads.

`quote_boq` (`0001_initial_schema.sql:138-147`): `headers`/`rows` are `jsonb`, one row per
BOQ block per quote revision. A typical BOQ (10-40 line items × ~6 columns) serializes to
roughly **2-6 KB of jsonb** per block — **ASSUMPTION**, reasoned from typical BOQ sizes, not
measured. Most quotes have 1 BOQ block; large ones might have 2-3.

### 3.6 `activity_log` (`0001_initial_schema.sql:181-189`)

id uuid(16) + created_at(8) + who(28) + action(15) + entity(9) + customer_id(9) +
details(80) + header(28) ≈ **190 bytes/row.** One row is written per meaningful mutation
(`logActivity` calls throughout `customers/repository.ts`, `cases/repository.ts`) — customer
create, case create/edit/stage/outcome/owner-add/owner-remove/assign, per handler add/remove,
per import row. This table grows the fastest per unit of "activity" and is read in full by
`recentActivity` (`dashboard/service.ts:165`, `limit=250`, but the table itself is unbounded).

### 3.7 Index overhead

Btree index tuples are roughly 8-40 bytes each (key + heap pointer + overhead) depending on
key width; GIN indexes on arrays (`customers.tags`, `users.allowed_tags`) are typically larger
per distinct element. As a blanket multiplier — **ASSUMPTION, standard rule of thumb, not
measured for this schema** — total index storage across a table with ~8 B-tree/GIN indexes
(the `customers` and `cases` tables each carry that many after migration 0003) commonly adds
**40-80% on top of heap (row) storage**. Applied below as +60%.

### 3.8 Storage projection

**Stated assumptions** (per active sales user per year — reasoned from a ~20-person B2B
industrial-automation sales team doing account + opportunity management, not measured):

| Assumption | Value |
|---|---|
| New customers/user/year | 15 |
| New cases/user/year | 40 (roughly 1 case per new/existing customer touch per 1-2 weeks) |
| Contacts/customer | 2 (created once, not growing per year) |
| Quotations/case | 0.6 (not every case reaches a quote) |
| External (uploaded, not Drive-saved) quotes as % of quotations | 30% — the rest are
  `Generated` (no `upload_data`) or saved to Drive after upload |
| Avg external upload size (when `upload_data` populated) | 1 MB |
| Activity-log rows/case/lifetime | 6 (create, 2× stage, outcome, 1-2 owner/assign events) |
| Activity-log rows/customer/lifetime (independent of cases) | 3 |
| BOQ jsonb size per quote | 4 KB |

Per-user-per-year row and byte contribution:

| Table | rows/user/yr | bytes/row | KB/user/yr |
|---|---|---|---|
| customers | 15 | 500 | 7.3 |
| contacts | 30 | 200 | 5.9 |
| handlers | ~15 (1 per new customer) | 100 | 1.5 |
| cases | 40 | 550 | 21.5 |
| quotations (metadata) | 24 (0.6×40) | 350 | 8.2 |
| quotations `upload_data` (30% of 24 ≈ 7.2 rows × 1 MB) | 7.2 | ~1,000,000 | 7,031 |
| quote_boq | 24 | 4,000 | 93.8 |
| activity_log | 40×6 + 15×3 = 285 | 190 | 52.9 |
| **Subtotal (rows, ex. index)** | | | **≈ 191 KB/user/yr** |
| **`upload_data` alone** | | | **≈ 7,031 KB/user/yr ≈ 6.9 MB/user/yr** |

`upload_data` dominates total storage by roughly **35×** over every other table combined —
this is the one number in this whole document worth watching in production, because it is
driven entirely by upload behaviour (how many sales reps upload vendor PDFs instead of
generating quotes in-app, and how reliably "Save to Drive" gets used to offload them — see
`CONTEXT.md`'s Google Drive quotation feature) rather than by row count growth.

With the +60% index overhead applied to the non-`upload_data` rows (bytea columns are not
indexed):

```
per-user-per-year total ≈ (191 KB × 1.6) + 7,031 KB ≈ 306 KB + 7,031 KB ≈ 7.34 MB/user/yr
```

**Projected total database size** (`users × years × 7.34 MB`, cumulative, plus a flat ~5 MB
for `users`/`settings`/`counters`/schema/system catalogs which is negligible at this scale):

| | 1 year | 3 years | 5 years |
|---|---|---|---|
| **20 users** | ~147 MB | ~440 MB | ~734 MB |
| **50 users** | ~367 MB | ~1.10 GB | ~1.83 GB |
| **100 users** | ~734 MB | ~2.20 GB | ~3.67 GB |

All figures **ASSUMPTION-derived** per the table above — real usage could plausibly run
2-5× lower or higher depending mainly on (a) how many quotations are uploaded PDFs vs.
in-app generated, and (b) whether "Save to Drive" is used consistently (it does not delete
`upload_data` from Postgres after a Drive save — worth confirming/fixing separately, see
Section 6). If Drive-save became the default and old `upload_data` rows were nulled out after
a successful Drive save, the `upload_data` line collapses from ~7 MB/user/yr to near zero and
total storage becomes ~150-750 KB/user/yr instead — **two full orders of magnitude smaller**.
That single behavioural/architectural choice is the biggest lever on storage in this entire
system, bigger than user count or years.

---

## 4. Latency projection for the dominant endpoints

No load testing was run — this repo has no access to a live environment to benchmark
against. The projections below reason from the query patterns in Section 2 and standard
assumptions about serverless Postgres round-trip cost; they are **directional, not measured**.

| Endpoint | Query shape | Fine until roughly | Breaks first because |
|---|---|---|---|
| `GET` Customers tab (`allCustomers`/`myCustomers`, `customers/service.ts:412-451`) | 1× full `customers` scan + 1× full `handlers` scan + 1× full `users` scan + 1 `countContactsByCustomer` (grouped, still full-table) — all in one `Promise.all` | ~5,000-10,000 customer rows | JS `.filter/.sort/.map` over the full table, repeated per request, no caching between users |
| `GET` Cases tab (`listCases`, `cases/service.ts:593-645`) | 1× full `cases` scan + **N `getCustomer` calls (N = case count)** + full `handlers`/`users` scans + `latestQuotedValueByCase` (grouped, full-table) | ~2,000-5,000 case rows — the N+1 dominates well before the raw scan does | N+1 `getCustomer` round trips exhaust available pooler slots under concurrent users before the JS filtering cost even matters |
| Dashboard (`computeDash`, `dashboard/service.ts:89-161`) | Identical N+1 shape to Cases, run on **every** dashboard load (bootstrap, per-user dashboard view, workspace) | same ~2,000-5,000 case threshold, hit *sooner* in wall-clock terms because dashboard is the first page loaded on every login | same N+1 root cause, plus it's on the hot path every user hits first |
| `recentActivity` (`dashboard/service.ts:163-197`) | Full `activity_log` fetch of last 250 rows + up to 250 **sequential** (not parallel) `getCustomer` calls for L1-L3 viewers | Already a problem today at low row counts for any L1-L3 user with a busy team activity feed — this is a correctness-adjacent bug, not a scale threshold | Sequential N+1, independent of total table size — driven by how many *other people's* activity rows exist in the last 250, i.e. gets worse as headcount grows even if per-user activity stays flat |

**Rule of thumb for "when does this need fixing":** the N+1 patterns (Cases list, Dashboard,
recent activity) are latency risks *now*, at 20 users, if any team member accumulates a few
hundred cases or the shared activity feed is busy — they do not require years of growth to
bite. The full-table-scan-then-filter pattern (Customers list, Cases list's base query) is a
1-3 year risk at current growth assumptions (Section 3's 40 cases/user/year × 20-100 users =
800-4,000 cases/year), crossing the "felt on every page load" range in roughly year 2-4
depending on user count.

---

## 5. Connection model: Vercel serverless + Supabase transaction pooler

- `src/server/db/client.ts:3` — `export const sql = postgres(process.env.DATABASE_URL!, {
  prepare: false })`. This is a **module-level** `postgres()` client, created once per
  serverless function instance (Node module caching), reused across invocations of the same
  warm instance. `prepare: false` is correct and required for the transaction pooler (port
  6543, documented in `CONTEXT.md`), which does not support session-level prepared statements
  across pooled connections — good, this is the right setting for this deployment topology.
- **No explicit `max` connection count is set.** The `postgres.js` library's default `max` is
  10 connections per client instance. Each *cold* Vercel serverless invocation that doesn't
  reuse a warm instance creates its own `sql` client, i.e. its own pool of up to 10
  connections, against the Supabase transaction pooler. Under concurrent traffic (many
  simultaneous requests spinning up many cold Lambda instances), the **total** connections
  requested from the pooler is `(number of concurrently cold-starting function instances) ×
  10`, not bounded by one global pool. Supabase's transaction pooler has a project-level
  connection ceiling (tier-dependent — this repo cannot see which Supabase plan is active;
  needs confirmation, see Section 7).
- Combined with the N+1 pattern (Section 2.2): a single Cases-tab or Dashboard request with
  `N` cases fires `N` concurrent `getCustomer` queries via `Promise.all` from *one* function
  instance's pool of ≤10 connections. Once `N` exceeds the pool size, `postgres.js` queues the
  excess queries rather than failing, so a single request with hundreds of cases serialises
  into batches of ~10, adding wall-clock latency (this queuing is *why* the N+1 pattern's
  latency cost is worse than "N independent fast queries" — they compete for the same small
  pool) rather than erroring outright. This is a graceful-degradation property of `postgres.js`
  worth knowing but not a reason to leave the N+1 unfixed.
- **At ~20-100 internal users this is unlikely to exhaust the pooler in practice** — this is a
  low-traffic internal tool (~20 users today per the deployment context), not a public-facing
  app under bursty load. The real risk window is a *traffic spike inside the N+1 pattern*
  (e.g. several people loading the Cases tab or Dashboard at the same moment each with a few
  hundred visible cases), not steady-state connection count.

---

## 6. Prioritised fixes, ordered by impact / effort

Each entry names the exact file:line it targets.

1. **Fix `recentActivity`'s sequential per-row `getCustomer` loop** —
   `src/server/dashboard/service.ts:163-197`. Effort: small (batch the distinct
   `customerId`s from the 250 activity rows into one `IN (...)`-style lookup, or a new
   repository method `getCustomers(ids: string[])`, before the loop). Impact: eliminates a
   multi-second worst-case latency path that exists **today**, independent of data growth,
   for every L1-L3 user. Highest impact-per-effort item in this list.

2. **Eliminate the N+1 `getCustomer`-per-case pattern** —
   `src/server/cases/service.ts:597` (`listCases`) and `src/server/dashboard/service.ts:94`
   (`computeDash`). Effort: medium — replace `Promise.all(caseRows.map(row =>
   repo.getCustomer(row.customerId)))` with a single `getCustomersByIds(ids)` repository
   method backed by `WHERE customer_id = ANY($1)`, or push the join into the `listCases()`
   SQL itself (similar to how `listCasesByCustomer`,
   `customers/repository.ts:324-354`, already joins `handlers` and `quotations` server-side).
   Impact: removes the dominant latency driver for the two highest-traffic endpoints
   (Dashboard, Cases tab) and is the change that makes `cases_customer_id_idx` and friends
   start paying for themselves in the reverse direction (fewer, cheaper queries).

3. **Add real `WHERE`/pagination to `listCustomers()` and `listCases()`** —
   `src/server/customers/repository.ts:220-228`, `src/server/cases/repository.ts:297-306`,
   with the corresponding service-layer filters (`customers/service.ts:381-388`,
   `cases/service.ts:612-625`) pushed down into SQL instead of `.filter()`. Effort:
   medium-large — this touches the shape of `CustomerRepository`/`CaseRepository`'s list
   methods and every call site, and needs care around the ownership/visibility logic
   (`accessLevel`, `ensureCanSeeCase`) which currently depends on having `handlers` loaded
   in JS. Impact: this is what actually makes the 14 indexes from migrations 0001/0003 start
   being used (Section 2.4) and is the fix that matters most for the **3-5 year** horizon
   as customer/case counts grow into the thousands. Lower urgency than #1/#2 at today's
   ~20-user scale, but is the one that prevents a "why is the CRM slow now" complaint 2-3
   years out.

4. **Cap/paginate `listHandlers()`/`listUsers()` call fan-out, or cache them per-request** —
   `customers/repository.ts:423-430,455-462`, `cases/repository.ts:266-273,275-282`. Effort:
   small (a per-request memoisation wrapper, since both tables stay small at 20-100 users —
   Section 3.3). Impact: low at current scale, but cheap to do alongside #2/#3 since the same
   call sites are being touched anyway.

5. **Decide and implement a retention/offload policy for `quotations.upload_data`** —
   `supabase/migrations/0002_external_quote_upload_data.sql:1-3`,
   `src/server/quotes/service.ts:544`. Effort: small-medium (null out `upload_data` for rows
   that already have a `drive_view_link` set per `supabase/migrations/0004_quotation_drive_link.sql`,
   or stop writing to `upload_data` at all once Drive-save is reliable and instead store bytes
   transiently). Impact: this is the single largest lever on total database size (Section
   3.8 — up to ~100× smaller storage if inline bytea is retired in favour of Drive), though it
   is a storage-cost concern rather than a latency one, and is lower urgency than #1-#3 for an
   internal 20-100 user tool where a few GB of Postgres storage is inexpensive on any paid
   Supabase tier.

---

## 7. Plan limits — flagged as needing confirmation

This repo cannot see the Supabase billing dashboard or Vercel account plan. The following are
the limits that become relevant as the system grows, stated generically per each provider's
publicly documented tier structure, **not** confirmed against what Automation Systems is
actually subscribed to:

- **Supabase database size cap** — Free tier historically caps total database size in the low
  hundreds of MB to ~500 MB-1 GB range depending on current Supabase pricing; paid tiers
  (Pro and above) raise this substantially and bill overage per GB. Given Section 3.8's
  projection (0.7-3.7 GB depending on scale/years, dominated by `upload_data`), **this is
  worth confirming now**: if the project is still on Supabase's free tier, the 3-5 year
  projection at 50-100 users could approach or exceed a free-tier ceiling; if `upload_data`
  offload (fix #5) isn't done, this timeline shortens considerably.
- **Supabase transaction pooler connection ceiling** — tier-dependent (typically tens to a
  few hundred pooled connections). At 20-100 internal users this is very unlikely to be
  reached in steady state (Section 5), but a burst of concurrent N+1-heavy requests (fix #2
  unfixed) could transiently pressure it. Confirm current tier's pooler connection limit.
- **Supabase egress/bandwidth** — full-table reads on every Customers/Cases/Dashboard request
  (Section 2.1) multiply the bytes transferred out of Supabase per request. Free/lower tiers
  cap monthly egress; this is worth checking once fix #3 is *not* yet done, since unfiltered
  full-table reads are the most bandwidth-hungry pattern in the app today.
- **Vercel serverless function memory/duration limits** — plan-dependent (Hobby vs. Pro vs.
  Enterprise change both the per-invocation memory ceiling and max execution duration).
  Relevant because the full-table-scan-then-JS-filter pattern (Section 2.1) and any future
  growth in row counts both increase per-invocation memory use and CPU time. Confirm the
  current Vercel plan tier for `as-crm` (`CONTEXT.md` shows the project is under the
  "Automation Systems" Vercel team, region `bom1`, but not which pricing tier).
- **Vercel serverless function invocation/GB-hours quota** — relevant mainly if traffic grows
  well beyond 100 internal users; at today's scale (~20 users, internal tool) this is very
  unlikely to be a near-term constraint regardless of tier.

None of the above should be treated as an alarm — they are the specific line items a follow-up
conversation with whoever holds the Supabase/Vercel billing access should check, given the
storage and query-volume trajectory modelled in this document.

---

## 8. Summary of thresholds (quick reference)

- **Fine as-is today** at ~20 users / current data volume for raw storage (Section 3) and for
  connection pooling under normal (non-bursty) load (Section 5).
- **Already a live latency bug**, not a future scale problem: `recentActivity`'s sequential
  N+1 (`dashboard/service.ts:163-197`) for any L1-L3 user on a busy activity feed. Fix #1.
- **Breaks first as case/customer counts grow**, in this order:
  1. N+1 `getCustomer`-per-case on Cases tab and Dashboard (Section 2.2) — starts costing
     noticeable latency once any user/team accumulates a few hundred visible cases, well
     before raw row counts get large. Fix #2.
  2. Full-table-scan-then-JS-filter on Customers/Cases lists (Section 2.1) — becomes the
     dominant cost once either table crosses roughly 5,000-10,000 rows, which under the
     stated growth assumptions (Section 3.8) is a **~2-4 year** horizon at 20-100 users. Fix #3.
  3. `upload_data bytea` storage growth (Section 3.8) — the dominant *byte* cost by ~35×, but
     not a functional break; it's a billing/retention decision (Fix #5), and its timeline
     depends entirely on upload behaviour, not user or case counts.
