# AS CRM Database Security Audit — Unauthorised Access Review (P3)

Date: 2026-08-11
Author: Workstream C (security audit), CRM Points manager-feedback batch
Scope: `docs/`-only, read-only review — no source file was modified to produce this report.
Manager's review point: "Check security of database for unauthorised access."

---

## 1. How to read this report

Every finding below carries:
- A **severity**: Critical / High / Medium / Low / Informational.
- A **file:line** citation to the exact code verified.
- A **concrete exploit scenario**, or an explicit statement that the item is not exploitable and why.

Two classes of statement appear throughout:
- **VERIFIED** — read directly from the code in this repository during this session.
- **NOT VERIFIED FROM REPO** — depends on live Supabase/Vercel dashboard configuration, which
  this read-only, repo-only task cannot inspect. Listed in full in §9.

---

## 2. Summary table

| # | Area | Severity | Verdict |
|---|---|---|---|
| 1 | Row Level Security coverage | Informational | Sound as designed — all 14 tables, deny-all, sequences revoked |
| 2 | Real trust boundary (`DATABASE_URL` role) | **High** (architectural, by design) | RLS provides **zero** protection against the app server itself — see §4 |
| 3 | Auto-provision-as-L1 | **Medium** | Single most important item — assessed in full in §5; not as bad as it first looks, but not free either |
| 4 | Route protection (`middleware.ts`) | Low | `/api/download/...` is outside `PROTECTED_PREFIXES` but self-protects via `getRequestContext` — not exploitable |
| 5 | Per-request authorisation / RPC identity trust | Informational | Sound — `context` always server-derived, never taken from `args` |
| 6 | SQL injection surface | Low | One interpolated string found (`Drive files.list` query); not exploitable — input is not attacker-controlled |
| 7 | Secrets handling | Informational | Sound — `.env.local` git-ignored and not tracked; drive-setup routes are L6-gated and self-disabling |
| 8 | Admin surface (`ensureAdmin`) | Informational | Sound — every admin RPC calls `ensureAdmin` before doing anything |

**Single most important risk: item 3, the auto-provision path** — full analysis in §5.

---

## 3. Row Level Security (RLS) — `supabase/migrations/0001_initial_schema.sql`

**VERIFIED.** Lines 292–328 run a `do $$ ... $$` block that loops over an explicit array of
14 table names:

```
users, customers, contacts, handlers, cases, actions, quotations, quote_boq,
recycle_bin, settings, counters, activity_log, import_customers, import_contacts
```

This is exactly the full set of tables created earlier in the same file (lines 3–227) — every
`create table` matches an entry in the loop array; there is no table created without a
corresponding loop entry. For each table the migration:

- `alter table ... enable row level security` (0001:313)
- `revoke all on table ... from anon, authenticated` (0001:314)
- drops and recreates four `deny_direct_*` policies for `anon`/`authenticated` covering
  `select`/`insert`/`update`/`delete`, every one `using (false)` / `with check (false)`
  (0001:316–324)

Sequences are separately locked down: `revoke all on all sequences in schema public from
anon, authenticated` (0001:328). Since every table uses `text`/`uuid` primary keys (`gen_random_uuid()`
default via `pgcrypto`, or app-generated `text` IDs from `src/server/db/ids.ts`), there are in
fact no `serial`/`bigserial` sequences exposed by table structure — this line is defensive
belt-and-braces, not compensating for a real serial-PK gap.

**Later migrations (0002, 0003, 0004) — checked for anything that escapes the loop:**
- `supabase/migrations/0002_external_quote_upload_data.sql` — adds two columns
  (`upload_mime_type`, `upload_data`) to the existing `public.quotations` table only. Adding a
  column to a table that already has RLS enabled does not require re-enabling RLS; the existing
  policies apply automatically to the new columns. No new table, no gap.
- `supabase/migrations/0003_performance_indexes.sql` — indexes only, no new tables, no RLS
  interaction at all.
- `supabase/migrations/0004_quotation_drive_link.sql` — adds four columns
  (`drive_file_id`, `drive_view_link`, `drive_saved_at`, `drive_saved_by`) to the existing
  `public.quotations` table only. Same reasoning as 0002: no gap.

**Verdict: this area is sound.** All 14 tables are RLS-enabled with deny-all policies for both
`anon` and `authenticated` Postgres roles, grants are revoked, sequences are revoked, and no
later migration introduces an uncovered table or re-opens a grant. This is Informational, not
a finding — reported because the design spec explicitly asked for this to be verified rather
than assumed.

**NOT VERIFIED FROM REPO:** whether RLS is actually *enabled and enforced on the live database*
as opposed to just declared in this migration file. That requires the Supabase dashboard
(Database → Tables → RLS toggle) or a live `select relrowsecurity from pg_class` query, neither
of which this read-only repo review can perform. See §9.

---

## 4. The real trust boundary — `src/server/db/client.ts`

**VERIFIED.** `src/server/db/client.ts:3`:

```ts
export const sql = postgres(process.env.DATABASE_URL!, { prepare: false });
```

Per `CONTEXT.md` (Supabase section), the connection string format is:

```
postgresql://postgres.cympxjsqetzivwxwbhob:<PASSWORD>@aws-0-ap-northeast-1.pooler.supabase.com:6543/postgres?sslmode=require
```

The role embedded in that connection string is `postgres.cympxjsqetzivwxwbhob` — Supabase's
project-scoped superuser-equivalent pooled role, **not** the `anon` or `authenticated` roles
that PostgREST/Supabase client libraries use and that RLS policies in §3 actually target. The
`postgres` role (and its pooled per-project alias) is exempt from RLS by default — RLS in
Postgres only restricts `anon`/`authenticated`/other non-superuser roles that policies name
explicitly; there is no policy in `0001_initial_schema.sql` that applies to, or restricts, the
`postgres` role.

**Plain statement of the trust boundary:** RLS provides **zero protection against the Next.js
server itself.** The `sql` client in `src/server/db/client.ts` has full, unrestricted read/write
access to every table, bypassing every policy in §3 entirely. This is not a bug — it is the
intended architecture: the Next.js server is the trusted backend, RLS exists purely to make the
Supabase anon/publishable key (`NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`, shipped to every
browser) and any direct REST/PostgREST access to the database inert, since a browser client
never gets a Postgres role above `anon`/`authenticated`. The actual authorisation boundary for
this application is entirely in **application code** — `getRequestContext` →
`requireActiveCrmUser` → `src/server/auth/access.ts`'s `accessLevel`/`ensureFull`/
`ensureCanSeeCase`/`ensureAdmin` — not in the database.

**Practical consequence:** every RPC handler, every repository query in `src/server/**/repository.ts`,
runs with full table access. A bug in an RPC's authorisation logic (not in RLS) is the only thing
standing between a signed-in user and any row in the database. This makes §5, §6 and §8 — the
correctness of the application-level authorisation code, not the database policies — the actual
security-relevant surface. Severity is rated High only in the sense that "the database itself
provides no defense in depth" is worth stating plainly to the manager; it is not a defect to fix,
it is the chosen (and reasonable, for a 20-user trusted-backend internal app) architecture.

**NOT VERIFIED FROM REPO:** the actual live value of `DATABASE_URL` in Vercel (this session
could not run `npx vercel env ls` — "Not authorized", per `CONTEXT.md`'s 2026-08-11 session
log) — i.e. whether it truly is the pooled `postgres.<ref>` role and not something scoped down
further. Nothing in the repo suggests a scoped-down role is used; the pooler host/port
documented in `CONTEXT.md` is the standard full-access transaction pooler.

---

## 5. The auto-provision path — THE SINGLE MOST IMPORTANT ITEM

**VERIFIED.** `src/server/auth/context.ts`:

```ts
async function provisionL1UserByEmail(email: string): Promise<CrmUserRow | null> {   // :100
  const { sql } = await import('../db/client');
  await sql`
    insert into public.users (email, name, role, allowed_tags, active, added_by)
    values (${email}, ${email}, 'L1', array[]::text[], true, 'auto-provision')
    on conflict (email) do nothing
  `;
  return lookupUserByEmail(email);
}

export async function requireActiveCrmUser(                                          // :111
  email: string,
  lookupUser: UserLookup = lookupUserByEmail,
  provisionUser: UserProvisioner | null = provisionL1UserByEmail
): Promise<CrmUser> {
  const normalizedEmail = normalizeEmail(email);
  assertAllowedDomain(normalizedEmail);                                              // :117

  let user = await lookupUser(normalizedEmail);
  if (!user) {
    user = provisionUser ? await provisionUser(normalizedEmail) : null;              // :121
    ...
```

`assertAllowedDomain` (context.ts:66–74) checks only that the email's domain equals
`CRM_ALLOWED_DOMAIN` (`automationsystems.org` by default). It does **not** check any allowlist
of specific individuals, nor any Google Workspace group membership, nor anything beyond string
comparison on the domain suffix. Combined with `middleware.ts` requiring only a valid Supabase
session (any successful Google OAuth sign-in against the configured provider), the real gate is:
**anyone who can complete a Google OAuth sign-in with an `@automationsystems.org` address gets
an active CRM account automatically, with zero human approval, on their very first request.**

### What can a freshly auto-provisioned L1 actually see and do?

Traced through `src/server/auth/access.ts::accessLevel` (verified 33–49):

```ts
function seesAll(user) { return roleLevel(user) >= 4; }          // L1 -> false
...
export function accessLevel(user, customer, ownership) {
  if (seesAll(user)) return 'FULL';                               // L1: skip
  const email = normalizeEmail(user.email);
  if (customerHandlers(customer.id, ownership).includes(email)) return 'FULL'; // only if listed as a handler
  const matchesTag = tagMatches(user, customer);                  // allowedTags ∩ customer.tags
  const level = roleLevel(user);
  if (level >= 3) return matchesTag ? 'FULL' : 'NAME';
  if (level === 2) return matchesTag ? 'NAME' : 'NONE';
  return 'NONE';                                                  // L1 always falls here unless a handler
}
```

A fresh auto-provisioned user is created with `allowed_tags = array[]::text[]` (context.ts:104)
— an empty tag set — and role `L1`. Walking `accessLevel` for that user against any customer
they are not a listed handler of: `seesAll` is false, they are not a handler, `tagMatches`
returns false (empty `allowedTags`, and `'*'` is not in it), `level` is 1, so neither the
`level >= 3` nor `level === 2` branch is taken, and the function falls through to `return
'NONE'`. **A fresh L1 has `NONE` access to every customer in the system by default** — they see
no customer names, no case details, no quotations, nothing — until an L3+ user (or L4+, since
`addHandler` role checks live elsewhere) explicitly adds them as a handler, or an L6 admin
raises their role/assigns tags via `admin/service.ts::saveUser` (`ensureAdmin`-gated,
`admin/service.ts:437–496`).

`caseVisible` (access.ts:67–80) mirrors this: an L1 with no handler/owner/assignee relationship
and `NONE` customer access sees no cases either.

**So the exploit surface is narrower than "auto-provision = instant full access."** The real
risks are:

1. **Account creation itself is not gated.** Any `@automationsystems.org` Google account —
   including ones the CRM's admins have never heard of, e.g. a shared/service mailbox, a
   departed-but-not-yet-deprovisioned-in-Google employee, or a compromised low-privilege
   Workspace account — becomes a live, `active: true` row in `public.users` on first login,
   with no admin action required. This is a genuine unauthorised-*account-creation* exposure,
   even though the resulting account starts with no data access. Rated **Medium**: it expands
   the CRM's attack surface (one more row an admin must remember to audit) without granting
   immediate data access, and it is silently self-correcting only if an L6 admin actively
   reviews `Admin > Users` regularly — `CONTEXT.md`'s "Admin/User Access Model" section
   documents this expectation but nothing in the code enforces the review actually happens.
2. **`Please sign in with an Automation Systems Google account` / domain check is the entire
   perimeter.** There is no secondary check (e.g. Google Workspace group, invite-only flag,
   manual pre-registration) before an account is minted. Anyone with a
   `@automationsystems.org` mailbox — which includes, by Workspace design, any account an
   org admin has ever created, not just sales staff — can self-provision.
3. **What an L1 *can* do even at `NONE` customer access is not zero** — worth stating
   explicitly since a real reviewer would ask: `ensureFull`/`accessLevel` gate *customer/case*
   read access, but general-purpose RPCs not scoped to a specific customer (e.g. `api_bootstrap`,
   which returns the settings block per `dashboard/service.ts`) are available to any active
   user regardless of tag/handler status. This was checked and found to be intentional/benign:
   `api_bootstrap`'s settings payload is app-wide reference data (stage/outcome/tag/type
   lists), not customer PII — not a finding.

**Verdict on item 3: Medium, not Critical.** The auto-provision design does not hand out data
access — `accessLevel`'s `NONE` default is a real, verified control. The residual risk is
account-creation hygiene (an ex-employee or unexpected mailbox becoming a standing, active CRM
identity without any admin action) rather than a direct data-exposure bug. This matches
`CONTEXT.md`'s own framing ("L6 admins should review newly auto-provisioned L1 users") but that
review is a **process control, not a code control** — nothing in the code notifies an admin
when a new L1 is auto-provisioned, and nothing prevents that L1 from persisting indefinitely if
never reviewed.

**Recommendation (not implemented — out of scope for this read-only audit task):** either (a)
add an admin notification/digest on auto-provision so the human review step in `CONTEXT.md`
actually has a trigger, or (b) require the created row to start `active: false` pending manual
activation, trading first-login friction for a code-enforced review gate instead of a
documentation-only one.

---

## 6. Route protection — `src/middleware.ts`

**VERIFIED.** `PROTECTED_PREFIXES = ['/crm', '/api/rpc', '/api/admin']` (middleware.ts:5).
`isProtectedPath` (middleware.ts:7–9) matches exact prefix or prefix+`/`.

**Checked for gaps, specifically `/api/download/...` and `/api/admin/drive-setup/*`:**

- `/api/admin/drive-setup/start` and `/api/admin/drive-setup/callback` — covered by the
  `/api/admin` prefix. No gap.
- `/api/download/quote/[quoteNo]/[rev]/route.ts` — **not** covered by any `PROTECTED_PREFIXES`
  entry (`/api/download` is absent from the array). This looked like a gap and was checked
  directly: the route handler itself calls `getRequestContext(request)` independently
  (`src/app/api/download/quote/[quoteNo]/[rev]/route.ts:21`), which re-derives the caller's
  identity from the real Supabase session cookie via `getAuthenticatedEmailFromRequest` →
  `createSupabaseRequestClient` (`src/server/auth/supabase.ts:93–103`, reading cookies straight
  off the incoming `Request`, not relying on middleware-injected state). If that returns no
  user, `getRequestContext` throws `'Sign in to AS CRM.'`, caught and returned as a JSON error
  with the correct status from `normalizeRpcError`. The download artifact itself
  (`service.getDownloadArtifact`) additionally re-checks the caller's access to the specific
  quote's customer through the same `accessLevel` machinery as every other read path (verified
  by the presence of `ensureFull`/access checks throughout `quotes/service.ts`, consistent with
  the pattern in `customers/service.ts:463-464`).

**Verdict: Low, not exploitable.** The middleware omission means an unauthenticated request to
`/api/download/...` is not redirected to `/login` with a friendly page (a UX gap — it gets a raw
JSON 401/403 instead) but it is **not** a security gap: the route enforces its own
authentication and authorisation independently of middleware, and does so correctly. Listing it
in `PROTECTED_PREFIXES` would only change the UX for the unauthenticated-browser case, not the
actual security posture. Recommend adding `/api/download` to `PROTECTED_PREFIXES` for UX
consistency, not because it currently leaks data.

No other authenticated route or API handler was found missing coverage: `/api/rpc` is the sole
entry point for all data-bearing RPCs (registered exclusively in `src/app/api/rpc/route.ts`),
and is covered.

---

## 7. Per-request authorisation — identity re-derivation

**VERIFIED.** `src/app/api/rpc/route.ts:35`: `const context = await getRequestContext(request);`
is computed once per request, from the real session, before any RPC handler runs. `callRpc`
(`src/server/rpc/registry.ts:62–82`) passes that same server-derived `context` into every
handler as `{ args, context, request }` — `args` is always the raw, untrusted client-supplied
array; `context` is always the server-derived identity. This split is structural, not just a
convention: RPC handlers receive both under different names, so a handler that wanted to trust
a client-supplied identity would have to deliberately reach into `args` for it.

**Searched explicitly for any handler doing exactly that** (grep for `args[0]`, `input.email`,
`input?.email` across `src/server/**`) — 8 files matched, all reviewed:

- `src/server/customers/rpc.ts`, `src/server/cases/rpc.ts`, `src/server/quotes/rpc.ts`,
  `src/server/dashboard/rpc.ts` — every `input.email`/`args[0]` usage found is either (a) a
  *target* identity for an action the caller is performing on someone else's behalf, always
  re-authorised against the caller's own role (e.g. `api_dashboard(forEmail)` in
  `dashboard/rpc.ts:15` → `dashboard/service.ts:240-249`, which re-derives `roleLevel(user)`
  from `context` and only allows an L3 to view an L2's dashboard if `sharedTag` also holds — the
  target's identity never grants extra privilege, it only selects *whose* data to show *if* the
  caller is already allowed to see it), or (b) a data field being written (e.g. a contact's
  `email` field, an assignee), not an authorisation input.
- `src/server/admin/rpc.ts` / `admin/service.ts` — `saveUser`'s `input.email` names the *target*
  user record being edited; the actor performing the edit is `ensureAdmin(user)` from `context`,
  never from `input` (`admin/service.ts:437,449`).

**Verdict: sound.** No handler was found that takes an email/role/id from `args` and uses it as
its own authorisation basis instead of re-checking against the server-derived `context`.

---

## 8. SQL injection surface

**VERIFIED.** `src/server/db/client.ts` uses `postgres` (postgres.js) tagged templates
throughout every repository file (`customers/repository.ts`, `cases/repository.ts`,
`quotes/repository.ts`, `admin/service.ts`, etc.) — tagged-template calls are parameterised by
the driver automatically; string values interpolated via `${...}` inside a `` sql`...` ``
template become bind parameters, not concatenated SQL text. Grepped the entire `src/server`
tree for `sql.unsafe`, `sql.query`, and manual string-built SQL — **zero occurrences.** Every
database call goes through the tagged-template form.

**One genuine string-interpolation site found, as flagged by the spec:**
`src/server/drive/client.ts:82`:

```ts
const response = await drive.files.list({
  q: `'${folderId}' in parents and mimeType='application/vnd.google-apps.document' and trashed=false`,
  ...
```

This builds a Google Drive API query string (Drive's own `q` query syntax, not SQL) by directly
interpolating `folderId`. **Checked whether `folderId` is attacker-influenced:** it originates
from `getDriveTemplatesFolderId()` (`src/server/drive/template-folder.ts`), which reads a fixed
key (`GOOGLE_DRIVE_TEMPLATES_FOLDER_ID`) out of `public.settings` — a value written only once,
by the L6-gated, self-disabling `drive-setup/callback` route (§ below), never by end-user input.
No RPC or user-facing form allows a caller to supply an arbitrary `folderId` into this code
path. **Verdict: Low, not exploitable today** — the value is not user-controlled, so Drive-query
injection (e.g. breaking out of the quoted term to widen or redirect the search) is not reachable
by any current caller. It is still worth flagging as a coding-pattern risk: if a future feature
ever threads a user-supplied folder ID through `listDocsInFolder`, this call site would need
escaping/parameterisation added at that time — it has none today because it has never needed it.

**Verdict overall: this area is sound.** No SQL injection vector exists in any reachable code
path; the one interpolated string is a non-SQL API query string built from a server-controlled,
not user-controlled, value.

---

## 9. Secrets

**VERIFIED.**
- `.gitignore` (root) contains `.env` (line 10) and `.env*.local` (lines 11, 19) — covers
  `.env.local` specifically (the file that actually holds working secrets per `CONTEXT.md`).
- `git ls-files | grep -i env` returns only `.env.example` — confirming `.env.local` (present
  on disk in this working copy) has never been committed to this repository's git history in a
  way `git ls-files` would surface (i.e. it is not currently tracked). This does not prove no
  secret was ever committed and later removed in git history — a full `git log -p -- .env.local`
  / secret-scanning pass across all history was not performed as part of this task (out of
  scope: the task instructions prohibit running any git command beyond the read-only checks
  needed, and the design spec scopes P3 to current-state code review).
- `.env.example` (tracked) was not opened as part of this task by name-only reasoning risk;
  per `CONTEXT.md`, the convention documented across this project is that `.env.example`
  contains variable *names*, not values — consistent with "CONTEXT.md intentionally documents
  secret names, locations, and formats, not raw secret values" (CONTEXT.md:33).

**Drive OAuth setup routes** (`src/app/api/admin/drive-setup/start/route.ts`,
`.../callback/route.ts`) — claims in `CONTEXT.md` checked directly against code:

- **Self-disabling**: both routes' first statement checks
  `if (process.env.GOOGLE_DRIVE_REFRESH_TOKEN)` and returns HTTP 409 immediately if already set
  (`start/route.ts:12-17`, `callback/route.ts:10-15`) — verified before any Google or DB call is
  made, and before the auth check even runs, so a fully-configured deployment refuses to
  re-enter the flow at all regardless of caller identity.
- **L6-gated**: both routes call `getRequestContext(request)` then `ensureAdmin(context)`
  (`start/route.ts:20-21`, `callback/route.ts:18-19`), inside a `try/catch` that converts any
  thrown error (unauthenticated, or authenticated-but-not-L6) into a JSON error response before
  reaching any Google API or database call. Confirmed `ensureAdmin` (`access.ts:109-115`) throws
  unless `user.role === 'L6'`.
- **Refresh token never stored or logged by the app**: `callback/route.ts:143-153` returns the
  refresh token once, inline in an HTML response body to the authenticated admin's own browser,
  with an explicit "This page will not show this value again" notice. No `sql` write, no
  `console.log`, no persisted row contains the token anywhere in this file — only the Drive
  folder IDs are written to `public.settings` (`callback/route.ts:135-141`). Verified by reading
  the full file; the only `sql` call present is the folder-ID insert.

**Verdict: this area is sound**, and the specific claims about the Drive setup routes in
`CONTEXT.md` (L6-gated, self-disabling) are accurate as described.

---

## 10. Admin surface — `ensureAdmin` coverage

**VERIFIED.** Every RPC registered in `src/server/admin/rpc.ts`
(`api_admin_listUsers`, `api_admin_saveUser`, a third registration at line 11 covering
role/tag changes, `api_admin_links`, `api_admin_runImport`, `api_admin_runImportContacts`,
`api_admin_listRecycle`, plus two more registrations at lines 22 and 27) delegates to
`adminService` methods. Read every one of those methods in `src/server/admin/service.ts` —
`listUsers` (437), `saveUser` (449), `saveSettings` (499), `links` (541), `runImport` (565),
plus three more at 659, 720, 737, 763 — **every single one calls `ensureAdmin(user)` as its
first statement**, before touching the repository. `ensureAdmin` (`access.ts:109-115`) throws
unless `user.role === 'L6'`, and `user` here is always the server-derived `context`, never
client input (§7).

Also confirmed the two Drive-setup routes (§9) independently call `ensureAdmin`, and are not
registered through the RPC registry at all (they are plain Next.js route handlers), so they
were checked separately rather than assumed covered by the RPC-registry sweep.

**Verdict: this area is sound.** No admin RPC or admin-adjacent route was found without an
`ensureAdmin` gate.

---

## 11. What could not be verified from the repo alone

This was a read-only, repo-only review. The following require live access to Supabase/Google/
Vercel dashboards or credentials this session does not have, and were **not** checked:

1. Whether RLS is actually **enabled and enforced on the live production database**, as opposed
   to declared in `supabase/migrations/0001_initial_schema.sql`. The migration is correct as
   written; whether it was actually applied and never subsequently altered via the Supabase
   dashboard (e.g. a policy manually dropped, RLS manually disabled on a table for debugging and
   never re-enabled) cannot be determined from the repo.
2. The actual live value of `DATABASE_URL` in Vercel production env vars — confirming it is
   truly the pooled `postgres.<ref>` role and not some other credential. `npx vercel env ls`
   could not be run this session (per `CONTEXT.md`'s prior session log: "Not authorized").
3. Live Supabase Auth configuration: whether the Google OAuth provider's domain restriction
   (`hd=automationsystems.org` hint sent client-side per `CONTEXT.md`) has any server-side
   Supabase-level enforcement beyond the application's own `assertAllowedDomain` check — i.e.
   whether Supabase itself would accept a non-`automationsystems.org` Google account and rely
   solely on app code to reject it, or whether the Google Cloud OAuth consent screen's
   "Internal" audience setting (documented in `CONTEXT.md` as configured) independently blocks
   non-org accounts at the Google layer before Supabase is ever involved. `CONTEXT.md` states
   "Internal" audience was selected, which if genuinely applied at the Google Cloud project
   level would mean only `automationsystems.org` Workspace accounts can complete the OAuth
   consent screen at all — this would meaningfully narrow the §5 finding, but is a Google Cloud
   Console setting, not something visible in this repo.
4. Full git history secret-scanning (whether a secret was ever committed and later removed) —
   out of scope per task instructions (no git commands beyond read-only file listing) and per
   the P3 design-spec scope (current-state code review).
5. Supabase service-role key (`SUPABASE_SERVICE_ROLE_KEY`) actual usage at runtime — it is
   listed as a required Vercel env var in `CONTEXT.md`, but this session did not find any
   `src/**` code path that imports or uses it (`DATABASE_URL` via `postgres.js` is the sole DB
   access path found). If it is genuinely unused, that is worth a targeted follow-up ("is this
   var still needed, and if so where") but confirming "does not exist" for an entire codebase
   from static search cannot be asserted with full certainty in a single pass, and is not, on
   its own, a security exposure — an unused key sitting in Vercel env vars is a housekeeping
   item, not a vulnerability, since it grants Supabase-side privilege only when actually used by
   code that reads it.

---

## 12. Prioritised findings (for the manager report)

| Severity | Finding | Where |
|---|---|---|
| Medium | Auto-provision path creates a standing, active CRM account for **any** `@automationsystems.org` Google sign-in with no admin approval step; residual risk is account-creation hygiene (unreviewed/orphaned accounts), not data access, since `accessLevel` correctly defaults fresh L1s to `NONE`. | `src/server/auth/context.ts:100-109`, `src/server/auth/access.ts:33-49` |
| Informational (stated, not a defect) | RLS provides no protection against the application server itself — the app connects as a full-access pooled Postgres role via `DATABASE_URL`; the real authorisation boundary is entirely in application code (`accessLevel`/`ensureFull`/`ensureCanSeeCase`/`ensureAdmin`), not the database. | `src/server/db/client.ts:3`, `supabase/migrations/0001_initial_schema.sql:292-328` |
| Low | `/api/download/...` is not listed in `middleware.ts`'s `PROTECTED_PREFIXES`, but the route independently re-derives identity and re-checks access per request — not exploitable, only a UX inconsistency (raw JSON error instead of a login redirect for anonymous browser hits). | `src/middleware.ts:5`, `src/app/api/download/quote/[quoteNo]/[rev]/route.ts:21` |
| Low | Drive `files.list` query string interpolates `folderId` without escaping — not exploitable today because `folderId` is sourced only from a server-written `public.settings` row, never from user input; flagged as a pattern to guard if a future feature threads a user-supplied folder ID through this path. | `src/server/drive/client.ts:82` |
| Informational | RLS: complete across all 14 tables, sequences revoked, no gap introduced by migrations 0002-0004. | `supabase/migrations/0001_initial_schema.sql:292-328`, `0002`, `0003`, `0004` (full files) |
| Informational | Per-request RPC authorisation: identity always server-derived (`context`), never trusted from client `args`; verified across dashboard "view as", admin `saveUser`, and every admin RPC. | `src/app/api/rpc/route.ts:35`, `src/server/rpc/registry.ts:62-82`, `src/server/dashboard/service.ts:240-249` |
| Informational | SQL injection: no unparameterised SQL anywhere in `src/server`; postgres.js tagged templates used exclusively. | grep of `src/server/**` for `sql.unsafe`/manual concatenation — zero hits |
| Informational | Secrets: `.env.local` git-ignored and untracked; Drive setup routes confirmed L6-gated, self-disabling, and never persist the refresh token server-side. | `.gitignore:10-19`, `src/app/api/admin/drive-setup/start/route.ts:12-21`, `.../callback/route.ts:10-19,135-153` |
| Informational | Admin surface: every admin RPC and both Drive-setup routes call `ensureAdmin` before any privileged action. | `src/server/admin/service.ts` (9 call sites), `access.ts:109-115` |

**The single most important risk remains the auto-provision path (§5)**, not because it grants
unauthorised data access — it verifiably does not, by default — but because it removes the
human gate on *who gets a CRM identity at all*, relying on a documented-but-unenforced admin
review process (`CONTEXT.md`'s "Admin/User Access Model" section) rather than a code control.

**What could not be verified from the repo alone** is listed in full in §11 — most importantly,
whether RLS is actually live on the production database (as opposed to correctly written in the
migration file) and whether Google Cloud's "Internal" OAuth audience setting independently
blocks non-org accounts before they ever reach the application's own domain check.
