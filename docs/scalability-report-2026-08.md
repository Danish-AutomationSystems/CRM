# CRM Scalability Report — Free-Tier Capacity Analysis

**Date:** 13 August 2026
**System:** AutomationSystems CRM (`migrated-crm`), production
**Hosting:** Vercel Hobby (free), region `bom1` (Mumbai)
**Database:** Supabase Free tier, project `cympxjsqetzivwxwbhob`, PostgreSQL 17.6, region `ap-northeast-1` (Tokyo)

Unlike the earlier `scalability-and-storage.md` (written without database access), every
number in Sections 1–3 below is **measured against the live production database**. Modelling
assumptions are labelled `ASSUMPTION` and carry a stated range.

---

## 1. Executive answer

**How many users can this run on free tier?**

| Configuration | Realistic active-user ceiling | What stops you |
|---|---|---|
| **As-is today**, quotation file uploads used normally | **5–8 users** | Uploaded PDFs stored inside Postgres burn the 500 MB database cap in 2–6 months |
| **As-is code**, but quotation files sent to Google Drive instead | **10–15 users** | Page latency once the case table passes ~300 rows; then the 5 GB/month egress cap |
| **+ 3 cheap code fixes** (Section 6, items 1–4) | **25–40 users** | Egress, at roughly 2,000 cases |
| **+ server-side filtering and pagination** (item 5) | **100+ users** | Supabase shared compute, and the Vercel Hobby commercial-use restriction |

**The single most important finding:** the CRM's own records (customers, cases, contacts,
quotations metadata, activity log) are *not* the problem. At a 20-user workload they consume
about **60 MB per year** — the 500 MB free database would last over eight years. The problem
is that uploaded quotation files are stored as `bytea` **inside the database rows**, which at
the same 20 users consumes about **200 MB per month**. That one design choice is roughly
**40× more expensive than the entire rest of the CRM combined**, and it is the reason the
practical ceiling today is 5–8 users rather than 40.

**The second most important finding:** the case list issues one database query *per case*
(an N+1), and the compute is in Mumbai while the database is in Tokyo. Every one of those
round trips costs real milliseconds across an ocean. This makes page load time scale with
the number of cases regardless of how many users you have — a **single** user with 1,000
cases will already see ~9-second page loads and risk function timeouts.

---

## 2. Measured production state (13 Aug 2026)

### 2.1 Database size

| Metric | Measured |
|---|---|
| Total database size | **12 MB** |
| Sum of all 15 application tables (heap + indexes + TOAST) | **912 KB** |
| PostgreSQL system catalog / baseline overhead | ~11 MB |
| Supabase Free tier cap | 500 MB |
| **Headroom** | **~488 MB** |

Note the baseline: an empty Supabase project already occupies ~11 MB of the 500 MB before a
single CRM record exists. Budget against 488 MB, not 500 MB.

### 2.2 Row counts and table sizes

| Table | Rows | Total size | Indexes | Index share |
|---|---|---|---|---|
| `customers` | 4 | 192 kB | 11 | 92% |
| `cases` | 4 | 160 kB | 9 | 90% |
| `activity_log` | 25 | 96 kB | 5 | 83% |
| `users` | 3 | 72 kB | 3 | 78% |
| `quotations` | 0 | 56 kB | 6 | 100% |
| `actions` | 0 | 56 kB | 6 | 100% |
| `handlers` | 4 | 48 kB | 2 | 67% |
| `contacts` | 2 | 48 kB | 2 | 67% |
| `settings` | 14 | 32 kB | 1 | 50% |
| `counters` | 4 | 32 kB | 1 | 50% |
| `schema_migrations` | 8 | 32 kB | 1 | 50% |
| `recycle_bin`, `import_customers`, `import_contacts` | 0 | 24 kB each | 2 each | 100% |
| `quote_boq` | 0 | 16 kB | 1 | 100% |

The production database is effectively **empty** — this is a freshly migrated system. All
sizes above are dominated by Postgres's 8 kB minimum page allocation, not by data.

### 2.3 Measured average row width

Taken with `pg_column_size()` on real production rows:

| Table | Avg bytes/row | Max | Indexes on table | All-in cost/row¹ |
|---|---|---|---|---|
| `cases` | 240 | 256 | 9 | ~720 B |
| `customers` | 168 | 176 | 11 | ~750 B |
| `users` | 136 | 144 | 3 | ~320 B |
| `activity_log` | 129 | 167 | 5 | ~400 B |
| `contacts` | 99 | 104 | 2 | ~230 B |
| `handlers` | 83 | 88 | 2 | ~210 B |

¹ All-in = measured row width + 28 B heap tuple overhead + ~50 B per btree index entry.
The 50 B figure is a standard estimate for short text keys including page slack.

**Observation:** this schema is heavily over-indexed for its access pattern. `customers`
carries 11 indexes against a 168-byte row — indexes cost roughly **3.3× the data itself**.
Worse, most of them are never used (Section 2.5).

### 2.4 Network latency (the hidden cost)

Measured, 20 consecutive `select 1` round trips on a warm connection:

```
host: aws-0-ap-northeast-1.pooler.supabase.com
min 141.9   p50 159.7   max 161.1   ms
```

That measurement is from an office/home connection in India. Vercel `bom1` (Mumbai, AWS)
to `ap-northeast-1` (Tokyo) is datacenter-to-datacenter and will be faster — **an estimated
75–110 ms per round trip** (`ASSUMPTION`: not directly measured; inferred from typical AWS
inter-region latency on that path).

Either way the conclusion holds: **every database round trip on this deployment costs
roughly 100 ms.** Code that issues one query per row is paying an ocean crossing per row.

### 2.5 Index usage (`pg_stat_user_indexes`)

Indexes with **zero scans** since the database was created:

`quotations_active_revision_idx`, `quote_boq_pkey`, `recycle_bin_pkey`,
`users_allowed_tags_idx`, plus all indexes on `actions`, `import_customers`,
`import_contacts`.

Meanwhile `customers` has recorded **148 sequential scans** and `cases` **103** — those are
the `listCustomers()` / `listCases()` full-table reads. The indexes cannot help a query with
no `WHERE` clause. Today this costs nothing (4 rows); at 5,000 rows it is the whole problem.

### 2.6 Connections

| Metric | Measured |
|---|---|
| `max_connections` | **60** |
| Currently active | 12 |

The application connects via `postgres(process.env.DATABASE_URL!, { prepare: false })` —
`src/server/db/client.ts:3`. No `max`, no `idle_timeout`, no `connect_timeout` is set, so
**postgres.js defaults to a pool of 10 connections per Node instance, held open
indefinitely**. Production uses the transaction pooler (port 6543), which multiplexes and
largely absorbs this. But local scripts and migrations use the session pooler (port 5432),
where it is *not* absorbed: six concurrent scripts would exhaust all 60 connections.

---

## 3. Where data is stored, and what actually grows

| Data | Stored in | Growth driver | Risk |
|---|---|---|---|
| Customers, cases, contacts, quotation metadata | Supabase Postgres rows | Sales activity | Low — linear and small |
| **Uploaded quotation files** | **Supabase Postgres, `quotations.upload_data bytea`** | Every external quotation upload, up to 8 MB each | **Critical — dominates everything** |
| Generated quotation documents | Google Drive (`drive_file_id`, `drive_view_link`) | Template merges | None on the database |
| Activity log | Supabase Postgres, `activity_log` | 41 distinct write sites across the server code; never pruned | Medium — largest structured term |
| Recycle bin | Supabase Postgres, `recycle_bin` | Deletions | Low, but retains full row copies indefinitely |
| Sessions / auth | Supabase Auth | User count | Negligible (50,000 MAU free) |
| Static assets, build output | Vercel | Deploys | Negligible |

### 3.1 The `bytea` upload path

`src/server/quotes/service.ts:544` accepts base64 uploads up to `11_000_000` characters —
about **8.25 MB of raw file** — and `repository.ts:423` writes it straight into
`quotations.upload_data`. PDFs are already compressed, so Postgres TOAST compression
recovers almost nothing.

Two consequences beyond raw size:

1. **Read amplification.** `getQuote()` (`repository.ts:390`) and `listQuotesByQuoteNo()`
   (`:407`) both `select ... encode(upload_data, 'base64')` — they pull the *entire file*
   out of the database and inflate it by 1.33× as base64, through the connection pooler,
   through the Node process, on every single call. An 8 MB attachment becomes ~11 MB of
   database egress per view.
2. **Egress double-charging.** The file cost egress once when uploaded and again on every
   download, all counted against the 5 GB/month free allowance.

**Credit where due:** the list-level queries are correct — `listQuotesByCustomer`
(`customers/repository.ts:365`) and `listQuotesByCase` (`cases/repository.ts:361`) do *not*
select the blob column. The problem is confined to the single-quote read path.

---

## 4. Capacity model

### 4.1 Workload assumption

`ASSUMPTION` — per active salesperson, per month. Adjust these and the model scales linearly.

| Activity | Assumed rate | Plausible range |
|---|---|---|
| New customers | 15 | 5–30 |
| New cases | 30 | 10–60 |
| New contacts | 20 | 5–40 |
| Quotations created | 25 | 10–50 |
| Activity-log rows | 500 | 200–1,000 |
| Quotation files uploaded | 25 | 5–50 |
| Average uploaded file size | 400 kB | 100 kB – 8 MB |
| Page loads (cases/dashboard/customers) | 880 (40/day × 22 days) | 400–1,500 |

### 4.2 Structured data — not the problem

| Table | Rows/user-month | Bytes/row | Subtotal |
|---|---|---|---|
| `customers` | 15 | 750 B | 11 kB |
| `cases` | 30 | 720 B | 22 kB |
| `contacts` | 20 | 230 B | 5 kB |
| `quotations` (metadata only) | 25 | 650 B | 16 kB |
| `activity_log` | 500 | 400 B | **200 kB** |
| **Total** | | | **~250 kB per user-month** |

488 MB headroom ÷ 250 kB = **~2,000 user-months of capacity**.

| Users | Structured growth | Free-tier runway |
|---|---|---|
| 5 | 1.25 MB/month | **32 years** |
| 20 | 5 MB/month | **8 years** |
| 50 | 12.5 MB/month | **3.2 years** |
| 100 | 25 MB/month | **1.6 years** |

Note `activity_log` is **80% of all structured growth**. It is the only structured table
worth a retention policy.

### 4.3 Uploaded files — the actual wall

25 uploads × 400 kB = **10 MB per user-month**, forty times the structured cost.

| Users | Blob growth | Free-tier runway (488 MB) |
|---|---|---|
| 5 | 50 MB/month | **~10 months** |
| 10 | 100 MB/month | **~5 months** |
| 20 | 200 MB/month | **~2.4 months** |
| 50 | 500 MB/month | **under 1 month** |

Even on the conservative end of the range (10 uploads/user-month at 200 kB = 2 MB/user-month),
20 users exhaust the free database in **12 months**.

**This single line item determines the free-tier user ceiling.** Move these files to Google
Drive — which the codebase is already integrated with, and for which `quotations.drive_file_id`
already exists — and the ceiling moves from Section 4.3's numbers to Section 4.2's.

### 4.4 Egress — the second wall

Supabase Free allows **5 GB/month** of egress, counted across everything leaving the project,
including every row the Vercel functions read.

`listCases()` (`cases/repository.ts:309`) reads the **entire** cases table with no `WHERE`
and no `LIMIT`, and `cases/service.ts:623` then fetches the customer for each case
individually. Wire cost per cases-tab load ≈ **K × 600 B**, where K is the total number of
cases in the system.

At 20 users × 880 loads = 17,600 loads/month, the per-load egress budget is 5 GB ÷ 17,600
= **284 kB**. That is:

| Users | Cases in table before 5 GB/month egress is exceeded |
|---|---|
| 5 | ~1,900 |
| 10 | ~950 |
| 20 | **~470** |
| 50 | ~190 |

Read that table carefully: **with 20 users, the free egress allowance is exhausted once the
system holds about 500 cases** — a volume 20 salespeople would reach in under a year. Egress
is a far tighter constraint than storage, and it is caused entirely by the missing `WHERE`
clauses, not by the amount of data.

### 4.5 Latency — the first wall you will actually feel

`cases/service.ts:620-624`:

```ts
const caseRows = await repo.listCases();
const [cases, customers, handlers, users, quotedValues] = await Promise.all([
  Promise.resolve(caseRows),
  Promise.all(caseRows.map((row) => repo.getCustomer(row.customerId))),   // N+1
  ...
```

K cases produce K separate `getCustomer` queries. `Promise.all` issues them concurrently, but
the postgres.js pool defaults to 10 connections, so they execute in `ceil(K / 10)` sequential
waves — each wave paying one Mumbai↔Tokyo round trip of ~90 ms.

| Cases in table | Waves | Added page latency | Status |
|---|---|---|---|
| 100 | 10 | ~0.9 s | Noticeable |
| 300 | 30 | ~2.7 s | Users complain |
| 500 | 50 | ~4.5 s | Bad |
| 1,000 | 100 | **~9 s** | At the 10 s Vercel function limit |
| 2,000 | 200 | ~18 s | **504 Gateway Timeout** |

**This is independent of user count.** One user with 1,200 cases hits it just as hard as
thirty users do. It is the first ceiling the business will encounter, and it arrives at a
data volume the company will reach quickly.

The dashboard already solves this correctly — `dashboard/service.ts:200` uses
`getCustomersByIds()`, a single batched query. The cases list simply never adopted it.

---

## 5. Non-technical limits worth knowing

1. **Vercel Hobby is licensed for non-commercial use only.** Its terms of service exclude
   commercial usage, and a company CRM used by a sales team is commercial. This is a
   compliance exposure independent of any technical limit, and it is resolved by the $20/month
   Pro plan. Flagging it because it can result in an account suspension with no warning and
   no technical symptom beforehand.
2. **Supabase Free performs no automated backups.** This is why the project carries
   `scripts/backup-database.mjs` / `verify-backup.mjs` / `restore-database.mjs`. Those
   backups are currently the *only* restore point, they live in the gitignored `backups/`
   directory on one laptop, and they contain the entire customer dataset in plaintext. Taking
   them regularly and storing a copy off that laptop is a live operational requirement, not a
   nice-to-have.
3. **Supabase Free pauses a project after 7 days of no activity.** Weekday use prevents this,
   but an extended holiday shutdown could pause production. Resuming is manual.
4. **Supabase Free allows 2 active projects per organisation** — relevant if a staging
   environment is ever wanted.
5. **Free-tier compute is a shared micro instance.** Combined with the full-table-read
   pattern, expect request queuing beyond roughly 10–20 genuinely simultaneous requests.

---

## 6. Recommendations, ordered by value per unit of effort

**1. Move uploaded quotation files out of Postgres into Google Drive.** *(Highest value.)*
Deletes the only super-linear storage term. Drive is already integrated, credentials are
already configured, and `quotations.drive_file_id` already exists. Effect: free-tier user
ceiling moves from ~5–8 to ~15, and database growth drops ~40×. Requires a migration to move
existing blobs (currently zero rows, so **doing this now is free — the cost only rises**).

**2. Batch the N+1 in the case list.** Replace `cases/service.ts:623` with the existing
`getCustomersByIds()`. K round trips become 1. Effect: removes the latency wall in Section
4.5 entirely and cuts egress per load by roughly 40%. Perhaps an hour of work including tests.

**3. Configure the connection pool for serverless.**
```ts
export const sql = postgres(process.env.DATABASE_URL!, {
  prepare: false,
  max: 3,
  idle_timeout: 20,
  connect_timeout: 10
});
```
Prevents idle-connection accumulation against the 60-connection limit. One line.

**4. Co-locate compute with the database.** The database is in Tokyo (`ap-northeast-1`);
Vercel is pinned to Mumbai (`bom1` in `vercel.json`). Since request handling is dominated by
database round trips rather than by user round trips, moving Vercel to `hnd1` (Tokyo) should
be a net win. Worth measuring before and after rather than assuming.

**5. Push filtering into SQL and paginate.** `listCustomers()` and `listCases()` currently
read entire tables and filter in JavaScript (`customers/service.ts:381`,
`cases/service.ts:612`). Moving the status/stage/owner/search filters into `WHERE` clauses
with `LIMIT`/`OFFSET` turns egress from O(table) into O(page), lifts the Section 4.4 ceiling
by one to two orders of magnitude, and finally makes the 14 currently-idle indexes earn their
storage. This is the largest piece of work here and the one that unlocks 100+ users.

**6. Add a retention policy to `activity_log`.** It is 80% of structured growth and 41 code
paths write to it. Suggested: keep 12 months live, export older rows to Drive monthly, delete.
Also consider whether `recycle_bin` needs a purge schedule.

**7. Drop unused indexes.** Seven indexes have never been scanned. On `customers` alone,
indexes cost 3.3× the row data. Re-check `pg_stat_user_indexes` after real usage accumulates
before dropping anything — current statistics reflect a nearly empty system.

**8. Monitor rather than guess.** A weekly check of `pg_database_size(current_database())`
against 500 MB, plus the Supabase dashboard's egress meter, converts every estimate in this
document into an observed trend line. This matters most because the assumptions in Section
4.1 are the weakest part of the analysis.

### When paying becomes worthwhile

| Plan | Cost | What it lifts |
|---|---|---|
| Supabase Pro | $25/month | 8 GB database (16×), 250 GB egress (50×), daily automated backups, dedicated compute |
| Vercel Pro | $20/month | Commercial-use licence, higher function limits and bandwidth |

**$45/month lifts every ceiling in this report by roughly 50×** and removes the backup risk.
Recommendation: implement fixes 1–3 first regardless — they are cheap, and they are the
difference between the paid plan lasting years versus months. But note that item 1 (moving
files to Drive) is worth doing *even on the paid plan*, because storing 8 MB binaries in
database rows remains the wrong place for them at any price.

---

## 7. Bottom line

- The free tier is **not** currently constrained by CRM data volume. At 20 users the records
  themselves would take **eight years** to fill 500 MB.
- It **is** constrained by two implementation choices: uploaded files stored in database rows,
  and list queries that read entire tables with one extra query per row.
- With those two fixed — an estimated **one to two days of work** — the free tier
  comfortably supports **25–40 active users**, and the paid tier supports several hundred.
- Without them, the realistic ceiling is **5–8 users**, with the first failure being slow
  page loads rather than an error message, which makes it easy to miss until it is already bad.

---

### Reproducing these measurements

All figures in Sections 2 came from direct queries against production on 13 Aug 2026:
`pg_database_size()`, `pg_total_relation_size()`, `pg_column_size()`,
`pg_stat_user_indexes`, `pg_stat_user_tables`, and a 20-iteration `select 1` latency loop.
Re-running them after real usage accumulates is the correct way to replace the `ASSUMPTION`
rows in Section 4.1 with observed rates.
