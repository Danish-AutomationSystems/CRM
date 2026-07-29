# Task 2 Schema Report

## Scope

Implemented Task 2 only: Supabase migration SQL, database client/schema helpers, CRM ID allocation, default settings, migration/admin scripts, and focused tests.

## Red/Green Evidence

- RED defaults: `npm run test -- src/server/settings/defaults.test.ts`
  - Failed as expected because `./defaults` did not exist.
- GREEN defaults: `npm run test -- src/server/settings/defaults.test.ts`
  - Passed: 2 tests.
- RED IDs: `npm run test -- src/server/db/ids.test.ts`
  - Failed as expected because `./ids` did not exist.
- GREEN Task 2 tests: `npm run test -- src/server/db/ids.test.ts src/server/settings/defaults.test.ts`
  - Passed: 2 files, 6 tests.

## Commands Run

- `npm run test -- src/server/settings/defaults.test.ts`
  - Initial result: failed for missing defaults module.
  - Final result: passed, 2 tests.
- `npm run test -- src/server/db/ids.test.ts`
  - Initial result: failed for missing IDs module.
- `npm run test -- src/server/db/ids.test.ts src/server/settings/defaults.test.ts`
  - Final result: passed, 6 tests.
- `npm run typecheck`
  - Initial result: failed on Postgres transaction and overload types.
  - Final result: passed.
- `node --check scripts/apply-migrations.mjs`
  - Initial result: failed on TypeScript generic syntax in `.mjs`.
  - Final result: passed.
- `node --check scripts/seed-admin.mjs`
  - Final result: passed.

## Files Changed

- `supabase/migrations/0001_initial_schema.sql`
- `src/server/db/client.ts`
- `src/server/db/schema.ts`
- `src/server/db/ids.ts`
- `src/server/db/ids.test.ts`
- `src/server/settings/defaults.ts`
- `src/server/settings/defaults.test.ts`
- `scripts/apply-migrations.mjs`
- `scripts/seed-admin.mjs`
- `docs/superpowers/agent-reports/task-2-schema-report.md`

## Notes

- Migration creates the CRM tables from the Apps Script data model: users, customers, contacts, handlers, cases, actions, quotations, quote_boq, recycle_bin, settings, counters, activity_log, import_customers, and import_contacts.
- RLS is enabled on CRM tables with explicit deny policies for browser roles `anon` and `authenticated`; server-mediated access is expected through `DATABASE_URL`.
- No real Supabase credentials were added.
- The migration was not applied to a live Supabase database in this task because no real `DATABASE_URL` should be used in committed files.

## Concerns

- Live migration execution still needs to be validated against the target Supabase project once environment variables are configured outside git.
- Future service tasks must continue to enforce the full L1-L6 authorization model server-side; RLS here is defense-in-depth deny-by-default, not the business-rule engine.
