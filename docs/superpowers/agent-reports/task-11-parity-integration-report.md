# Task 11 Parity, Integration, And Race Test Report

## Summary

Added Task 11 coverage for API parity, an offline integrated CRM flow, and concurrency-sensitive behavior. The parity checks extract `api_*` functions from `docs/source-appscript/Code.gs`, extract `gs('api_*')` calls from `docs/source-appscript/Index.html`, and compare both against the registered Vercel RPC handlers.

## Red/Green Evidence

- RED: `npm run test -- src/server/rpc/api-parity.test.ts src/server/integration/crm-flows.test.ts src/server/integration/concurrency.test.ts` initially failed with `listRegisteredRpcs is not a function` in `src/server/rpc/api-parity.test.ts`.
- GREEN: after adding registry introspection, the same targeted suite passed with 3 files and 7 tests passing.
- Script check: `node scripts/check-api-parity.mjs` passed with `API parity ok: 44 UI calls, 44 Apps Script APIs, 44 registered RPCs.`
- Typecheck: `npm run typecheck` passed.

## Files Changed

- Created `src/server/rpc/api-parity.test.ts`
- Created `src/server/integration/crm-flows.test.ts`
- Created `src/server/integration/concurrency.test.ts`
- Created `scripts/check-api-parity.mjs`
- Modified `src/server/rpc/registry.ts`
- Created `docs/superpowers/agent-reports/task-11-parity-integration-report.md`

## Commands Run

```powershell
npm run test -- src/server/rpc/api-parity.test.ts src/server/integration/crm-flows.test.ts src/server/integration/concurrency.test.ts
```

Initial result: failed as RED because the registry did not expose registered handler names. Final result: passed, 7 tests.

```powershell
node scripts/check-api-parity.mjs
```

Final result: passed, 44 UI calls, 44 Apps Script APIs, 44 registered RPCs.

```powershell
npm run typecheck
```

Initial result after green tests: failed on fake repository quote row shape mismatch. Final result after tightening fake adapters: passed.

## Concerns

- The integration and concurrency tests are offline service-level tests with injected fakes; they do not exercise live Supabase locking.
- The concurrency tests simulate transaction/advisory-lock serialization in the fake repository, so they verify service behavior at the transaction boundary rather than database engine behavior.

## Confirmed Remaining Parity Gaps

None found. The source Apps Script API list, UI-called API list, and registered RPC list all contain 44 matching `api_*` handlers.
