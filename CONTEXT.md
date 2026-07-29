# AS CRM Migration Context

Last updated: 2026-07-29

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

Active migration branch:

- `migration/vercel-supabase-crm`

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

- `src/app/crm/page.tsx`
  - Protected CRM route.
  - Imports the migrated full legacy CRM UI CSS.

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

## Known Product Decisions

- Google Drive upload is intentionally not part of the current migrated version.
- Invoice/quotation buttons should download files directly to the user's PC.
- Apps Script latency was the motivation for moving to Vercel/Supabase.
- Preserve feature parity first; fix existing product bugs later.
- Keep RPC and data behavior close to the Apps Script implementation to reduce migration risk.
- Security and correctness are preferred over broad rewrites.

## Admin/User Access Model

- Users must sign in using Google.
- Allowed email domain defaults to `automationsystems.org`.
- Backend auth checks must reject users outside the allowed domain even if Google/Supabase accepts the identity.
- Initial admin user was seeded as L6 with access to all tags.
- User/role/tag management lives in the admin service/RPC layer.
- If login succeeds at Google/Supabase but the login page shows `Your account is not allowed to access AS CRM.`, the signed-in email passed OAuth but does not exist as an active row in `public.users`, is inactive, has an invalid role, or is outside `CRM_ALLOWED_DOMAIN`.
- New Google accounts are not auto-provisioned as CRM users. Add them through the CRM admin user-management UI or seed/insert them into `public.users` with a valid role (`L1`-`L6`), `active=true`, and appropriate `allowed_tags`.

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
