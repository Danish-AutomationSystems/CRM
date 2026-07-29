# AS CRM UI Flow Parity Report

Source reviewed: `docs/source-appscript/Index.html`, `AS_CRM_FUNCTIONALITIES.md`, `AS_CRM_PROJECT_CONTEXT.md`, `SETUP_GUIDE.md`, and the Vercel/Supabase migration design.

## Routes To Preserve

- `dash`: default route after boot. L1 sees `My work`; L2-L4 see personal dashboard stats plus assigned opportunity tickets; L5-L6 see back-office `Overview` with user-dashboard picker and no personal sales numbers.
- `customers`: search-first customer page. Empty search shows grid; 1 character prompts "Keep typing"; 2+ characters runs capped search and always shows the create-from-search panel.
- `customer/:id`: customer detail with breadcrumb, edit, case, quotation, upload quotation, details, handlers, contacts, cases, and latest quotations.
- `cases`: filtered case list with text search, stage, outcome, `Mine only`, and `+ New case`.
- `case/:id`: case detail with breadcrumb, owners/assignee controls, status/stage controls, details, quotations grouped by quote number/revision, and history.
- `admin`: L6-only admin area. Preserve the current guard message behavior, though the source text says "needs L5" while docs specify L6.
- Lock/error states: unregistered, setup pending, boot failure, retry/reload cards, top busy bar, and bottom toast feedback.

## Modals To Preserve

- Shared modal shell: overlay click and `Escape` close, close button, wide mode, sticky-ish footer action area, body scroll bounded by viewport.
- Restricted customer summary: name-only customer modal with tags/type/priority/handlers and "ask handler/L3+" guidance.
- Customer modals: new customer, edit customer, bulk add customers with preview, delete selected confirmation, handler filter, add/remove handler, add/edit/delete contact, bulk contacts with preview.
- Case modals: new case, pick customer then case, case owners, reassign ticket, mark won, mark lost, put on hold, edit case.
- Quick log modal: search existing customer, inline new customer mode, selected-customer state, save.
- Quotation modals: quote builder, upload external quotation, quote viewer, new revision, generated document/PDF progress.
- Admin modals: add/edit user and delete-forever recycle-bin confirmation.

## Key Buttons And Entry Points

- Header nav: `Dashboard`, `Customers`, `Cases`, `Admin`; hide `Customers` and `Cases` for L1; show `Admin` only when permitted; role badge remains top-right.
- Dashboard: stat cards navigate to filtered cases; `Whose dashboard` picker for eligible users; L5/L6 overview buttons for `Customers`, `Cases`, and `Admin`; assigned tickets include `Reassign`.
- Customers: `Bulk add`, `+ Create "<name>"`, `Fetch all customers` for L5/L6 all-grid, `Refresh`, `Clear filters`, `Delete selected`, row `open`, row `+ case`.
- Customer detail: `Edit`, `+ Case`, `+ Quotation`, `Upload quotation`, `+ Add handler`, `Remove`, contact `Edit`, `Delete`, `+ Add contact`, `Bulk add contacts`, quotation row `PDF`.
- Cases: `+ New case`, `Apply`, row open.
- Case detail: owner `manage`, assignee `reassign`, `Edit`, `+ Quotation`, `Upload quotation`, `Update stage`, `Mark Won`, `Mark Lost`, `Put on Hold`, `Reopen`, quote `PDF`, quote `Open`.
- Admin: `+ Add user`, list/default `Save...` buttons, `Run customer import`, `Run contact import`, recycle-bin `Restore`, `Delete forever`, Drive/admin links where applicable.
- Floating mobile/action button: `+ Quick log`, shown for L2+.

## Forms And Validation

- New customer: name required; tag/type/priority optional; Area, Address, GSTIN, Website, Notes, SEI, Remarks; optional first contact. Duplicate-name failure changes save action to `Create anyway`.
- Customer edit: L2+ can edit priority; L3+ can edit tag/type/archive status; lower levels see explanatory hints.
- Grid edits: inline fields for name, area, SEI, remarks; type and priority become editable only when allowed. Filters include blank sentinels and contact-count filters.
- Bulk customer/contact add: paste tab- or comma-separated rows, preview first 10 rows, then commit; empty/invalid rows block with toast.
- Handler and assignee inputs: user-facing input remains username/name driven; server appends/validates `@automationsystems.org`.
- New case: segmented `Lead`, `Opportunity`, `Order (Won)` control; title required; assignee defaults to current user except back-office users must choose; direct won order requires order value > 0 and at least one category.
- Case status: stage note optional; Won requires value and categories; Lost/Hold accept optional note; Reopen restores open state.
- Reassign ticket: owner suggestion bubbles plus searchable active-user list, no long default dropdown; save disabled until a user is picked.
- Quote builder: customer disabled, case select or auto-create option, title required, template required, valid-until, manual subtotal, GST %, currency, notes, one or more pasted BOQ tables with first row as headers and preview.
- External quote upload: customer disabled, case select or auto-create option, title required, status Draft/Sent, total required, currency, valid-until, file accept PDF/Word/Excel, 8 MB client cap, notes.
- Admin user form: email, name, L1-L6 role, active/inactive, allowed tags with All tags option and role hint.

## Optimistic And Perceived-Speed Behaviors

- Boot must warm identity, settings, nav, peers, dashboard, customers, and cases with as few round trips as practical.
- Views render from client cache immediately and revalidate in the background; repaint only when data differs.
- Read freshness windows matter: bootstrap about 45 seconds, workspace/list caches about 90 seconds.
- Non-read mutations bust cached workspace/customer/case state and refresh the current route behind the modal when relevant.
- Customer grid cell edits are optimistic: update local model instantly, show quiet unsaved outline, debounce about 700 ms, batch patches, show saved outline on success, rollback value/model and toast on failure.
- Background grid refresh must not repaint while cells are pending or focused.
- Long calls show busy bar and fail after a timeout with a retry-friendly message.

## Mobile Behavior

- Single responsive web app URL; no separate mobile app.
- Header wraps nav below brand/user chip on narrow screens; main padding tightens; stats become two columns; modal body height adapts to viewport.
- `+ Quick log` is fixed bottom-right and shown for L2+ to capture site enquiries.
- Quick log supports existing-customer search, no-access search rows, inline new customer creation, case title, stage defaulting to Lead, one-round-trip save, then navigation to the created case.
- Tables retain horizontal overflow instead of collapsing away columns.

## Download And Quotation UX

- Preserve both quotation paths: CRM-generated quotation from template/BOQ and external quotation record.
- Quote numbers and revisions remain visible as `QTN-YYYY-NNNN Rn`; first revision is R0; statuses remain Draft, Sent, Superseded.
- Quote viewer must show status, title, customer, date/by, case link, template/file, validity, notes, totals, all revisions, and current revision marker.
- Generated quotes show subtotal, GST, and total; external quotes show total only plus "External quotation" context and original file name.
- `New revision` reopens the correct builder/upload path and supersedes prior Draft/Sent revisions server-side.
- `Generate Doc + PDF`/`Re-generate Doc + PDF` must remain a clear action with disabled "Generating..." feedback. In the migration, replace Google Drive storage links with direct local downloads for generated quotation and invoice artifacts as approved.
- Existing source links `Open Google Doc`, `Open PDF`, `Open uploaded file`, and row-level `PDF` are UX anchors to replace with equivalent download/open actions; do not add export-all or download-all behavior.
- Marking a Draft quote `Sent` must refresh the quote viewer and advance the open case to `Quoted`; creating a Draft must not advance the case.

## Migration Notes

- Preserve the visual hierarchy and labels closely enough that existing sales/back-office users do not have to relearn the workflow.
- Preserve access-driven hiding/disable behavior, but keep all enforcement on the server.
- Do not reintroduce removed follow-ups/actions UI, Customer Industry, or case EstValue.
- The migration design explicitly excludes Google Drive upload/storage; therefore quotation/download parity means same user intent and visible actions, with locally downloaded generated artifacts instead of Drive-hosted files.
