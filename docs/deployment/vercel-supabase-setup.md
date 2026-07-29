# AS CRM Vercel And Supabase Deployment

This runbook deploys the migrated AS CRM Next.js app to Vercel with Supabase Auth and Supabase Postgres. Do not paste real credential values into this file or any committed source file.

## 1. Supabase Project

1. Create or select the Supabase project for AS CRM.
2. Keep the project reference and API settings handy:
   - Project URL for `NEXT_PUBLIC_SUPABASE_URL`.
   - Publishable or anon key for `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`.
   - Secret key for `SUPABASE_SECRET_KEY`.
   - Database connection string for `DATABASE_URL`.
   - Database password for `SUPABASE_DB_PASSWORD`.
3. In Supabase Auth URL settings, set the production site URL after the Vercel production domain is known.
4. Add redirect URLs for each deployed app origin that can complete sign-in:
   - `https://<production-domain>/auth/callback`
   - `https://<preview-domain>/auth/callback` for any preview environment used for QA.

## 2. Google OAuth In Supabase

1. In Google Cloud Console, create an OAuth client for a web application owned by Automation Systems.
2. Add the Supabase callback URL as an authorized redirect URI:
   - `https://<supabase-project-ref>.supabase.co/auth/v1/callback`
3. In Supabase Dashboard, open Authentication, Providers, Google.
4. Enable Google and paste the Google OAuth client ID and client secret.
5. Save the provider settings.

The login UI sends Google the `hd=automationsystems.org` hint, but that is not the security boundary. The server enforces the allowed domain and the CRM `users` table remains authoritative for role, allowed tags, and active state.

## 3. Allowed Domain Restriction

Set:

```text
CRM_ALLOWED_DOMAIN=automationsystems.org
```

The app rejects signed-in emails outside this domain in server-side auth context checks. A Google account from the right domain must still exist in `public.users` and must be active before it can use the CRM.

## 4. Vercel Environment Variables

Configure these variables in the Vercel project for Production and for any Preview environment that should run against Supabase:

```text
NEXT_PUBLIC_SUPABASE_URL
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY
SUPABASE_SECRET_KEY
DATABASE_URL
SUPABASE_DB_PASSWORD
CRM_ALLOWED_DOMAIN
CRM_COMPANY_NAME
```

Use Vercel's environment variable UI or CLI. Keep browser-safe variables limited to the `NEXT_PUBLIC_` names. Never expose `SUPABASE_SECRET_KEY`, `DATABASE_URL`, or `SUPABASE_DB_PASSWORD` to browser code.

## 5. Database Migration

Run migrations from a trusted workstation or CI job with `DATABASE_URL` set to the Supabase Postgres connection string:

```powershell
$env:DATABASE_URL = "<supabase-postgres-connection-string>"
node scripts/apply-migrations.mjs
```

The migration runner records applied files in `public.schema_migrations` and skips files already applied.

## 6. Initial Admin Seed

After migrations, seed the first L6 CRM admin. The email must belong to `CRM_ALLOWED_DOMAIN`:

```powershell
$env:DATABASE_URL = "<supabase-postgres-connection-string>"
$env:CRM_ALLOWED_DOMAIN = "automationsystems.org"
node scripts/seed-admin.mjs admin@automationsystems.org "Admin Name"
```

Use a real Automation Systems admin account for production. After the first admin signs in, manage additional users from the CRM Admin area.

## 7. Deploy To Vercel

1. Connect the repository to a Vercel project.
2. Confirm Vercel uses `npm install` and `npm run build`.
3. Deploy a preview and complete smoke testing.
4. Promote or deploy to production only after migrations, admin seed, Google OAuth redirects, and environment variables are confirmed.

## 8. Verification

Run the local checks before deploying:

```powershell
npm run typecheck
npm run test
npm run build
```

For the e2e smoke test without real Google login, point the app at the local fake Supabase Auth endpoint used by the Playwright spec:

```powershell
$env:NEXT_PUBLIC_SUPABASE_URL = "http://127.0.0.1:3999"
$env:NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY = "playwright-publishable-key"
$env:CRM_ALLOWED_DOMAIN = "automationsystems.org"
npm run test:e2e
```

When testing against a real Supabase project, keep the unauthenticated login-gate check and use a preview environment with test CRM users for manual sign-in validation.

## 9. Credential Rotation Before Go-Live

Before production launch, rotate every credential that was pasted into local setup, shared during migration, or used in preview testing:

```text
Supabase secret key
Supabase database password
DATABASE_URL values derived from the database password
Google OAuth client secret
Any temporary preview-only or setup-only credentials
```

After rotation, update Vercel Production and Preview environment variables, redeploy, rerun migrations to verify connectivity, and rerun the smoke checks. Remove or deactivate temporary admin users before go-live.
