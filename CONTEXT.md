# AS CRM Migration Context

Last updated: 2026-07-31 (mobile header redesign)

## Project Purpose

AS CRM is the migrated version of the Automation Systems CRM that previously ran on Google Apps Script. The migration goal is to preserve the existing CRM features and behavior while improving latency, maintainability, security, and deployability by moving to:

- Next.js on Vercel for the app and server routes.
- Supabase Postgres/Auth for database and Google sign-in.
- Server-side RPC handlers that emulate the Apps Script `google.script.run` API surface.

The production app is deployed at:

- https://as-crm-ten.vercel.app

Custom CRM subdomain:

- https://crm.automationsystems.info

The source repository is:

- https://github.com/Danish-AutomationSystems/CRM.git

Active deployment branch:

- `main` (feature work was developed on `migration/vercel-supabase-crm` and merged into `main`)

## Security Rules For Future Agents

- Do not commit raw passwords, service-role keys, database URLs, or OAuth client secrets.
- Raw secrets belong only in Vercel environment variables, Supabase dashboard, Google Cloud dashboard, and local ignored `.env.local` files.
- `CONTEXT.md` intentionally documents secret names, locations, and formats, not raw secret values.
- If a future task requires a secret value, ask the project owner or read it from an authorized local ignored file/environment; never print it in chat or commit it.
- The Google sign-in domain restriction is enforced in both the OAuth request hint and backend auth checks.
- Keep this file updated whenever project setup, deployment state, architecture, environment variable requirements, external service configuration, or important decisions change.

## Current Production Status

Completed:

- Vercel project created under the Automation Systems team: `as-crm`.
- GitHub repository connected to Vercel.
- Production deployment created and aliased to `https://as-crm-ten.vercel.app`.
- Supabase schema migrations applied.
- Initial L6 admin user seeded for the project owner email.
- Local verification passed before deployment:
  - `npm run typecheck`
  - `npm run test`
  - `npm run build`
  - Playwright CRM smoke tests with mocked Supabase
- Deployment smoke checks after production deploy:
  - `/login` returned HTTP 200
  - `/crm` redirected to login for unauthenticated users
- Auto-provision deployment:
  - Commit: `4076fdf feat: auto-provision company users as L1`
  - Vercel deployment: `dpl_5c9DWd2aQkSzdoWSdzH5CLUEwNs4`
  - Production aliases moved to the new deployment, including `https://crm.automationsystems.info`
  - `https://as-crm-ten.vercel.app/login` returned HTTP 200
  - UI Revamp & Modernization (2026-07-30):
  - CSS design system tokens (`--sp-*`, `--fs-*`, `--r-*`, `--shadow-*`, `--brand-lt`, `--brand-glow`).
  - Sticky header with backdrop blur filter (`backdrop-filter: blur(12px)`).
  - Modern responsive mobile layout with hamburger toggle (`.nav-toggle`).
  - Redesigned login page (`/login`) with brand mark icon, diagonal green gradient background, and styled button.
- Performance & Latency Optimizations (2026-07-30):
  - Supabase B-tree and GIN database indexes (`supabase/migrations/0003_performance_indexes.sql`).
  - RPC Gzip/Brotli payload compression headers (`/api/rpc`).
  - Selective SQL query field projection.
  - Client SWR memory caching with automatic write-invalidation (`cacheBustKey`).
  - Generator script (`scripts/port-legacy-index.mjs`) safe DOM helpers (`setHtml`, `setText`) and unmounted DOM error suppression in `oops(e)` to prevent errors during fast route switching.
- Generator CSS Protection:
  - `scripts/port-legacy-index.mjs` writes raw legacy AppsScript CSS to `legacy-full-ui.baseline.css` so that `src/app/crm/legacy-full-ui.css` remains manually maintained and is never overwritten on regeneration.
- CRM Tab URL Routing (2026-07-31):
  - The CRM previously ran the whole authenticated app behind a single `/crm` route. The legacy client switched views (Dashboard/Customers/Cases/Admin/detail views) purely in-memory (`S.route`/`S.routeArg`), never touching `window.location`, so refreshing always reset the user to Dashboard and browser back/forward did nothing.
  - Added `src/app/crm/[[...slug]]/page.tsx`, an optional catch-all route replacing `src/app/crm/page.tsx`, mapping `/crm`, `/crm/customers`, `/crm/customer/:id`, `/crm/cases`, `/crm/case/:id`, `/crm/admin` to an initial `{route, arg}` via `src/app/crm/route-map.ts` (pure, unit-tested slug<->path<->route-state mapping). Unknown slugs fall back to `dash`. No `src/middleware.ts` change was needed - it already prefix-protects `/crm/*`.
  - `src/app/crm/LegacyFullCrmApp.tsx` now syncs the URL from the legacy app's existing `#main[data-route]` attribute (the generator already stamps this on every `S.route=` assignment) via a `MutationObserver`, using raw `window.history.pushState(null, '', path)` - deliberately NOT `next/navigation`'s `router.push`, which would remount the page's client subtree (the catch-all segment value changes) and re-`eval` the ~115KB legacy script on every tab click. Next.js 15 patches `window.history.pushState` itself (`node_modules/next/dist/client/components/app-router.js`) to keep its internal router state in sync, so raw `pushState` is the supported integration point, confirmed by Playwright back/forward tests passing against the real dev server.
  - The record id (`S.routeArg`) for detail views is read directly off the `window.S` global at MutationObserver time (indirect `eval` puts legacy script globals on `window`), never from a new DOM attribute - this keeps the frozen legacy artifact (see below) completely untouched.
  - Handles the async boot race: `init()` always lands on `vDash` first (its render `.then` has no route guard, unlike the other views), so a deep-linked initial route is restored via a one-shot flag consumed on the first `data-route` mutation, deferred to a `setTimeout(0)` macrotask so it runs after `vDash`'s render and isn't clobbered.
  - Role-hidden tabs (e.g. an L1 user deep-linking `/crm/cases`, whose nav button is `display:none`): silently falls back to the dashboard and rewrites the URL to `/crm` via `replaceState` (not `pushState`), so Back still exits the CRM cleanly. Server-side RPC authorization remains the actual security boundary; this is UX-only.
  - Tests: `src/app/crm/route-map.test.ts` (pure mapping + round-trip), `src/app/crm/legacy-app.test.ts` `describe('tab URL sync', ...)` (boot-race, popstate, hidden-tab fallback, clean unmount), `tests/e2e/crm-smoke.spec.ts` (nav click updates URL without remounting via a `window.__mountProbe` sentinel, refresh restores the exact view, cold deep link, back/forward, unauthenticated deep links preserve `next=`).
  - Design doc: `docs/superpowers/specs/2026-07-31-crm-tab-routing-design.md`.
- Mobile Nav Drawer Fix (2026-07-31):
  - Real-device report (Android Chrome, `crm.automationsystems.info`): opening the mobile hamburger nav on `/crm/cases` showed the user-info chip and the Dashboard/Customers/Cases/Admin buttons side by side in two narrow columns instead of the nav stacking full-width below the header, wasting most of the screen.
  - Root cause in `src/app/crm/legacy-full-ui.css`: the mobile `nav.nav-open` rule set `width:100%` but `nav`'s base (desktop) rule sets `flex:1`, whose `flex-basis:0%` takes priority over `width` for main-axis sizing in a flex row. So `nav` only grew to fill the leftover space next to `.uchip` on the same line instead of being forced onto its own row. Fixed by adding `flex:0 0 100%` alongside `width:100%` in the mobile rule.
  - Also widened the hamburger-drawer breakpoint from `max-width:720px` to a dedicated `max-width:900px` media query (kept separate from the phone-only content rules - 2-column stat grid, smaller `h1`, full-screen modals - which stay at 720px). Below 900px the desktop nav was wrapping an orphaned last button onto its own line, which visibly broke on common tablet-portrait widths like iPad (768-834px logical px); above 1024px the desktop nav fits on one line cleanly.
  - Verified with real Playwright screenshots (not just DOM assertions) across 360-1440px viewport widths on both Dashboard and Cases, confirming no horizontal page overflow and the drawer spans the full header width when open.
  - Regression coverage added to `tests/e2e/crm-smoke.spec.ts`: `the collapsed nav drawer spans the full header width on ...` at phone (390x844) and tablet-portrait (768x1024) widths, asserting `#nav`'s bounding-box width against `.hwrap`'s and checking for zero horizontal document overflow.
  - No `ui-ux-pro-max`/`ui-styling` skill exists in the current tool environment despite being referenced by earlier CONTEXT.md UI-revamp entries; this fix was done via direct CSS diagnosis and Playwright visual verification.
- Mobile Header Redesign (2026-07-31, follow-up to the nav drawer fix above):
  - Second real-device report: even after the drawer fix, the hamburger toggle sat to the right of the "AS CRM" title (DOM order is brand, then the generator-injected `.nav-toggle`, then `nav`, then `.uchip`, none with an explicit `order` before this change) - not the conventional leading-left position - and the user-info chip (name + email + role badge) wrapped onto its own left-aligned row below, wasting vertical space before any content was visible.
  - `src/app/crm/legacy-full-ui.css`, inside the `@media(max-width:900px)` block: `.nav-toggle{order:-1}` moves the toggle to lead the header row (left of the brand mark/title). `.brand small` (the "Automation Systems NG" tagline) and `.umail` (email) are hidden on mobile to shrink content so toggle + brand + a compact `uname`+`rolebadge` chip all fit on a single row, with `.uchip` kept at `margin-left:auto` (previously zeroed, which is what caused it to left-align on its own wrapped row) so it stays pinned to the right like the desktop layout.
  - Verified via Playwright computed-style inspection that `.nav-toggle` truly has `background:transparent`/no border (confirming its icon is a plain, unstyled glyph, not an actual duplicate "box" next to the brand mark) and via screenshots at 360/390/412/480/768px that toggle, brand, and the compact user chip render on one row with no horizontal overflow.
  - Regression coverage extended in the same `tests/e2e/crm-smoke.spec.ts` nav-drawer tests: asserts the toggle's bounding box sits left of and on the same row as `.brand` and `.uchip`, in addition to the existing full-width-drawer-when-open and zero-horizontal-overflow checks.

### Known issue: the legacy artifact and its generator have drifted - treat the artifact as frozen

- `scripts/port-legacy-index.mjs` has a latent bug: its `el(x).innerHTML = EXPR;` / `el(x).textContent = EXPR;` -> `setHtml(...)`/`setText(...)` transforms do not correctly locate the statement's true closing `;` (a naive attempt at fixing this during the tab-routing work still broke on nested callbacks and CSS strings containing `;`). Running `node scripts/port-legacy-index.mjs` today **produces syntactically invalid JavaScript** in `src/app/crm/legacy-full.generated.ts`.
- The committed `legacy-full.generated.ts` predates those transforms (it has zero `setHtml(`/`setText(` call sites), so it remains valid and is what's actually deployed. This means the 2026-07-30 "Generator script ... safe DOM helpers (`setHtml`, `setText`)" line above is **aspirational, not actually shipped** - the generator was edited to add that transform, but the artifact was never successfully regenerated afterward.
- Until the generator's expression-scanning is fixed (properly tracking string-literal and paren/brace/bracket depth, not just "stop at the first `;`") and verified with a syntax-check test (e.g. `new Function(legacyAppScript)` must not throw) before being trusted, **do not run the generator and commit its output**. Treat `src/app/crm/legacy-full.generated.ts` as a frozen, hand-verified artifact. Build any new CRM behavior in the React wrapper (`LegacyFullCrmApp.tsx`, `CrmApp.tsx`, `route-map.ts`, the `[[...slug]]` page) instead, exactly as the tab-routing work above did.
- Separately useful invariant if anyone does fix the generator: the artifact emits `S.route='case'; setRouteAttr('case'); S.routeArg=id; setTab('cases');` - i.e. `setRouteAttr` (which stamps `data-route`) fires *before* `S.routeArg` is assigned. Reading `S.routeArg` is only safe from a `MutationObserver` callback (a microtask, so it runs after the full synchronous statement list), never synchronously right after observing the attribute change.

Pending/manual:

- Google provider has been enabled in Supabase Auth.
- Google Cloud OAuth Client ID and Client Secret have been pasted into Supabase.
- Supabase URL Configuration has been updated for the CRM subdomain.
- Google OAuth client `AS-WEBAPP` has been updated for the CRM subdomain.
- Real Google sign-in must be tested on `https://crm.automationsystems.info/login`.
- If Google login redirects to `http://localhost:3000/?code=...`, Supabase Auth URL Configuration is still using localhost as Site URL or is missing the production callback URL.
- Custom CRM subdomain DNS is verified in Vercel.

## Architecture Overview

### App Router

- `src/app/login/page.tsx`
  - Client-side Google sign-in button.
  - Uses `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`.
  - Calls Supabase OAuth with `provider: 'google'`.
  - Sends `hd=automationsystems.org` as a Google hosted-domain hint.

- `src/app/auth/callback/route.ts`
  - Handles Supabase OAuth callback and session exchange.

- `src/app/crm/[[...slug]]/page.tsx`
  - Protected CRM route, an optional catch-all so `/crm`, `/crm/customers`, `/crm/customer/:id`, `/crm/cases`, `/crm/case/:id`, and `/crm/admin` all resolve here.
  - Imports the migrated full legacy CRM UI CSS.
  - Maps `params.slug` to an initial `{route, arg}` via `src/app/crm/route-map.ts` and passes it into `CrmApp`/`LegacyFullCrmApp` so a refresh or deep link restores the correct tab instead of always landing on Dashboard.

- `src/app/crm/route-map.ts`
  - Pure, unit-tested slug <-> URL path <-> legacy `{route, arg}` mapping used by both the server page and the client wrapper.

- `src/app/api/rpc/route.ts`
  - Server-side RPC endpoint.
  - Receives `{ fn, args }`.
  - Gets authenticated request context.
  - Dispatches to registered server RPC functions.

- `src/app/api/download/quote/[quoteNo]/[rev]/route.ts`
  - Downloads generated or uploaded quotation/invoice related files.

### Legacy UI Port

- `src/app/crm/LegacyFullCrmApp.tsx`
  - Mounts the migrated Apps Script UI behavior into React.

- `src/app/crm/legacy-full.generated.ts`
  - Generated/ported legacy client code from Apps Script `Index.html`.

- `src/app/crm/legacy-full-ui.css`
  - Full legacy UI CSS.

- `scripts/port-legacy-index.mjs`
  - Rebuilds the generated legacy client from source Apps Script HTML when needed.

Source Apps Script files are stored under:

- `docs/source-appscript/Code.gs`
- `docs/source-appscript/Index.html`
- `docs/source-appscript/AS_CRM_FUNCTIONALITIES.md`
- `docs/source-appscript/AS_CRM_PROJECT_CONTEXT.md`
- `docs/source-appscript/SETUP_GUIDE.md`

### Server Domains

- `src/server/auth/*`
  - Supabase auth helpers, access/domain checks, user context.

- `src/server/db/*`
  - Postgres client, schema helpers, ID helpers.

- `src/server/rpc/*`
  - RPC registry, parity checks, normalized RPC errors.

- `src/server/customers/*`
  - Customer repository, service, RPC handlers.

- `src/server/cases/*`
  - Case repository, service, RPC handlers.

- `src/server/quotes/*`
  - Quotation repository, rendering, service, RPC handlers.
  - External quotation uploads store original bytes and MIME type.

- `src/server/dashboard/*`
  - Dashboard aggregations and RPC handlers.

- `src/server/admin/*`
  - Admin/settings/user-management services and RPC handlers.

- `src/server/settings/defaults.ts`
  - Default company/config values.

## Supabase

Project URL:

- `https://cympxjsqetzivwxwbhob.supabase.co`

Project ref:

- `cympxjsqetzivwxwbhob`

Data API base:

- `https://cympxjsqetzivwxwbhob.supabase.co/rest/v1/`

Database:

- Database name: `postgres`
- User: `postgres.cympxjsqetzivwxwbhob`
- Transaction pooler host: `aws-0-ap-northeast-1.pooler.supabase.com`
- Transaction pooler port: `6543`
- Session pooler host: `aws-0-ap-northeast-1.pooler.supabase.com`
- Session pooler port: `5432`

Prefer the transaction pooler in serverless/Vercel:

```text
postgresql://postgres.cympxjsqetzivwxwbhob:<PASSWORD>@aws-0-ap-northeast-1.pooler.supabase.com:6543/postgres?sslmode=require
```

Migrations:

- `supabase/migrations/0001_initial_schema.sql`
- `supabase/migrations/0002_external_quote_upload_data.sql`

Migration helper:

- `scripts/apply-migrations.mjs`

Admin seed helper:

- `scripts/seed-admin.mjs`

Important schema note:

- `quotations.upload_data` and `quotations.upload_mime_type` are required for storing external uploaded quotation bytes and downloading them from the CRM.

## Vercel

Vercel team:

- Automation Systems

Vercel project:

- `as-crm`

Production alias:

- `https://as-crm-ten.vercel.app`

Custom domain attached to the Vercel project:

- `crm.automationsystems.info`

GoDaddy DNS is used because nameservers are still GoDaddy (`ns25.domaincontrol.com`, `ns26.domaincontrol.com`).

GoDaddy DNS record configured for Vercel:

```text
Type: CNAME
Name: crm
Value: 7633a7ffb603e0b3.vercel-dns-017.com
TTL: default / 1 hour
```

Do not point the apex/root domain `automationsystems.info` to this CRM unless explicitly requested. The intended CRM URL is the subdomain `crm.automationsystems.info`.

Alternative, instead of an individual DNS record, change domain nameservers at GoDaddy to:

```text
ns1.vercel-dns.com
ns2.vercel-dns.com
```

Prefer the individual `crm` CNAME record so existing root-domain website/email/DNS records remain untouched.

After GoDaddy DNS changes, verify:

```bash
npx vercel domains verify crm.automationsystems.info
```

Current verification status:

- `npx vercel domains verify crm.automationsystems.info` returned configured correctly.
- `http://crm.automationsystems.info/login` returned HTTP 200.
- Initial HTTPS checks failed while the certificate was not ready.
- `npx vercel certs issue crm.automationsystems.info` succeeded.
- `https://crm.automationsystems.info/login` now returns HTTP 200.
- After DNS setup, the local/router resolver briefly failed to resolve `crm.automationsystems.info`, while public DNS (`8.8.8.8` and `1.1.1.1`) and Vercel verification were correct. A direct HTTPS probe with `curl --resolve crm.automationsystems.info:443:216.198.79.1` returned HTTP 200. Treat local resolve failures as DNS cache propagation unless public DNS or Vercel verification fails.
- User's Chrome showed `DNS_PROBE_FINISHED_NXDOMAIN` after setup. Re-checks showed public DNS still resolves the CNAME, Vercel verification is configured correctly, and direct HTTPS probing returns HTTP 200. Recommended user-side fix is DNS/browser cache flush or temporarily switching DNS to Google/Cloudflare.
- GoDaddy DNS screenshot reviewed: `CNAME` record with `Name: crm` and value `7633a7ffb603e0b3.vercel-dns-017.com.` is correct. Existing root `A @ WebsiteBuilder Site` and `CNAME www -> automationsystems.info.` do not block the intended `crm.automationsystems.info` subdomain.

Build settings:

- Framework: Next.js
- Install command: `npm install`
- Build command: `npm run build`
- Dev command: `npm run dev`
- Region configured in `vercel.json`: `bom1`

Required Vercel production environment variables:

```text
NEXT_PUBLIC_SUPABASE_URL
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY
SUPABASE_SERVICE_ROLE_KEY
DATABASE_URL
CRM_ALLOWED_DOMAIN
CRM_COMPANY_NAME
```

Current intended non-secret values:

```text
NEXT_PUBLIC_SUPABASE_URL=https://cympxjsqetzivwxwbhob.supabase.co
CRM_ALLOWED_DOMAIN=automationsystems.org
CRM_COMPANY_NAME=Automation Systems NG Pvt Ltd
```

Do not store raw values for the publishable key, service role key, database password, full database URL, or OAuth client secret in this file.

Useful Vercel commands:

```bash
npx vercel whoami
npx vercel project inspect as-crm
npx vercel env ls
npx vercel deploy --prod --yes
```

## Google OAuth Setup

The current sign-in error `Unsupported provider: provider is not enabled` means Supabase Google Auth is not fully enabled/configured yet.

### Current Google Cloud Project Creation

The Google Cloud OAuth project is being created inside the `automationsystems.org` Google Cloud organization.

Current project creation values shown in Google Cloud:

```text
Project name: AS CRM Auth
Project ID: as-crm-auth
Organisation: automationsystems.org
Parent resource: automationsystems.org
```

Do this:

1. Click `Create`.
2. Select the newly created project after Google finishes provisioning it.
3. Go to `Branding` and complete the OAuth consent basics:
   - App name: `AS CRM`
   - User support email: `testing@automationsystems.org` if available in the dropdown; otherwise use the company admin/owner email shown by Google.
   - App logo: skip for now.
   - Application home page: `https://as-crm-ten.vercel.app`
   - Application privacy policy link: leave blank/skip if Google allows it for Internal; otherwise add a company policy URL later.
   - Application terms of service link: leave blank/skip if Google allows it for Internal; otherwise add a company terms URL later.
   - Authorized domains: add `automationsystems.org` if Google asks for domains.
   - Developer contact email: `testing@automationsystems.org` if available; otherwise use the company admin/owner email.
4. Go to `Audience`:
   - Select `Internal` if available. This is expected because the project is under the `automationsystems.org` organization.
   - Do not use `External` unless Google does not offer Internal. If External is required, keep Publishing status as Testing and add company test users.
   - No broad public audience is needed; this CRM is company-only.
5. Go to `Clients`.
6. Click `Create client`.
7. Application type: `Web application`.
8. Name: `AS-WEBAPP`.
9. Add this Authorized redirect URI:

```text
https://cympxjsqetzivwxwbhob.supabase.co/auth/v1/callback
```

10. Click `Create`.
11. Copy the generated `Client ID` and `Client Secret`.

Current status:

- Web application OAuth client has been created with name `AS-WEBAPP`.
- Authorized redirect URI has been pasted into that client.
- Google-generated `Client ID` and `Client Secret` have been generated and supplied by the user in chat.
- Next step is to copy those values into Supabase Google provider and save. Do not commit those raw values.

### In Supabase

Go to:

```text
Supabase -> Authentication -> Sign In / Providers -> Google
```

Set:

```text
Enable Sign in with Google: ON
Client IDs: <GOOGLE_OAUTH_CLIENT_ID ending in .apps.googleusercontent.com>
Client Secret: <GOOGLE_OAUTH_CLIENT_SECRET>
```

Then save.

Hosted Supabase provider settings are configured in the Dashboard unless a Supabase Management API access token is explicitly available. The project service-role key is not the same as a Supabase Management API access token.

Go to:

```text
Supabase -> Authentication -> URL Configuration
```

Set:

```text
Site URL:
https://as-crm-ten.vercel.app

Redirect URLs:
https://as-crm-ten.vercel.app/auth/callback
```

Important: if `Site URL` remains `http://localhost:3000`, Supabase can complete Google sign-in and then send the user back to localhost with `?code=...`. The Next.js login code sends the browser origin as `redirectTo`, so a localhost redirect after production login is a Supabase dashboard URL configuration problem, not a Vercel redeploy problem.

Supabase Auth URL Configuration has been updated to:

```text
Site URL:
https://crm.automationsystems.info

Redirect URLs:
https://crm.automationsystems.info/auth/callback
https://as-crm-ten.vercel.app/auth/callback
```

Google Cloud OAuth client `AS-WEBAPP` has been updated to include:

```text
Authorized JavaScript origins:
https://crm.automationsystems.info

Authorized redirect URIs:
https://cympxjsqetzivwxwbhob.supabase.co/auth/v1/callback
```

No Vercel redeploy is required after enabling the Google provider.

## Local Development

Install dependencies:

```bash
npm install
```

Create local env:

```bash
copy .env.example .env.local
```

Fill `.env.local` with authorized secrets. `.env.local` is ignored by git.

Run development server:

```bash
npm run dev
```

Default local URL:

- `http://localhost:3000`

## Verification Commands

Use these before claiming a change is complete:

```bash
npm run typecheck
npm run test
npm run build
npm run test:e2e
```

Playwright config:

- `playwright.config.ts`

Smoke test:

- `tests/e2e/crm-smoke.spec.ts`

The mocked-authenticated-session Playwright tests (nav/URL sync, tab routing, refresh restore, back/forward) are skipped by default and only run when a fake local Supabase env is set, since `playwright.config.ts` spawns `npm run dev` and passes through the process env:

```powershell
$env:NEXT_PUBLIC_SUPABASE_URL='http://127.0.0.1:3999'
$env:NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY='dummy-anon-key'
npx playwright test
```

## Known Product Decisions

- Google Drive upload is intentionally not part of the current migrated version.
- Invoice/quotation buttons should download files directly to the user's PC.
- Apps Script latency was the motivation for moving to Vercel/Supabase.
- Preserve feature parity first; fix existing product bugs later.
- Keep RPC and data behavior close to the Apps Script implementation to reduce migration risk.
- Security and correctness are preferred over broad rewrites.
- Current production behavior has been approved for now.
- Next requested work is latency improvement and a responsive UI revamp without harming functionality or changing base business logic.
- UI revamp scope clarification: this means improving responsiveness, frontend layout quality, visual hierarchy, spacing, accessibility, and cleaner styling using `ui-ux-pro-max` and `ui-styling`; it does not mean replacing CRM features or changing business logic.
- Mobile and desktop are equally important for the revamped UI.
- The UI is currently mounted as a large generated legacy Apps Script client (`src/app/crm/legacy-full.generated.ts`) with full legacy CSS (`src/app/crm/legacy-full-ui.css`), which preserved parity but is not the desired long-term UI architecture.
- Future latency/UI work must proceed through approved spec/planning first, use TDD for production changes, and keep `CONTEXT.md` updated after every meaningful setup/design/deployment decision.
- UI revamp completion (2026-07-30): CSS overhaul + generator tweaks applied to modernize the CRM frontend. Changes are frontend-only — responsive layout, design system tokens (`--sp-*`, `--fs-*`, `--r-*`, `--shadow-*`), polished typography/spacing, smooth transitions, mobile hamburger nav, mobile full-screen modals, and premium login page restyle. No backend, business logic, or feature parity changes. Design spec: `docs/superpowers/specs/2026-07-30-ui-revamp-design.md`, Plan: `docs/superpowers/plans/2026-07-30-ui-revamp.md`.
- Performance & Latency Optimization (2026-07-30): Multi-layer optimization completed — Supabase Postgres performance indexes (`0003_performance_indexes.sql`), RPC payload Gzip/Brotli compression, server query projection, and client SWR caching with instant write-invalidation. Preserved 100% feature parity, data safety, and security rules. Spec: `docs/superpowers/specs/2026-07-30-latency-optimization-design.md`, Plan: `docs/superpowers/plans/2026-07-30-latency-optimization.md`.

## Admin/User Access Model

- Users must sign in using Google.
- Allowed email domain defaults to `automationsystems.org`.
- Backend auth checks must reject users outside the allowed domain even if Google/Supabase accepts the identity.
- Initial admin user was seeded as L6 with access to all tags.
- User/role/tag management lives in the admin service/RPC layer.
- New Google accounts from `automationsystems.org` are auto-provisioned into `public.users` on first successful login as active `L1` users with no allowed tags and `added_by='auto-provision'`.
- L6 admins should review newly auto-provisioned L1 users in admin user management and assign the correct role/tags.
- If login succeeds at Google/Supabase but the login page shows `Your account is not allowed to access AS CRM.`, the signed-in email is outside `CRM_ALLOWED_DOMAIN`, the existing CRM user row is inactive, or the user has an invalid role. Missing company-domain users should now be auto-created instead of blocked.

## Important Implementation Notes

- The generated legacy UI code uses escaped JS argument helpers to prevent inline handler injection.
- The app preserves BOOT/access-lock behavior so unauthorized users see the legacy-style lock instead of a broken CRM.
- External quote uploads must preserve original file bytes and MIME type.
- Serverless database access should use the Supabase transaction pooler.
- Middleware protects authenticated CRM/API routes.

## Useful Docs In Repo

- `docs/deployment/vercel-supabase-setup.md`
- `docs/qa/final-migration-checklist.md`
- `docs/superpowers/specs/2026-07-29-vercel-supabase-crm-migration-design.md`
- `docs/superpowers/plans/2026-07-29-vercel-supabase-crm-migration.md`
- `docs/superpowers/specs/2026-07-31-crm-tab-routing-design.md`
- `docs/superpowers/agent-reports/*`

## If A New Agent Takes Over

Start here:

1. Read this `CONTEXT.md`.
2. Read `docs/qa/final-migration-checklist.md`.
3. Read the migration design and plan under `docs/superpowers`.
4. Check `git status --short`.
5. Confirm production env names with `npx vercel env ls`.
6. Run the verification commands before editing deployment-sensitive behavior.
7. Never overwrite user changes or remove existing migration parity code without proving the replacement.
