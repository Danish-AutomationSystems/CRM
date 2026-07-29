# Task 6 Customers, Contacts, Handlers, And Grid APIs

## Status

Implemented Task 6 customer/contact/handler/grid service, repository, and RPC registration.

## Red/Green Evidence

- Red: `npm run test -- src/server/customers/service.test.ts`
  - Result: failed before implementation because `./service` could not be resolved from `src/server/customers/service.test.ts`.
- Green: `npm run test -- src/server/customers/service.test.ts`
  - Result: passed, 12 tests passed.
- Verification: `npm run typecheck`
  - Result: passed.

## Files Changed

- `src/app/api/rpc/route.ts`
- `src/server/customers/repository.ts`
- `src/server/customers/rpc.ts`
- `src/server/customers/service.ts`
- `src/server/customers/service.test.ts`
- `docs/superpowers/agent-reports/task-6-customers-report.md`

## Commands Run

- `npm run test -- src/server/customers/service.test.ts`
  - Red result: failed with missing `./service`.
- `npm run test -- src/server/customers/service.test.ts`
  - Green result: 12 tests passed.
- `npm run typecheck`
  - Result: passed.
- `npm run test -- src/server/customers/service.test.ts`
  - Final result: 12 tests passed.
- `npm run typecheck`
  - Final result: passed.

## Coverage Notes

Tests cover customer search caps, L2 name-only results, 400-row my-customer grid cap, duplicate-name guard with `force`, creator handler behavior including `direct`, first contact creation, field-level edit rights, partial success for `saveCustomerCells`, customer delete blocking for cases/quotes, recycle-bin movement, contact CRUD, bulk contact import, bulk customer import caps and duplicate skipping, username email expansion, active-user validation, Direct placeholder removal, duplicate handler rejection, and handler removal.

## Concerns

- `api_getCustomer` currently returns empty `cases` and `quotes` arrays because Task 6 explicitly excludes implementing cases/quotes services beyond delete-blocking existence checks.
- The repository is mapped to the Task 2 schema and typechecks, but these tests use injected fakes and do not require or exercise a live Supabase database.
