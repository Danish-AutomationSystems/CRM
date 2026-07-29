# Task 5 RPC Compatibility Layer Report

## Summary

Implemented the Apps Script-compatible RPC compatibility layer for Task 5 only.

## Red Evidence

Command:

```powershell
npm run test -- src/server/rpc/registry.test.ts src/client/gs.test.ts
```

Result: failed as expected before production implementation.

Evidence:

```text
FAIL src/client/gs.test.ts
Error: Failed to resolve import "./gs" from "src/client/gs.test.ts". Does the file exist?

FAIL src/server/rpc/registry.test.ts
Error: Failed to resolve import "./registry" from "src/server/rpc/registry.test.ts". Does the file exist?
```

Note: an earlier run found no tests because the first test patch landed in the parent workspace instead of `migrated-crm`; the tests were moved into the correct project before recording the real RED failure above.

## Green Evidence

Command:

```powershell
npm run test -- src/server/rpc/registry.test.ts src/client/gs.test.ts
```

Result:

```text
Test Files  2 passed (2)
Tests       8 passed (8)
```

Command:

```powershell
npm run typecheck
```

Result:

```text
tsc --noEmit
```

Exit code: 0.

## Files Changed

- `src/server/rpc/errors.ts`
- `src/server/rpc/registry.ts`
- `src/server/rpc/registry.test.ts`
- `src/app/api/rpc/route.ts`
- `src/client/gs.ts`
- `src/client/gs.test.ts`
- `docs/superpowers/agent-reports/task-5-rpc-report.md`

## Behavior Covered

- `gs(fn, ...args)` posts `{ fn, args }` to `/api/rpc`.
- RPC success responses use `{ ok: true, data, metadata }`.
- RPC failures use `{ ok: false, error }`.
- Unknown RPC functions return safe 404-style errors.
- Auth/user-facing errors are normalized to a first-line safe message without stack traces.
- Explicit `RpcError` status/message values are preserved.
- Non-read registrations return `metadata.bustClientCache: true` for client cache invalidation.

## Concerns

- Task 5 creates the compatibility layer only; no real `api_*` business handlers are registered yet. Later tasks must register migrated handlers through `registerRpc`.
- Vitest prints the existing Vite CJS API deprecation warning during tests; it does not fail the suite.
