# Task 12 Deployment Configuration And Verification Report

## Summary

Added Vercel deployment configuration, a Supabase/Vercel deployment runbook, and Playwright smoke coverage for the login-gated CRM shell. Also excluded `tests/e2e/**` from Vitest so unit tests do not collect Playwright specs.

## Files Changed

- Created `vercel.json`
- Created `docs/deployment/vercel-supabase-setup.md`
- Created `tests/e2e/crm-smoke.spec.ts`
- Modified `vitest.config.ts`
- Created `docs/superpowers/agent-reports/task-12-deployment-report.md`

`.env.example` was not changed because the existing environment names already cover the deployment and seed scripts without adding new committed secret placeholders.

## Commands Run

```powershell
$env:NEXT_PUBLIC_SUPABASE_URL='http://127.0.0.1:3999'; $env:NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY='playwright-publishable-key'; $env:CRM_ALLOWED_DOMAIN='automationsystems.org'; npm run test:e2e -- tests/e2e/crm-smoke.spec.ts
```

Initial result: failed because Playwright Chromium is not installed. A parallel fake-auth port collision was also exposed and fixed by serializing the smoke spec.

```text
Executable doesn't exist at C:\Users\danis\AppData\Local\ms-playwright\chromium_headless_shell-1234\chrome-headless-shell-win64\chrome-headless-shell.exe
Please run the following command to download new browsers:
npx playwright install
```

```powershell
npm run typecheck
```

Final result: passed.

```powershell
npm run test
```

Initial result: failed because Vitest collected `tests/e2e/crm-smoke.spec.ts`. Final result after excluding `tests/e2e/**`: passed, 16 test files and 102 tests.

```powershell
npm run build
```

Final result: passed.

```powershell
$env:NEXT_PUBLIC_SUPABASE_URL='http://127.0.0.1:3999'; $env:NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY='playwright-publishable-key'; $env:CRM_ALLOWED_DOMAIN='automationsystems.org'; npm run test:e2e
```

Final result: failed because Playwright Chromium is not installed. No browser smoke assertion completed.

## Smoke Test Coverage

- Unauthenticated `/crm` visit should redirect to `/login?next=%2Fcrm` and show the Google sign-in gate.
- Mocked authenticated shell uses a local fake Supabase Auth endpoint plus a mocked `api_bootstrap` RPC response.
- Critical shell checks cover dashboard, customers, cases, case detail quotation download link, and admin route containers.

## Deployment Runbook Coverage

- Supabase Google OAuth setup.
- Allowed domain restriction with `CRM_ALLOWED_DOMAIN=automationsystems.org`.
- Vercel environment variables.
- Migration command.
- Admin seed command.
- Production credential rotation before go-live.

## Concerns

- Initial Playwright execution failed because Chromium was missing locally. After running `npx playwright install chromium`, the mocked Supabase smoke command passed with 2 tests.
- The mocked-auth Playwright smoke path expects `NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:3999` and a dummy publishable key for local no-Google testing. Real preview validation still needs an actual Supabase project and test CRM user.

## Post-Report Verification Update

```powershell
npx playwright install chromium
```

Result: Chromium and the headless shell installed successfully.

```powershell
$env:NEXT_PUBLIC_SUPABASE_URL='http://127.0.0.1:3999'; $env:NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY='playwright-publishable-key'; $env:CRM_ALLOWED_DOMAIN='automationsystems.org'; npm run test:e2e
```

Result: passed, 2 Playwright smoke tests.
