# Task 4 Access Report

## Status

Implemented Task 4: Authorization Engine.

## Red Evidence

Command:

```powershell
npm run test -- src/server/auth/access.test.ts
```

Result: failed before implementation because `src/server/auth/access.test.ts` could not resolve `./access`.

Relevant output:

```text
FAIL src/server/auth/access.test.ts [ src/server/auth/access.test.ts ]
Error: Failed to resolve import "./access" from "src/server/auth/access.test.ts". Does the file exist?
```

## Green Evidence

Command:

```powershell
npm run test -- src/server/auth/access.test.ts
```

Result: passed.

```text
Test Files  1 passed (1)
Tests       20 passed (20)
```

Command:

```powershell
npm run typecheck
```

Result: passed.

```text
tsc --noEmit
```

## Files Changed

- `src/server/domain/types.ts`
- `src/server/domain/lists.ts`
- `src/server/auth/access.ts`
- `src/server/auth/access.test.ts`
- `docs/superpowers/agent-reports/task-4-access-report.md`

## Authorization Behaviors Covered

- L1 through L6 customer access matrix.
- Matching and non-matching customer tags.
- Wildcard tag behavior.
- Account handler full customer access.
- L3 name-only access outside assigned tags.
- Case visibility for handlers, assignees, extra owners, full customer access, and L4+.
- Name-only customer access does not imply case visibility.
- Stored owner fallback applies only when a customer has no real handlers.
- Ticket assignment and extra ownership do not grant customer access.
- Guard functions throw stable authorization errors.

## Concerns

- `vitest` prints the existing Vite CJS Node API deprecation warning during test runs. The requested test command still exits 0 after implementation.
