# Vercel Supabase CRM Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a Vercel-hosted, Supabase-backed AS CRM that preserves the current Apps Script CRM behavior while reducing latency.

**Architecture:** Keep the current single-page CRM interaction model and replace `google.script.run` with a Vercel RPC route. Implement the former Apps Script `api_*` functions as typed server handlers backed by Supabase Postgres. Use Supabase Auth for Google sign-in restricted to `automationsystems.org`; keep CRM roles/tags/active state in the `users` table.

**Tech Stack:** Next.js, TypeScript, Supabase Auth, Supabase Postgres, `postgres` SQL client, Zod, Vitest, Playwright, Vercel CLI.

## Global Constraints

- Exact source behavior comes from `docs/source-appscript/AS_CRM_PROJECT_CONTEXT.md`, `docs/source-appscript/AS_CRM_FUNCTIONALITIES.md`, `docs/source-appscript/SETUP_GUIDE.md`, `docs/source-appscript/Code.gs`, and `docs/source-appscript/Index.html`.
- Google sign-in is restricted to `automationsystems.org`.
- The CRM `users` table remains authoritative for L1-L6 role, allowed tags, active state, and display name.
- Browser code must not receive `SUPABASE_SECRET_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `DATABASE_URL`, or `SUPABASE_DB_PASSWORD`.
- Google Drive upload/storage is out of scope. Invoice and quotation buttons download generated files directly to the user's computer.
- Follow-ups/actions remain absent from the UI, but the `actions` table remains in the database schema.
- Preserve existing caps: customer search 80, case list 300, customer grid 400, import 500 rows/run, dashboard lists 60.
- Preserve existing visible IDs: `CUST-0001`, `CT-0001`, `CASE-2026-0001`, `ACT-00001`, `QTN-2026-0001`.
- Preserve current semantics for pipe-delimited lists where behavior depends on it.
- Use TDD for production logic: write failing tests, verify failure, implement, verify pass.
- Each server handler must re-derive identity and permissions server-side.

---

### Task 1: Project Scaffold And Local Configuration

**Files:**
- Create: `package.json`
- Create: `next.config.ts`
- Create: `tsconfig.json`
- Create: `vitest.config.ts`
- Create: `playwright.config.ts`
- Create: `.gitignore`
- Create: `.env.example`
- Create: `src/app/layout.tsx`
- Create: `src/app/page.tsx`
- Create: `src/app/globals.css`
- Create: `src/test/setup.ts`

**Interfaces:**
- Produces: runnable Next.js TypeScript app with test, lint, typecheck, build, and Playwright commands.
- Produces env names consumed by all later tasks.

- [ ] **Step 1: Add package and config files**

Create a minimal app with these scripts:

```json
{
  "scripts": {
    "dev": "next dev",
    "build": "next build",
    "start": "next start",
    "lint": "next lint",
    "typecheck": "tsc --noEmit",
    "test": "vitest run",
    "test:watch": "vitest",
    "test:e2e": "playwright test"
  }
}
```

Dependencies:

```text
@supabase/ssr
@supabase/supabase-js
@vercel/node
next
postgres
react
react-dom
zod
```

Dev dependencies:

```text
@playwright/test
@testing-library/jest-dom
@testing-library/react
@types/node
@types/react
@types/react-dom
eslint
eslint-config-next
jsdom
typescript
vitest
```

- [ ] **Step 2: Add `.env.example`**

```env
NEXT_PUBLIC_SUPABASE_URL=https://cympxjsqetzivwxwbhob.supabase.co
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=
SUPABASE_SECRET_KEY=
DATABASE_URL=
SUPABASE_DB_PASSWORD=
CRM_ALLOWED_DOMAIN=automationsystems.org
CRM_COMPANY_NAME=Automation Systems NG Pvt Ltd
```

- [ ] **Step 3: Run scaffold checks**

Run:

```powershell
npm install
npm run typecheck
npm run test
npm run build
```

Expected: all commands exit 0 after the placeholder app is in place.

- [ ] **Step 4: Commit**

```powershell
git add .
git commit -m "chore: scaffold next crm app"
```

---

### Task 2: Database Schema, Migrations, And Seed Defaults

**Files:**
- Create: `supabase/migrations/0001_initial_schema.sql`
- Create: `src/server/db/client.ts`
- Create: `src/server/db/schema.ts`
- Create: `src/server/db/ids.ts`
- Create: `src/server/db/ids.test.ts`
- Create: `src/server/settings/defaults.ts`
- Create: `src/server/settings/defaults.test.ts`
- Create: `scripts/apply-migrations.mjs`
- Create: `scripts/seed-admin.mjs`

**Interfaces:**
- Produces: `sql`, `withTransaction<T>(fn)`, `nextCrmId(tx, key, prefix, width, year?)`.
- Produces: default settings matching Apps Script.
- Consumes env: `DATABASE_URL`.

- [ ] **Step 1: Write failing default settings tests**

Test that defaults include stages `Lead|Opportunity|Quoted`, outcomes `Won|Lost|Hold`, tags `Punjab|Chandigarh|NCR|Geo|Other`, priorities `High|Medium|Low`, GST `18`, currency `INR`, and the full won-category list including `Lighting, Switches, Wires`.

Run:

```powershell
npm run test -- src/server/settings/defaults.test.ts
```

Expected: FAIL because the module does not exist.

- [ ] **Step 2: Implement default settings**

Implement `DEFAULT_SETTINGS` as typed key/value pairs and helper `defaultSettingRows()`.

- [ ] **Step 3: Verify defaults pass**

Run:

```powershell
npm run test -- src/server/settings/defaults.test.ts
```

Expected: PASS.

- [ ] **Step 4: Write failing ID allocation tests**

Use a fake transaction adapter to assert:
- customer ID starts at `CUST-0001`
- contact ID starts at `CT-0001`
- action ID starts at `ACT-00001`
- case ID includes current year as `CASE-2026-0001`
- quote ID includes current year as `QTN-2026-0001`
- two concurrent allocations cannot return the same ID when backed by a transaction.

Run:

```powershell
npm run test -- src/server/db/ids.test.ts
```

Expected: FAIL because `nextCrmId` does not exist.

- [ ] **Step 5: Implement migration SQL**

Create tables:

```text
users, customers, contacts, handlers, cases, actions,
quotations, quote_boq, recycle_bin, settings, counters,
activity_log, import_customers, import_contacts
```

Add unique constraints listed in the design spec. Enable RLS on CRM tables. Add conservative policies that deny browser direct access by default. Server-side DB access will use `DATABASE_URL`.

- [ ] **Step 6: Implement DB client and ID allocation**

Implement:

```ts
export const sql = postgres(process.env.DATABASE_URL!, { prepare: false });
export async function withTransaction<T>(fn: (tx: Sql) => Promise<T>): Promise<T>;
export async function nextCrmId(tx: Sql, key: string, prefix: string, width: number, year?: number): Promise<string>;
```

`nextCrmId` must lock/update `counters` in one transaction and format IDs exactly.

- [ ] **Step 7: Verify DB unit tests**

Run:

```powershell
npm run test -- src/server/db/ids.test.ts src/server/settings/defaults.test.ts
```

Expected: PASS.

- [ ] **Step 8: Commit**

```powershell
git add .
git commit -m "feat: add supabase schema and crm id allocation"
```

---

### Task 3: Auth Session And CRM Context

**Files:**
- Create: `src/server/auth/context.ts`
- Create: `src/server/auth/context.test.ts`
- Create: `src/server/auth/supabase.ts`
- Create: `src/app/auth/callback/route.ts`
- Create: `src/app/login/page.tsx`
- Create: `src/middleware.ts`

**Interfaces:**
- Produces: `getRequestContext(request): Promise<CrmContext>`.
- Produces: `requireActiveCrmUser(email): Promise<CrmUser>`.
- Produces: `assertAllowedDomain(email): void`.

- [ ] **Step 1: Write failing auth tests**

Test:
- `user@automationsystems.org` is allowed.
- `user@gmail.com` is rejected.
- inactive CRM user is rejected.
- missing CRM user is rejected.
- legacy roles normalize to L-levels only if source import requires it.

Run:

```powershell
npm run test -- src/server/auth/context.test.ts
```

Expected: FAIL because auth context does not exist.

- [ ] **Step 2: Implement auth context**

Use Supabase server helpers to read the authenticated user. Enforce `CRM_ALLOWED_DOMAIN`. Load the CRM user by lowercase email. Return:

```ts
type CrmContext = {
  email: string;
  name: string;
  role: 'L1' | 'L2' | 'L3' | 'L4' | 'L5' | 'L6';
  allowedTags: string[];
  active: boolean;
};
```

- [ ] **Step 3: Implement login and callback**

Create Google OAuth login page and callback route. Redirect rejected users to login with a safe error message.

- [ ] **Step 4: Verify auth tests**

Run:

```powershell
npm run test -- src/server/auth/context.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```powershell
git add .
git commit -m "feat: add google auth and crm user context"
```

---

### Task 4: Authorization Engine

**Files:**
- Create: `src/server/domain/types.ts`
- Create: `src/server/domain/lists.ts`
- Create: `src/server/auth/access.ts`
- Create: `src/server/auth/access.test.ts`

**Interfaces:**
- Produces: `accessLevel(user, customer, ownership): 'FULL' | 'NAME' | 'NONE'`.
- Produces: `caseVisible(user, customerAccess, caseRecord, ownership): boolean`.
- Produces: `ensureFull(...)`, `ensureCanSeeCase(...)`, `ensureAdmin(...)`.

- [ ] **Step 1: Write failing access matrix tests**

Cover L1-L6, tag match/no match, handler, assignee, extra owner, L3 name-only outside tag, and the rule that ticket assignment does not grant customer access.

Run:

```powershell
npm run test -- src/server/auth/access.test.ts
```

Expected: FAIL because access functions do not exist.

- [ ] **Step 2: Implement access functions**

Port the Apps Script access matrix exactly. Keep pure functions separate from DB lookup code so tests are fast and exhaustive.

- [ ] **Step 3: Verify access tests**

Run:

```powershell
npm run test -- src/server/auth/access.test.ts
```

Expected: PASS.

- [ ] **Step 4: Commit**

```powershell
git add .
git commit -m "feat: port crm authorization rules"
```

---

### Task 5: RPC Compatibility Layer

**Files:**
- Create: `src/server/rpc/registry.ts`
- Create: `src/server/rpc/registry.test.ts`
- Create: `src/server/rpc/errors.ts`
- Create: `src/app/api/rpc/route.ts`
- Create: `src/client/gs.ts`
- Create: `src/client/gs.test.ts`

**Interfaces:**
- Produces: `registerRpc(name, handler)`.
- Produces: `callRpc(name, args, request)`.
- Produces browser helper `gs(fn, ...args)` compatible with the old UI call style.

- [ ] **Step 1: Write failing registry tests**

Assert:
- unknown function returns a safe 404-style error.
- handler args are passed in order.
- thrown authorization errors become safe messages.
- non-read calls can be marked for client cache busting.

Run:

```powershell
npm run test -- src/server/rpc/registry.test.ts src/client/gs.test.ts
```

Expected: FAIL.

- [ ] **Step 2: Implement RPC route**

POST body:

```json
{ "fn": "api_bootstrap", "args": [] }
```

Response:

```json
{ "ok": true, "data": {} }
```

Error response:

```json
{ "ok": false, "error": "safe user-facing message" }
```

- [ ] **Step 3: Verify RPC tests**

Run:

```powershell
npm run test -- src/server/rpc/registry.test.ts src/client/gs.test.ts
```

Expected: PASS.

- [ ] **Step 4: Commit**

```powershell
git add .
git commit -m "feat: add apps script compatible rpc layer"
```

---

### Task 6: Customers, Contacts, Handlers, And Grid APIs

**Files:**
- Create: `src/server/customers/repository.ts`
- Create: `src/server/customers/service.ts`
- Create: `src/server/customers/service.test.ts`
- Create: `src/server/customers/rpc.ts`

**Interfaces:**
- Produces RPC handlers:
  - `api_myCustomers`
  - `api_allCustomers`
  - `api_searchCustomers`
  - `api_getCustomer`
  - `api_createCustomer`
  - `api_updateCustomer`
  - `api_saveCustomerCells`
  - `api_bulkCustomers`
  - `api_addContact`
  - `api_updateContact`
  - `api_deleteContact`
  - `api_bulkContacts`
  - `api_addHandler`
  - `api_removeHandler`
  - `api_deleteCustomers`

- [ ] **Step 1: Write failing customer service tests**

Cover search caps, duplicate-name guard, handler creation, Direct placeholder removal, field-level edit rights, contact CRUD, bulk import row caps, soft-delete blocked by cases/quotes, and recycle-bin movement.

Run:

```powershell
npm run test -- src/server/customers/service.test.ts
```

Expected: FAIL.

- [ ] **Step 2: Implement customer repository and service**

Use server-side authorization for every mutation. Use transactions for create, bulk import, handler add/remove, and delete.

- [ ] **Step 3: Register customer RPC handlers**

Register each handler with the names used by `Code.gs` and `Index.html`.

- [ ] **Step 4: Verify customer tests**

Run:

```powershell
npm run test -- src/server/customers/service.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```powershell
git add .
git commit -m "feat: migrate customer contact and handler APIs"
```

---

### Task 7: Cases, Dashboards, Workspace, And Activity APIs

**Files:**
- Create: `src/server/cases/repository.ts`
- Create: `src/server/cases/service.ts`
- Create: `src/server/cases/service.test.ts`
- Create: `src/server/dashboard/service.ts`
- Create: `src/server/dashboard/service.test.ts`
- Create: `src/server/cases/rpc.ts`
- Create: `src/server/dashboard/rpc.ts`

**Interfaces:**
- Produces RPC handlers:
  - `api_bootstrap`
  - `api_workspace`
  - `api_dashboard`
  - `api_listAssignableUsers`
  - `api_createCase`
  - `api_updateCase`
  - `api_setCaseStage`
  - `api_setCaseOutcome`
  - `api_addCaseOwner`
  - `api_removeCaseOwner`
  - `api_assignTicket`
  - `api_getCase`
  - `api_listCases`
  - `api_quickLog`

- [ ] **Step 1: Write failing case service tests**

Cover owner derivation from handlers, extra owners, assignee rules, open/closed reassignment, Hold behavior, Won/Lost clearing assignee, Won validation, stage transition restrictions, quick-log customer creation, and dashboard list caps.

Run:

```powershell
npm run test -- src/server/cases/service.test.ts src/server/dashboard/service.test.ts
```

Expected: FAIL.

- [ ] **Step 2: Implement case and dashboard services**

Keep owner calculation separate from stored fallback owner. Log activity for creates and updates. Use transactions for quick-log and outcome changes.

- [ ] **Step 3: Register case/dashboard RPC handlers**

Names must match the Apps Script names exactly.

- [ ] **Step 4: Verify tests**

Run:

```powershell
npm run test -- src/server/cases/service.test.ts src/server/dashboard/service.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```powershell
git add .
git commit -m "feat: migrate case dashboard and workspace APIs"
```

---

### Task 8: Quotations And Direct Downloads

**Files:**
- Create: `src/server/quotes/repository.ts`
- Create: `src/server/quotes/service.ts`
- Create: `src/server/quotes/service.test.ts`
- Create: `src/server/quotes/render.ts`
- Create: `src/server/quotes/render.test.ts`
- Create: `src/server/quotes/rpc.ts`
- Create: `src/app/api/download/quote/[quoteNo]/[rev]/route.ts`

**Interfaces:**
- Produces RPC handlers:
  - `api_listTemplates`
  - `api_createQuotation`
  - `api_uploadQuotation`
  - `api_getQuotation`
  - `api_setQuoteStatus`
  - `api_generateQuoteDoc`
- Produces download endpoint returning an attachment response.

- [ ] **Step 1: Write failing quote tests**

Cover quote numbering, R0 first revision, revision superseding, Draft not advancing case, Sent advancing open case to Quoted, uploaded quote behavior without Google Drive storage, manual subtotal, tax calculation, BOQ JSON storage, and attachment download headers.

Run:

```powershell
npm run test -- src/server/quotes/service.test.ts src/server/quotes/render.test.ts
```

Expected: FAIL.

- [ ] **Step 2: Implement quote services**

Use a transaction for create/revision/status changes. Store generated artifact metadata in the database and return direct download URLs instead of Google Drive URLs.

- [ ] **Step 3: Implement renderer**

Generate an HTML document suitable for browser download/print first. If PDF generation is added, it must not require Google Drive. The UI copy should still expose user-facing quotation/invoice download actions.

- [ ] **Step 4: Verify quote tests**

Run:

```powershell
npm run test -- src/server/quotes/service.test.ts src/server/quotes/render.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```powershell
git add .
git commit -m "feat: migrate quotation and download flows"
```

---

### Task 9: Admin, Settings, Imports, And Recycle Bin APIs

**Files:**
- Create: `src/server/admin/service.ts`
- Create: `src/server/admin/service.test.ts`
- Create: `src/server/admin/rpc.ts`

**Interfaces:**
- Produces RPC handlers:
  - `api_admin_listUsers`
  - `api_admin_saveUser`
  - `api_admin_saveSettings`
  - `api_admin_links`
  - `api_admin_runImport`
  - `api_admin_runImportContacts`
  - `api_admin_listRecycle`
  - `api_admin_restoreCustomer`
  - `api_admin_purgeCustomer`

- [ ] **Step 1: Write failing admin tests**

Cover L6-only admin access, user save normalization, active/inactive behavior, settings persistence, import duplicate skipping, import caps, restore, purge, and activity logging.

Run:

```powershell
npm run test -- src/server/admin/service.test.ts
```

Expected: FAIL.

- [ ] **Step 2: Implement admin services**

Keep admin operations transactional where they touch multiple tables.

- [ ] **Step 3: Register admin RPC handlers**

Names must match Apps Script exactly.

- [ ] **Step 4: Verify admin tests**

Run:

```powershell
npm run test -- src/server/admin/service.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```powershell
git add .
git commit -m "feat: migrate admin settings import and recycle APIs"
```

---

### Task 10: Frontend Port With RPC Helper

**Files:**
- Create: `src/app/crm/page.tsx`
- Create: `src/app/crm/CrmApp.tsx`
- Create: `src/app/crm/legacy-ui.css`
- Create: `src/app/crm/legacy-app.ts`
- Create: `src/app/crm/legacy-app.test.ts`
- Modify: `src/app/page.tsx`

**Interfaces:**
- Consumes: `gs(fn, ...args)` from Task 5.
- Consumes all migrated RPC names.
- Produces: CRM UI preserving the current routes `dash | customers | customer | cases | case | admin`.

- [ ] **Step 1: Write failing frontend parity tests**

Assert:
- route container renders.
- `gs('api_bootstrap')` is called at startup.
- missing auth redirects to login.
- quote download buttons use the new download URLs.
- no `google.script.run` reference remains.
- no Apps Script scriptlet markers remain.

Run:

```powershell
npm run test -- src/app/crm/legacy-app.test.ts
```

Expected: FAIL.

- [ ] **Step 2: Port `Index.html`**

Move CSS into `legacy-ui.css`. Move the app script into `legacy-app.ts`. Replace Apps Script boot/scriptlet usage with JSON from `api_bootstrap`. Replace the old `gs` wrapper with the fetch-backed helper.

- [ ] **Step 3: Preserve mobile and optimistic behavior**

Keep quick-log floating button, client cache, background refresh, grid debounce, rollback on save failure, and same user-visible labels unless the Google Drive removal requires copy changes.

- [ ] **Step 4: Verify frontend tests**

Run:

```powershell
npm run test -- src/app/crm/legacy-app.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```powershell
git add .
git commit -m "feat: port crm frontend to vercel rpc"
```

---

### Task 11: API Parity, Integration, And Race Tests

**Files:**
- Create: `src/server/rpc/api-parity.test.ts`
- Create: `src/server/integration/crm-flows.test.ts`
- Create: `src/server/integration/concurrency.test.ts`
- Create: `scripts/check-api-parity.mjs`

**Interfaces:**
- Consumes: source Apps Script files and RPC registry.
- Produces: automated check that every `gs('api_*')` call has a registered handler and every expected Apps Script API is accounted for.

- [ ] **Step 1: Write failing parity check**

Extract `api_*` functions from `docs/source-appscript/Code.gs` and `gs('api_*')` calls from `docs/source-appscript/Index.html`. Assert all UI-called APIs are registered in the new RPC registry.

Run:

```powershell
npm run test -- src/server/rpc/api-parity.test.ts
```

Expected: FAIL until all handlers are registered.

- [ ] **Step 2: Write integration flow tests**

Cover:
- admin seeds user
- L2 creates customer through search-first flow
- handler sees customer grid
- L2 creates case
- assignee sees ticket but not full customer if not handler
- quote Draft does not advance case
- quote Sent advances case
- Won clears assignee and credits all handlers

- [ ] **Step 3: Write concurrency tests**

Cover:
- concurrent customer ID allocation
- concurrent case ID allocation
- concurrent quote revision creation
- grid patch does not overwrite unrelated field changes

- [ ] **Step 4: Verify integration suite**

Run:

```powershell
npm run test -- src/server/rpc/api-parity.test.ts src/server/integration/crm-flows.test.ts src/server/integration/concurrency.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```powershell
git add .
git commit -m "test: add crm parity integration and concurrency coverage"
```

---

### Task 12: Deployment Configuration And Verification

**Files:**
- Create: `vercel.json`
- Create: `docs/deployment/vercel-supabase-setup.md`
- Create: `tests/e2e/crm-smoke.spec.ts`
- Modify: `.env.example`

**Interfaces:**
- Produces: Vercel-ready deployment.
- Produces: smoke test for login-gated app shell and core route rendering.

- [ ] **Step 1: Configure Vercel**

Set project env vars in Vercel:

```text
NEXT_PUBLIC_SUPABASE_URL
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY
SUPABASE_SECRET_KEY
DATABASE_URL
SUPABASE_DB_PASSWORD
CRM_ALLOWED_DOMAIN
CRM_COMPANY_NAME
```

- [ ] **Step 2: Write deployment doc**

Document:
- Supabase Google OAuth setup.
- Allowed domain restriction.
- Vercel env var setup.
- Migration command.
- Admin seed command.
- Production credential rotation before go-live.

- [ ] **Step 3: Write Playwright smoke test**

The smoke test should verify:
- unauthenticated visit reaches login gate.
- app shell route exists.
- critical route containers render with mocked auth/session where needed.

- [ ] **Step 4: Run final verification**

Run:

```powershell
npm run typecheck
npm run lint
npm run test
npm run build
npm run test:e2e
```

Expected: all commands exit 0.

- [ ] **Step 5: Deploy preview**

Run:

```powershell
vercel
```

Expected: Vercel returns a preview URL.

- [ ] **Step 6: Commit**

```powershell
git add .
git commit -m "chore: add deployment verification"
```

---

### Task 13: Final Review And Production Handoff

**Files:**
- Modify: `docs/deployment/vercel-supabase-setup.md`
- Create: `docs/qa/final-migration-checklist.md`

**Interfaces:**
- Produces: final checklist and review package.

- [ ] **Step 1: Run API parity script**

Run:

```powershell
node scripts/check-api-parity.mjs
```

Expected: no missing UI-called APIs.

- [ ] **Step 2: Run final verification again**

Run:

```powershell
npm run typecheck
npm run lint
npm run test
npm run build
npm run test:e2e
```

Expected: all commands exit 0.

- [ ] **Step 3: Request final code review**

Use the whole-branch diff from the initial spec commit to HEAD. Review must specifically check:
- Apps Script parity.
- Auth and secret handling.
- Access-control bypasses.
- RLS posture.
- Race-condition boundaries.
- Quotation/download replacement for Google Drive.
- Vercel deployment readiness.

- [ ] **Step 4: Fix Critical and Important review findings**

Re-run the covering tests for each fix.

- [ ] **Step 5: Push to GitHub**

Run:

```powershell
git push -u origin main
```

Expected: push succeeds to `Danish-AutomationSystems/CRM.git`.
