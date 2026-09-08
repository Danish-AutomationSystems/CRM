# Case lifecycle and deferred customer mapping

Approved by the user on 2026-09-07: all three proposed flows approved.

## Product contract

1. Quoted cases have no ticket holder, including existing cases. Entering Quoted clears the assignee; assignment and attachment handover are unavailable while Quoted. Case owners are unchanged.
2. Requesting revision moves an open Quoted case to Revision and requires selecting an active ticket holder. Revision stays active while a draft is prepared. Marking the revised quotation Sent returns the case to Quoted and clears the holder. Repeat revisions use the same flow.
3. L2+ can register a Lead or Opportunity without a customer. Existing assignment defaults apply; the creator is its initial owner. Case owners, assignee, and L4+ can see the case. Other users gain no visibility merely because the customer is missing.
4. Saving the first generated or uploaded quotation requires choosing a real customer the caller can fully access. That save atomically maps the customer, creates the quotation and logs mapping. The caller must also be L2+ with access to the source case. Keep existing case owners and assignee (unless Sent clears it); never create customer handler membership implicitly. No remapping an already mapped case.

## Detailed behavior

- Revision request is an explicit case action (also used by the quote viewer's New revision action), independent of actually saving the next quote row. Confirming the holder changes stage and assignment atomically; canceling the dialog changes nothing. Use the existing handover note and attachment flow. Permit reassignment within Revision.
- A revision draft must not silently leave a case in Quoted. Creating a new draft revision of a Quoted case requires requesting revision first. Uploaded Sent revisions may finish an existing Revision directly. Existing quotation revision numbering, supersession and customer/case checks remain.
- The stage picker offers Revision through the holder-selection dialog. Existing moves to Lead/Opportunity remain available; there is no requested irreversible stage ordering. Quoted cannot acquire a holder by ordinary reassignment. Closed Won/Lost cases must be reopened before revision; Hold retains its existing reopen semantics and cannot start revision until reopened.
- Customerless cases display `Customer not mapped` and have no broken customer links. Creation requires a title and otherwise uses existing priority/details/assignment behavior. Existing customer-first creation and quick log remain available, with a customer-later option.
- A customer is required before a customerless case can become Quoted or Won; first quotation save supplies it. Customer mapping is only performed as part of saving a quotation, not a standalone map operation. Failed uploads or quotation saves must not leave a mapped case without its saved quotation.
- Once customer mapping succeeds, normal customer access rules apply as before. Existing stored owners retain case visibility but do not gain customer or quotation access unless otherwise entitled. Customer handlers are not added to the stored owner set by mapping.
- Clearing a ticket may remove an assignment-only user's visibility; the UI must finish the action without rendering a broken case page, returning to the case list/dashboard when needed.

## Architecture and correctness

- Keep the legacy source in `docs/source-appscript/Index.html`; regenerate with `node scripts/port-legacy-index.mjs`. CSS remains hand maintained.
- Add Revision to fixed stage constants and the database stage constraint. Add a Quoted-without-assignee check, backfilling existing Quoted holders to NULL and auditing the cleanup. Do not rewrite old migrations.
- Add a separate migration making cases.customer_id nullable while retaining its FK. Quotations.customer_id remains required. Use NULL in PostgreSQL and the existing empty-string DTO convention in services to limit contract churn.
- Use a shared database case-update helper for atomic column patches and row locking rather than stale whole-row replacement. Transactional state transitions re-read and validate the locked row. Cover both cases and quotations repositories. Quotation family lock order must be consistent across revision allocation and status changes.
- Customer mapping locks/rechecks the case, authorizes source case and target customer independently, maps only once, and commits together with quotation persistence. Network upload calls remain outside database transactions. A failed commit cleans up only the operation's own unreferenced upload.
- Existing case column guards must continue covering persisted columns; mapping makes customer_id mutable explicitly, not through a weakened exemption.
- No new production dependencies. No unrelated refactors or changes to accounting/BOQ/credit rules. Do not change live data or deploy as part of this local implementation.

## Verification and rollout

Test first, observe intended failures, implement, and verify service, SQL boundary, UI, and integration behavior. Cover assignment races, draft/Sent transitions, source/target permission denial, mapping rollback and conflicting concurrent mappings. Run the full Vitest suite, TypeScript, production build and mocked Playwright flows.

Deployment requires database backup and applying the new migrations with a coordinated application rollout. This task prepares code and migration files locally; live migration/deployment remains a separate action.
