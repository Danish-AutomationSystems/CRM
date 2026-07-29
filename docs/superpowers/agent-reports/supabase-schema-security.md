# Supabase Schema and Security Recommendations

Scope: AS CRM migration from Apps Script/Sheets to Vercel + Supabase. Source reviewed: project context, functionality reference, `Code.gs`, and the Vercel/Supabase migration design.

## Summary

Preserve the Apps Script posture: every CRM data request must go through server-side code that re-derives the signed-in email, loads the active CRM user, computes level/tags/handler/case access, and authorizes the specific operation. Supabase RLS should be enabled as a defense-in-depth deny-by-default layer, not the primary expression of the full L1-L6 permission model.

Highest-risk migration areas:

- Customer access must not be widened by case assignment. Ticket assignment grants case visibility only.
- Quote number/revision creation must be transactional, including superseding prior Draft/Sent revisions.
- Customer delete/restore/purge must be atomic so no cases or quotations become orphaned.
- Customer create/import must avoid accidental duplicate races without blocking the explicit duplicate-override behavior.
- Grid patch writes must not overwrite fields outside the submitted patch or fields the caller is not allowed to edit.

## Recommended Schema Constraints

### Global

- Use `timestamptz` for event timestamps and default to `now()`.
- Store user-visible CRM IDs as `text` primary keys: `CUST-0001`, `CT-0001`, `CASE-2026-0001`, `QTN-2026-0001`.
- Add `created_at`, `updated_at`, and optional `version bigint not null default 1` to mutable tables for optimistic conflict checks.
- Enforce lowercase emails with either generated normalized columns or `check (email = lower(email))`.
- Add `check (btrim(text_col) <> '')` for required names/titles.
- Use `numeric(14,2)` for money fields and percentage fields with non-negative checks.
- Preserve pipe-delimited display/import semantics for `won_categories`, `extra_owners`, and action assignees if stored as text. If arrays are used internally, API import/export must reproduce exact pipe behavior.

### Users

- `users.email primary key`
- `check (email like '%@automationsystems.org')`
- `check (role in ('L1','L2','L3','L4','L5','L6'))`
- `active boolean not null default true`
- Represent allowed tags as `text[]` or normalized `user_allowed_tags`; enforce that `'*'` is either absent or the only allowed tag.
- Prevent the last active L6 admin from being deactivated or demoted in a server transaction or deferred trigger.

### Customers

- `customers.customer_id primary key`
- `name text not null check (btrim(name) <> '')`
- `status text not null default 'Active' check (status in ('Active','Archived'))`
- Store tags as `text[]` or a child table. If the product remains single-tag in practice, keep the API tolerant of lists because Apps Script uses `parseList_`.
- Add a generated `name_key` such as `lower(regexp_replace(btrim(name), '\s+', ' ', 'g'))` and index it for search/duplicate detection.
- Do not add a hard unique constraint on `name_key` unless the explicit duplicate override is redesigned. Use transaction-level advisory locks on `name_key` in normal create, quick-log, bulk import, and admin import to prevent accidental concurrent duplicates.
- Index `status`, `name_key`, tags, `area`, `type`, `priority`, `sei`, and `remarks` according to search/filter usage.

### Handlers

- `handlers(customer_id, user_email) primary key`
- FK `customer_id references customers(customer_id) on delete cascade`
- `user_email` should normally FK to `users(email)`. The `Direct` placeholder should be modeled explicitly, preferably with nullable `user_email` plus `is_direct boolean`, or with a check allowing only `lower(user_email) = 'direct'` to bypass the FK.
- Enforce one `Direct` placeholder per customer and remove it in the same transaction that adds the first real handler.
- Add an index on `user_email` for "my customers" and ownership calculations.

### Contacts

- `contacts.contact_id primary key`
- FK `customer_id references customers(customer_id) on delete cascade`
- `name text not null check (btrim(name) <> '')`
- Preserve phone/GSTIN as text, not numeric.
- Index `customer_id`.

### Cases

- `cases.case_id primary key`
- FK `customer_id references customers(customer_id)`
- `title text not null check (btrim(title) <> '')`
- `stage text not null check (stage in ('Lead','Opportunity','Quoted'))`
- `outcome text check (outcome is null or outcome in ('Won','Lost','Hold'))`; normalize blank to `null`.
- `order_value numeric(14,2) check (order_value is null or order_value >= 0)`
- `assignee text references users(email)` nullable.
- `created_by text references users(email)`, `owner text references users(email)` as creator/fallback only.
- If `outcome = 'Won'`, enforce `order_value > 0` and non-empty `won_categories`.
- If `outcome in ('Won','Lost')`, enforce `closed_on is not null` and `assignee is null`.
- If `outcome = 'Hold'`, enforce `closed_on is null`.
- Add indexes on `customer_id`, `assignee`, `outcome`, `stage`, `updated_at`, and `closed_on`.

### Case Extra Owners

Prefer a normalized table instead of pipe text:

- `case_extra_owners(case_id references cases(case_id) on delete cascade, user_email references users(email), primary key(case_id, user_email))`
- The application must prevent adding a handler owner as an extra owner and must allow only current owners or L4+ to mutate extras.

### Quotations and BOQ

- `quotations(quote_no, rev) primary key`
- FK `case_id references cases(case_id)` nullable only if behavior requires it; current flows create or use a case.
- FK `customer_id references customers(customer_id)`
- `status text not null check (status in ('Draft','Sent','Superseded'))`
- `source text not null check (source in ('Generated','External'))`
- `rev integer not null check (rev >= 0)`
- Money fields `subtotal`, `tax_pct`, `tax_amount`, `total` non-negative where present.
- Add partial indexes on active revisions: `where status in ('Draft','Sent')`.
- `quote_boq(quote_no, rev, block) primary key`, FK `(quote_no, rev) references quotations(quote_no, rev) on delete cascade`
- `headers jsonb not null check (jsonb_typeof(headers) = 'array')`
- `rows jsonb not null check (jsonb_typeof(rows) = 'array')`
- `block integer not null check (block > 0)`

### Recycle Bin, Settings, Counters, Activity, Imports

- `recycle_bin.customer_id primary key`; keep it as a snapshot table with deleted metadata.
- `settings.key primary key`, `value text not null`; validate known numeric settings such as `TAX_PCT` in application code or a settings update function.
- `counters.key primary key`, `last bigint not null check (last >= 0)`.
- `activity_log` should be append-only from server/service role. Index `customer_id`, `entity`, `created_at desc`, and `who`.
- Import staging tables should carry `import_batch_id`, `row_no`, `status`, and `error` so import runs are auditable and repeatable.

## RLS Posture

Enable RLS on every CRM table.

Recommended default:

- Browser Supabase client: only auth/session operations. No direct CRM table access.
- CRM server routes/actions: use a server-only Supabase client or RPC layer. All operations call authorization helpers before querying/mutating CRM data.
- Service role key must be server-only and never exposed to the browser.
- RLS should deny anonymous users and deny direct client table reads/writes.

Minimum RLS policies:

- `authenticated` users may read only their own auth-facing profile view, if such a view exists.
- CRM base tables should reject direct `select/insert/update/delete` from browser roles.
- Server RPC functions may run as `security definer` only if they internally resolve `auth.uid()`/email and re-check CRM user status. Keep function search paths pinned.
- Admin-only setup/import/restore/purge RPCs must require active L6.
- Activity log insert should be server-only; user-supplied `who` must not be trusted.

Optional stronger posture:

- Add read-only security-barrier views for limited customer search and case lists, but keep write permissions in server functions.
- Mirror coarse RLS predicates for common reads: active CRM user, domain email, active account, L4+ all-access, handler full customer access, and case assignee/extra-owner visibility. Treat these as backup controls, not as the only enforcement.

Critical RLS/business-rule cautions:

- Do not express "assignee can see customer" in RLS. Assignee visibility is case-only.
- Do not expose contacts, all customer details, quotations, or customer history through name-only customer search.
- Do not let client-supplied role, tags, handler arrays, owner lists, or permission flags influence policies.

## Transaction Boundaries

Implement these operations as single Postgres transactions, preferably RPC functions called by server code:

- ID allocation: lock/update `counters` with `select ... for update`, increment, and return the formatted ID in the same transaction that inserts the target row.
- Customer create: advisory-lock normalized name, allocate ID, insert customer, insert initial handler (`Direct` for L5/L6, creator for L2-L4), optional first contact, and activity log.
- Quick log: advisory-lock new customer name when needed, create/reuse customer, create case, and log both records atomically.
- Bulk/admin customer import: process each row in a transaction or use per-row savepoints; advisory-lock normalized names; skip duplicates deterministically; insert handlers/contact with the customer.
- Contact CRUD: verify full customer access and mutate the contact in one transaction.
- Handler add/remove: verify caller is L3+ or current handler, validate active target user, delete `Direct` placeholder, insert/delete handler, and log.
- Case create/direct order: verify L2+ and full customer access, validate assignee, enforce Won requirements, allocate ID, insert case, and log.
- Case stage/outcome transitions: lock the case row `for update`, re-check visibility, enforce current outcome rules, update fields, and log.
- Ticket reassignment: lock the case row `for update`, require no outcome, validate active target user, update assignee, and log.
- Extra owner add/remove: lock case, re-check current ownership, validate active target, update normalized owner rows, and log.
- Quote create/revision: lock quote number family or use an advisory lock on quote number, compute next revision, supersede prior Draft/Sent revisions, create case if needed, insert quotation and BOQ blocks, and log.
- Quote status Sent: lock quote and case rows, update quote status, advance case to Quoted only if open and stage order increases, then log.
- Generated document metadata update: update quotation doc/pdf metadata and log atomically. In the new design this may become generated-file audit metadata rather than Drive links.
- Customer soft delete: lock customer, verify full access and L3+, verify no cases/quotations exist, copy snapshot to recycle bin, delete contacts/handlers/customer, and log.
- Restore/purge: L6-only transaction; restore must ensure the live customer ID is absent before moving the snapshot back.
- Settings/user updates: L6-only; validate list contents, self-demotion/deactivation, and last-active-L6 protection in transaction.

## Race-Condition Tests

Minimum concurrency tests for the migration:

- 50 parallel `allocateId('CUST')` calls return unique sequential IDs with no gaps caused by committed successes.
- Parallel customer creates with the same normalized name: one normal create succeeds and the other receives duplicate warning/skip; explicit force behavior still works as designed.
- Parallel quick-log requests for the same new customer name create one customer and two cases against it, unless explicit duplicate creation is requested.
- Parallel bulk/admin imports containing duplicate names across batches create one customer per normalized name and mark the rest skipped.
- Parallel handler adds for the same `(customer_id, user_email)` produce one handler row and one clean duplicate response; `Direct` is removed exactly once.
- Handler removal racing with case owner add/remove cannot leave handler owners duplicated as extra owners.
- Parallel case creation under the same year returns unique `CASE-yyyy-nnnn` IDs.
- Two users reassign the same open ticket concurrently: final assignee is one valid active user and no stale closed-case reassignment is accepted.
- Reassign racing with marking Won/Lost/Hold: if outcome commits first, reassignment fails; if reassignment commits first, Won/Lost clears assignee and Hold keeps the latest assignee.
- Stage change racing with Hold: moving stage from Hold clears Hold only when the locked current row is still held.
- Two quote revisions from the same base quote concurrently produce unique revision numbers and supersede all prior Draft/Sent revisions without superseding the newly committed latest revision.
- Quote Sent racing with case Won/Lost/Hold: Sent advances to Quoted only if the locked case is still open and not already beyond Quoted.
- Customer soft delete racing with case/quote creation: either delete commits first and case/quote creation fails because customer is absent, or case/quote commits first and delete is skipped/blocked.
- Restore racing with new customer creation using the recycled ID fails one side cleanly, never producing duplicate live IDs.
- Grid patch racing with another field update modifies only submitted, authorized fields and preserves unrelated columns.
- Grid patch with stale `version` returns conflict instead of silently overwriting when the same field changed after the client's snapshot.
- L2 matching-tag search-only user cannot open details, edit customer, create contact/case/quotation, or see contacts through any endpoint.
- Case assignee who is not a handler can read and mutate that visible case according to case rules, but cannot read customer details, contacts, other cases, or quotations for the customer.
- Inactive or unregistered Google-domain user is rejected even with a valid Supabase session.
- Non-`automationsystems.org` Google user is rejected before CRM authorization.

## Implementation Notes For Migrators

- Keep access helpers small and heavily tested: `loadCurrentUser`, `customerAccessLevel`, `canSeeCase`, `ensureFullCustomerAccess`, `requireLevel`, `resolveActiveUser`.
- Prefer SQL constraints for invariants that are always true; keep dynamic settings-list membership in application code unless settings are normalized into reference tables.
- Keep server route tests close to the Apps Script behavior names so API parity checks remain possible.
- Treat RLS failures as security successes in tests: direct browser-role table reads/writes should fail unless explicitly routed through approved views/RPC.
