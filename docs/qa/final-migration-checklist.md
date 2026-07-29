# AS CRM Migration Final Checklist

## Verified In Code

- Apps Script source API parity: 44 Apps Script `api_*` functions, 44 UI-called APIs, 44 registered Vercel RPC handlers.
- Google sign-in architecture: Supabase Auth session plus CRM `users` table role/tag/active enforcement.
- Allowed domain: `automationsystems.org`.
- L1-L6 customer access matrix.
- Case visibility: handler owners, extra owners, assignee-only visibility, full customer access, and L4+.
- Ticket assignment does not grant customer details access.
- Customer, contact, handler, grid, soft-delete, and recycle-bin service behavior.
- Case stage/outcome, owner, assignee, Hold, Won/Lost, dashboard, workspace, and quick-log service behavior.
- Quotation numbering, revisions, superseding, Draft/Sent behavior, BOQ storage, tax calculation, and direct download artifact behavior.
- Admin users, settings, imports, recycle-bin, and stack-safe admin links.
- Race-sensitive service boundaries for IDs, quote revisions, grid patches, and delete/create conflicts.
- Login-gated CRM shell and mocked authenticated route smoke tests.

## Verification Commands

Last verified locally:

```powershell
npm run typecheck
npm run test
npm run build
$env:NEXT_PUBLIC_SUPABASE_URL='http://127.0.0.1:3999'; $env:NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY='playwright-publishable-key'; $env:CRM_ALLOWED_DOMAIN='automationsystems.org'; npm run test:e2e
node scripts/check-api-parity.mjs
```

Expected current results:

- TypeScript: pass.
- Unit/integration tests: 102 tests pass.
- Build: pass.
- Playwright smoke: 2 tests pass.
- API parity: `44 UI calls, 44 Apps Script APIs, 44 registered RPCs`.

## Known Limitations Before Go-Live

- The Task 10 frontend is a parity shell and high-value route surface, not a full port of every deep Apps Script modal/grid workflow yet. Backend API parity is complete, but the browser UI still needs full workflow expansion before calling this production-ready for sales users.
- Live Supabase database migrations have not been applied in this local session.
- Live Google OAuth has not been exercised because it requires configured Supabase OAuth credentials and a real `@automationsystems.org` test user.
- External uploaded quotation binary persistence is not implemented because Google Drive upload/storage is intentionally out of scope. The current migration preserves quotation metadata and generated direct-download artifacts. Use Supabase Storage later if external file preservation is required.
- Supabase credentials pasted during setup must be rotated before production launch.

## Production Readiness Gate

Do not announce production go-live until:

- Supabase project credentials are rotated.
- Supabase Google provider is configured with the Vercel callback URL.
- Vercel environment variables are configured in Production and Preview.
- `scripts/apply-migrations.mjs` runs successfully against Supabase.
- `scripts/seed-admin.mjs` seeds at least one active L6 user.
- A real office Google account signs in successfully.
- A live browser pass covers customer search/create, contact add, handler add/remove, case create/update, quote create/download, admin user save, import, recycle restore/purge, and role-restricted access.
