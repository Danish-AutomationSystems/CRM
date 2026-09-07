# Case Lifecycle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** Enforce no holder in Quoted, add Revision with reassignment, and map customerless cases when their first quotation is saved.

**Architecture:** Retain RPC/service/repository layers and the generated legacy frontend. Protect case state with atomic SQL patches and locked transactional transitions. Nullable customer IDs are limited to cases; quotations remain customer-bound.

**Tech Stack:** Next.js 15, TypeScript, postgres.js, Supabase, Google Drive, Vitest, Playwright.

## Global Constraints

- Quoted cases have no ticket holder. Case owners remain unchanged.
- Requesting revision moves an open Quoted case to Revision and requires selecting an active ticket holder. Sending the revised quotation returns it to Quoted and clears the holder.
- Customerless creation is L2+. Visibility is limited to case owners, assignee, and L4+.
- First quotation save maps an accessible real customer atomically; authorize the source case separately. Never grant customer handler membership or replace stored owners during mapping.
- No remapping an already mapped case. Customerless cases cannot become Quoted or Won before mapping.
- Keep current quotation numbering, supersession, manual BOQ totals, and customer access rules.
- Edit docs/source-appscript/Index.html and regenerate the artifact; never hand-edit the generated bundle.
- Tests first, with recorded failing and passing commands. No live database calls, migrations, deployment, or secret reads. No new production dependencies.
- All implementation occurs in the provided feature worktree. Do not modify main or other agents' files. Commit completed tasks and write reports in the plan's ignored SDD workspace.

### Task 1: Quoted invariant and revision server lifecycle

**Files:** src/server/cases/{service,repository,rpc}.ts and tests; src/server/quotes/{service,repository}.ts and tests; src/server/db/schema.ts; src/server/settings/defaults.ts; new src/server/db/case-write.ts and tests; new supabase/migrations/0012_case_revision_workflow.sql; src/server/integration/concurrency.test.ts; affected test fixtures/column guards.

**Interfaces:** Extend assignTicket(user, caseId, who, note?, uploads?, requestRevision?: boolean) and api_assignTicket's final sixth argument. With requestRevision=true, validate open Quoted or Revision, set Revision and holder in one transaction; repeat request on Revision may reassign. Extend beginAttachmentUpload(user, caseId, files, requestRevision?: boolean) similarly for preparation. Return the existing assignment response plus stage. getCase returns canRequestRevision (open Quoted and visible) and canAssignTicket false for Quoted. Require using this action to enter Revision; setCaseStage('Revision') rejects with a clear instruction to select a ticket holder. SQL helper lockCase(id) is exposed through both repository contracts for transactional re-read; document final signature in report.

- [ ] Write table-driven service tests with hand-derived fixtures for entering Quoted clearing the holder; same-stage Quoted repairs stale assignee; create/quickLog Quoted cannot retain holder; Sent quote auto-case and existing case clear holder; Quoted assign and attachment preparation reject; Revision request requires a valid active holder and keeps owners; closed/Hold requests reject; Draft revision stays Revision and Sent returns Quoted. Include quoted draft-revision rejection before revision request.

```ts
await service.setCaseStage(user, caseId, 'Quoted');
expect(repo.cases.get(caseId)?.assignee).toBe('');
await expect(service.assignTicket(user, caseId, target)).rejects.toThrow();
await service.assignTicket(user, caseId, target, '', [], true);
expect(repo.cases.get(caseId)).toMatchObject({stage: 'Revision', assignee: target});
```

- [ ] Run focused tests and record expected RED. Existing fakes may use arrays rather than maps; adapt fixture access to actual fake without changing expected values.
- [ ] Implement minimal shared SQL patch helper; update only supplied fields and version, never reconstitute an entire stale row. Preserve mappings of arrays/pipes/nulls. Row lock and revalidate eligibility for stage changes, assignment (after uploads), outcome changes and Sent quote advancement; use consistent case/quote-family lock ordering. An unrelated title/priority patch cannot revert stage or assignee.

```sql
-- Within the transaction that validates and changes case workflow:
select case_id from public.cases where case_id = $1 for update;
-- New invariant after auditing and clearing existing quoted holders:
alter table public.cases add constraint cases_quoted_unassigned_check
  check (stage <> 'Quoted' or assignee is null);
```

- [ ] Extend stages to Lead, Opportunity, Quoted, Revision in app and additive migration. Backfill existing assigned Quoted cases, preserving owners and recording activity. Fixed legacy owner/quote constraints stay intact. Handle Sent on existing Quoted repair and creation paths. Prevent older superseded quote status races from changing a newer revision's case.
- [ ] Add SQL-boundary tests for atomic patches and locks, and controlled concurrency tests proving stale writes cannot restore holder/stage. Extend existing parity allowlists only if new RPCs are introduced (prefer existing signatures above).
- [ ] Run focused tests, full npm test and npm run typecheck, self-review, commit. Report contracts, commands, failures observed, results and remaining cross-task items.

### Task 2: Customerless cases and transactional quotation mapping

**Files:** src/server/cases/{service,repository}.ts and tests; src/server/quotes/{service,repository}.ts and tests; src/server/dashboard/service.ts and tests; src/server/domain/types.ts if needed; shared SQL helper from Task 1; new supabase/migrations/0013_customerless_cases.sql; db column guards; integration tests and repository fakes.

**Interfaces:** Empty customerId to createCase means customerless. quickLog adds explicit customerLater?: boolean; never interpret a misspelled supplied customer ID as no customer. Service CaseRow continues customerId:string (empty means absent); repository converts NULL to/from ''. getCase returns customer:null for genuinely unmapped cases plus canMapCustomer:boolean (L2+ and visible) and canQuote true only via mapping for such cases. List/dashboard labels use Customer not mapped. Quote create/upload continue input.customerId plus input.caseId; no separate mapping endpoint.

- [ ] Add RED tests for L2+ creation without customer; L1 denial; creator ownership; existing assignment defaults; case detail/list/dashboard visibility to owner/assignee/L4+ and denial to others; missing nonempty customer ID remains an error. Quote creation/upload denial for source-case outsiders and NAME/NONE target customers; correct mapping and rollback; no customer handler/owner changes; conflict rejects on concurrent differing customer mappings. Tests must exercise services and SQL boundary, not just fake behavior.

```ts
const created = await cases.createCase(sales, '', {title:'New enquiry'});
expect((await cases.getCase(sales, created.id)).customer).toBeNull();
await expect(cases.getCase(unrelatedSales, created.id)).rejects.toThrow();
// Saving a first quote with an accessible target atomically maps this case.
```

- [ ] Run targeted RED and record it. Add migration dropping cases.customer_id NOT NULL, retaining FK; add CHECK requiring customer for Quoted/Won. No data backfill for nullable customer.
- [ ] Adapt access/read paths to distinguish null customer from invalid dangling customer. Use customerAccess='NONE' for unmapped case and existing caseVisible. Preserve ownership defaults and existing mapped-case behavior. Permit unmapped Lead/Opportunity creation and Revision-compatible updates, but forbid Quoted/Won without mapping.
- [ ] Authorize target with existing ensureFull and source case separately (L2+ and visible) before external upload or transaction. For mapping, lock and reread case inside quote transaction, reject changed target, update customerId and log CASE_CUSTOMER_MAP in same transaction as quote persistence. Keep owners/assignee except Sent clears holder. No early permanent mapping on opening builder or uploading bytes. Existing mapped-case mismatch remains rejected. Both generated and uploaded first quotes use same mapping semantics.

```sql
alter table public.cases alter column customer_id drop not null;
alter table public.cases add constraint cases_quoted_customer_check
  check ((stage <> 'Quoted' and outcome is distinct from 'Won') or customer_id is not null);
```

- [ ] Update repository nullable mapping and column guards without broadening exemptions. Cover mapping rollback and concurrent mapping with controlled tests; check quote revision paths remain attached to the same customer/case.
- [ ] Run focused tests, full npm test and typecheck; self-review and commit. Report exact changed payloads for frontend implementer.

### Task 3: User flows in the generated legacy frontend

**Files:** docs/source-appscript/Index.html; scripts/port-legacy-index.mjs only for necessary transformations; src/app/crm/legacy-full.generated.ts regenerated; src/app/crm/legacy-app.test.ts.

**Interfaces:** Task 1's api_assignTicket sixth argument true requests Revision; api_beginAttachmentUpload fourth argument true prepares revision attachments. Case DTO customer can be null, case.customerId='' then canMapCustomer controls mapping affordance. api_createCase('', input) and api_quickLog({...customerLater:true}) create unmapped cases. api_createQuotation/api_uploadQuotation still receive the selected customerId plus original caseId. Server contracts in prior reports govern exact response field names.

- [ ] Write failing jsdom interaction tests: Quoted renders no holder/reassign action but Request revision opens holder dialog; cancel sends no write; confirmation sends revision flag and selected active holder; New revision from quote viewer on Quoted first requests holder and only then opens builder; Revision permits normal reassignment; changed stage refreshes case without ticket access errors. Mock RPC boundary only; use the real legacy UI.
- [ ] Add failing creation/mapping tests: Cases New case offers create without customer; quick log explicit customer-later toggle; unmapped details/list labels never dereference null; quote and upload choose accessible customer before save while retaining case ID; cancel does not map; successful save refreshes mapped customer. No form placeholders (existing product choice).

```js
// The confirmed revision dialog submits the existing assignment RPC with flag:
gs('api_assignTicket', caseId, selectedEmail, note, uploadedFiles, true);
// A first quote on an unmapped case submits BOTH the original case and selected customer:
gs('api_createQuotation', {caseId: originalCaseId, customerId: selectedCustomerId, ...quoteFields});
```

- [ ] Record RED. Implement source edits, reuse current customer search and holder note/attachment controls. Request-revision confirmation may remain in Revision if the later quote form is canceled, because the user confirmed a work request. Changing to Revision via stage picker must open holder dialog rather than bypass server checks. Preserve current owner displays. A selected customer must have FULL access; display only search-visible data until full access is established.
- [ ] Regenerate and run targeted tests; handle generated inline JS with existing jsArg transforms. Ensure Quoted change by assignment-only user returns to their dashboard safely. Include new labels/controls with accessible names, no placeholder text.
- [ ] Run full npm test and typecheck, self-review, commit and report.

### Task 4: End-to-end regression coverage and handoff documentation

**Files:** tests/e2e/crm-smoke.spec.ts; src/server/integration/crm-flows.test.ts; CONTEXT.md; docs/qa/case-lifecycle-checklist.md; scripts/check-api-parity.mjs only if new API changes expose stale tool behavior.

- [ ] Add failing interaction regression tests that distinguish the new full lifecycle from the old behavior: create customerless case, choose customer at first quotation save, mark Sent/no holder, request Revision/select holder, save revision, mark Sent/no holder. Exercise generated and external quote entry points across focused tests; preserve existing role gates and old customer-first path. Use mocked external services and auth, not production.
- [ ] Run tests and record RED (test against pre-feature artifact or documented meaningful temporary mutation if existing implementation already passes; restore before GREEN). Adjust implementation only for demonstrated integration defects, with focused tests.
- [ ] Run npm test, npm run typecheck, npm run build and mocked Playwright. Run generator reproducibility check by hash before/after regeneration. Report exact outcomes; do not label live production verified.
- [ ] Update CONTEXT.md with new product rules, migration order, source workflow and validation. Write rollout checklist for backup, migration 0012 then 0013, coordinated deploy, existing Quoted holder cleanup, and live role/quote/Drive checks. No live execution.
- [ ] Commit and report. Controller then requests an independent full-branch review, resolves findings and performs final relevant validation.
