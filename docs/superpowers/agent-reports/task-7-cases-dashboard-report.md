# Task 7 Cases, Dashboards, Workspace, And Activity APIs

## Status

Implemented Task 7 case, dashboard, workspace, assignable-user, and activity-backed bootstrap APIs for the Vercel/Supabase migration.

## Red Evidence

- Command: `npm run test -- src/server/cases/service.test.ts src/server/dashboard/service.test.ts`
- Result: FAIL after adding the tests.
- Expected failure: Vitest could not resolve `src/server/cases/service.ts` / `src/server/dashboard/service.ts` because production modules did not exist yet.
- Note: An initial run before moving the test files into `migrated-crm` reported "No test files found"; the corrected red run from the app workspace failed for the intended missing-module reason.

## Green Evidence

- Command: `npm run test -- src/server/cases/service.test.ts src/server/dashboard/service.test.ts`
- Result: PASS, 2 test files and 11 tests passed.
- Command: `npm run typecheck`
- Result: PASS, `tsc --noEmit` exited 0.

## Files Changed

- `src/app/api/rpc/route.ts`
- `src/server/cases/repository.ts`
- `src/server/cases/rpc.ts`
- `src/server/cases/service.ts`
- `src/server/cases/service.test.ts`
- `src/server/dashboard/rpc.ts`
- `src/server/dashboard/service.ts`
- `src/server/dashboard/service.test.ts`

## Behavior Covered

- Case owners derive from customer handlers plus extra owners; stored owner is fallback only when no real handlers exist.
- Assignee is a single active CRM user; visible open cases can be reassigned to any active user.
- Won requires order value greater than zero and at least one valid category.
- Won/Lost clear assignee; Hold keeps assignee and blocks reassignment; changing stage from Hold clears Hold.
- Direct Won creation closes without an assignee; L5/L6 open case creation requires explicit assignee.
- `api_getCase` returns only minimal customer data for assignee-only users.
- Case list visibility, `mine` owner filtering, Open outcome filtering, search, quoted value, and 300 cap.
- Dashboard L1/L2-L4/L5-L6 differences, peer restrictions, won credit for co-handlers, dashboard list caps, recent activity filtering, and workspace partial failure tolerance.
- Exact Task 7 RPC names registered.

## Concerns

- The targeted Vitest command still emits the existing Vite CJS deprecation warning, but exits 0.
- Quote-backed values are implemented through the latest non-superseded quotation read; deeper quote behavior remains Task 8 scope.
