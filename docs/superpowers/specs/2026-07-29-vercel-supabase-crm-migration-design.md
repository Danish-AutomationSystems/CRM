# Vercel Supabase CRM Migration Design

**Goal:** Rebuild AS CRM from the current Google Apps Script implementation into a Vercel-hosted, Supabase-backed application with the same user-facing features, same access rules, same business behavior, and lower perceived latency.

**Source of truth:** The migrated app must match the behavior documented and implemented in:
- `docs/source-appscript/AS_CRM_PROJECT_CONTEXT.md`
- `docs/source-appscript/AS_CRM_FUNCTIONALITIES.md`
- `docs/source-appscript/SETUP_GUIDE.md`
- `docs/source-appscript/Code.gs`
- `docs/source-appscript/Index.html`

**Approved product decision:** Google Drive upload/storage is excluded for this migration. Invoice and quotation buttons download generated files directly to the user's computer.

## Architecture

The app will be a Next.js application deployed on Vercel. Supabase will provide Google OAuth authentication and Postgres storage. The browser may hold a Supabase Auth session, but CRM data reads and writes must go through server-side application code so that every request re-derives identity and permissions just like the Apps Script server does today.

```text
Browser
  -> Vercel Next.js UI
  -> Next.js server routes/actions
  -> Supabase Auth for identity
  -> Supabase Postgres for CRM data
```

The migrated code should preserve the important Apps Script architecture principle: nothing trusted from the client decides access. Each server operation loads the authenticated email, resolves the CRM user row, derives level/tags/active state, and checks the requested entity against the access matrix.

## Authentication

Authentication must use Supabase Auth with Google sign-in restricted to `automationsystems.org`.

Rules:
- Only Google OAuth sign-in is supported for CRM users.
- Any signed-in email outside `automationsystems.org` must be rejected by the app.
- A valid Google session is not enough to use the CRM. The email must exist in the CRM `users` table and must be active.
- Roles, allowed tags, names, and active/inactive state remain CRM-admin managed, not Google-admin managed.
- The first production admin can be seeded through a server-side setup command or migration script.

## Database Model

Supabase Postgres tables must map to the current sheet tabs:

```text
users
customers
contacts
handlers
cases
actions
quotations
quote_boq
recycle_bin
settings
counters
activity_log
import_customers
import_contacts
```

The `actions` table remains in the schema even though follow-ups are removed from the current UI. This preserves the current Apps Script decision that the module can return later without a schema reset.

Postgres types should be explicit and conservative:
- Store primary CRM IDs as text where existing IDs are user-visible (`CUST-0001`, `CASE-2026-0001`, `CT-0001`, `QTN-2026-0001`).
- Store dates as `timestamptz` where they represent an event time.
- Store settings values as text unless a value has a stable numeric meaning.
- Store quote BOQ headers and rows as `jsonb`.
- Preserve pipe-delimited semantics where the product behavior depends on it, especially won categories and action assignees. Internally, arrays may be used only if all import/export and display behavior remains identical.

Required uniqueness:
- `users.email`
- `customers.customer_id`
- `contacts.contact_id`
- `cases.case_id`
- `quotations(quote_no, rev)`
- `quote_boq(quote_no, rev, block)`
- `settings.key`
- `counters.key`

## Authorization

The following Apps Script rules must be preserved exactly.

Customer visibility:
- L4-L6 users have full access to all customers.
- L3 users have full access to customers matching their tags, search-only/name access otherwise.
- L2 users have search-only/name access to matching tags and no access to non-matching tags unless they are a handler.
- L1 users have no customer browsing access unless they are a handler.
- Being a customer handler grants full access to that customer.
- Ticket assignment does not grant customer record access. It grants access to that case only.

Case visibility:
- Case owners, the current assignee, extra owners, users with full customer access, and L4+ users can see the case.
- Anyone who can see an open case can reassign its ticket.
- Reassignment stops when any outcome is set: Won, Lost, or Hold.

Write authorization:
- Every write path must run a server-side authorization check.
- Contacts, handlers, cases, quotations, customer updates, and delete/restore/purge must not trust hidden form fields or client-derived permission flags.
- Admin APIs are L6 only.

Row Level Security must be enabled as a second safety layer, but the primary CRM permission model lives in server-side application code because it has complex role, tag, handler, and case-visibility logic.

## Feature Parity

The migrated CRM must include these current modules:

- Dashboard by user level:
  - L1 ticket list only.
  - L2-L4 personal stats and assigned opportunity tickets.
  - L5-L6 back-office overview with no personal sales dashboard.
  - L3+ read-only dashboard viewing according to the current rules.
- Customers:
  - Search-first creation.
  - Customer search capped at 80.
  - My customers grid for L1-L4.
  - All customers fetch for L5-L6.
  - Inline editable grid with debounced saves and rollback on failure.
  - Filters for name, tag, type, priority, area, SEI, remarks, contacts, and handlers as applicable.
  - Contact CRUD and bulk contact import.
  - Handler add/remove by username with `@automationsystems.org` appended server-side.
  - Direct handler placeholder for L5/L6-created customers until a real handler is added.
  - Soft delete to recycle bin, blocked when cases or quotations exist.
- Cases:
  - Create Lead, Opportunity, or direct Won order.
  - Owners are derived from customer handlers plus removable extra owners.
  - Assignee is a single active CRM user.
  - Any active CRM user can hold a ticket.
  - Stage/outcome rules match Apps Script.
  - Won requires order value greater than zero and at least one category.
  - Won and Lost clear assignee.
  - Hold keeps assignee but freezes reassignment.
  - Changing stage on held case clears Hold.
- Quotations:
  - Quote numbers and revisions follow the existing format.
  - Draft, Sent, and Superseded are the only statuses.
  - New revision supersedes prior Draft/Sent revisions.
  - Draft quote does not advance the case.
  - Marking Sent advances open case to Quoted.
  - Uploaded quotation storage is replaced by direct local download behavior for generated artifacts where applicable.
  - Generated quotation and invoice downloads must be available from the UI.
  - BOQ subtotal remains manually entered, never computed from pasted cells.
  - BOQ supports multiple titled pasted tables with first row as headers.
- Admin:
  - User management.
  - Settings/lists/defaults.
  - Customer import.
  - Contact import.
  - Recycle bin restore and purge.
  - Activity log retained.

## Performance

The migrated app should remove Apps Script fixed call overhead while preserving the current perceived-speed strategy:

- Bootstrap should fetch identity, settings, navigation, peers, dashboard, recent activity, and initial workspace data with as few round trips as practical.
- Views should render from client cache immediately after first load.
- Mutations should be optimistic only where rollback behavior is implemented.
- Customer grid edits should be batched/debounced to avoid excessive writes.
- List endpoints must keep caps:
  - search results: 80
  - case list: 300
  - customer grid: 400
  - import rows per run: 500
  - dashboard lists: 60

## Race Condition Controls

The Apps Script implementation used `LockService` for ID allocation and quote creation. The migration must replace that with database-safe operations:

- ID allocation must be transactional and collision-free under concurrent requests.
- Quote revision creation and prior revision superseding must happen inside one transaction.
- Customer delete must atomically verify no cases/quotations exist before moving to recycle bin.
- Imports must avoid duplicate customer creation under concurrent runs.
- Grid patch writes must update only allowed fields and must not overwrite unrelated fields changed by another user.

## Testing Strategy

Implementation must follow test-driven development for application logic.

Minimum test coverage:
- Access matrix for L1-L6, matching tags, non-matching tags, handlers, assignees, and extra owners.
- Case visibility and ticket reassignment rules.
- Case stage/outcome transitions.
- Customer search/create duplicate guard.
- Customer grid patch authorization.
- Soft delete, restore, and purge rules.
- ID allocation under concurrent requests.
- Quote creation, revision superseding, and Sent case advancement.
- Import parsing and duplicate behavior.
- Google-domain restriction and inactive/unregistered user rejection.
- API parity coverage against the current Apps Script API names and UI flows.

Verification commands must include:
- unit tests
- integration tests for server/database logic
- lint/typecheck
- production build
- at least one browser-level smoke test for login-gated app shell and critical routes

## Deployment

Vercel will host the app. Environment variables must be configured in Vercel and `.env.local` for local development.

Browser-safe:

```env
NEXT_PUBLIC_SUPABASE_URL=https://cympxjsqetzivwxwbhob.supabase.co
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=...
```

Server-only:

```env
SUPABASE_SECRET_KEY=...
DATABASE_URL=...
SUPABASE_DB_PASSWORD=...
```

Secrets must not be committed. The credentials pasted during setup must be rotated before production launch.

## Out Of Scope

- Google Drive upload/storage.
- Email sending.
- Order execution workflow after order won.
- Accounting.
- Reintroducing follow-ups/actions into the UI.
- Changing the approved L1-L6 permission model.
- Recreating removed fields such as customer Industry or case EstValue.

## Approval

The user approved this direction on 2026-07-29 and requested a safe, exact migration using Vercel, Supabase, test-driven development, parallel/subagent review, and Google sign-in restricted to `automationsystems.org`.
