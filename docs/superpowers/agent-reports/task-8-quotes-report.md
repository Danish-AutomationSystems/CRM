# Task 8 Quotes Report

## Status

Implemented Task 8: Quotations And Direct Downloads.

## Red Evidence

Command:

```powershell
npm run test -- src/server/quotes/service.test.ts src/server/quotes/render.test.ts
```

Result: failed as expected before implementation.

Evidence:

- `src/server/quotes/render.test.ts` failed to resolve `./render`.
- `src/server/quotes/service.test.ts` failed to resolve `./service`.
- Vitest reported 2 failed suites.

## Green Evidence

Command:

```powershell
npm run test -- src/server/quotes/service.test.ts src/server/quotes/render.test.ts
```

Result: passed.

Evidence:

- 2 test files passed.
- 12 tests passed.

Command:

```powershell
npm run typecheck
```

Result: passed.

Evidence:

- `tsc --noEmit` exited 0.

## Files Changed

- `src/server/quotes/repository.ts`
- `src/server/quotes/service.ts`
- `src/server/quotes/service.test.ts`
- `src/server/quotes/render.ts`
- `src/server/quotes/render.test.ts`
- `src/server/quotes/rpc.ts`
- `src/app/api/download/quote/[quoteNo]/[rev]/route.ts`
- `src/app/api/rpc/route.ts`

## Behavior Covered

- Quote numbering uses `QTN-YYYY-NNNN`.
- First revision is `R0`.
- New revisions increment and supersede prior Draft/Sent revisions.
- Draft generated quotes do not advance the case.
- Sent quotes advance open cases to `Quoted`.
- Held or closed cases are not advanced by quote status changes.
- Manual subtotal is preserved and GST/tax/total are calculated from it.
- BOQ blocks are normalized and stored as JSON-ready headers/rows.
- Generated quote document API returns direct download metadata/URLs.
- External uploads store CRM metadata and direct download URLs without Google Drive links.
- Download artifacts enforce full customer access through the quote service.
- Attachment responses include `Content-Disposition: attachment`.

## Commands Run

- `npm run test -- src/server/quotes/service.test.ts src/server/quotes/render.test.ts` - red check failed on missing quote modules.
- `npm run test -- src/server/quotes/service.test.ts src/server/quotes/render.test.ts` - green check passed, 12 tests.
- `npm run typecheck` - passed.
- `npm run test -- src/server/quotes/service.test.ts src/server/quotes/render.test.ts` - final focused check passed, 12 tests.
- `npm run typecheck` - final typecheck passed.

## Concerns

- The existing Task 2 schema has quotation metadata columns but no dedicated binary/blob column for uploaded external files. The migration now records external quotation metadata and serves an access-checked direct route artifact without using Google Drive. Persisting original uploaded binaries would need a future schema/storage decision.
