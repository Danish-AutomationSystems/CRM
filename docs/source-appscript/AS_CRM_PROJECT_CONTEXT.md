# AS CRM — Project Context (handoff / import into a new session)

**Purpose of this file.** Paste this into a fresh chat (with `Code.gs` and `Index.html` attached) and the assistant will have everything it needs to continue the work without re-deriving the architecture or re-litigating settled decisions.

---

## 0. Quick brief

Build/maintain **AS CRM**, an internal sales CRM for **Automation Systems NG Pvt Ltd** (Ludhiana, Punjab — Schneider Electric certified system integrator & TTA panel manufacturer). ~20 sales users. Owner/product lead: **Himanshu**, Business Development Manager.

Stack, chosen for zero hosting cost and full data control:
- **Google Apps Script web app** — `Code.gs` (server) + `Index.html` (entire single-page frontend)
- **One private Google Sheet** as the database (14 tabs)
- **Google Drive** folders for quotation templates and generated/uploaded quote files

Deployment: `Execute as: Me` (owner) + `Who has access: Anyone within the domain`. That pairing is load-bearing — it keeps the sheet private while still letting the server identify the signed-in user. Email domain is **`automationsystems.org`**; the owning account is moving from `crm@` to **`admin@`**.

Deliverables: `Code.gs`, `Index.html`, `SETUP_GUIDE.md` (install/admin), plus `AS_CRM_FUNCTIONALITIES.md` (the behaviour-and-defaults reference — read that for "who can do what / what happens when").

---

## 1. Architecture in 10 lines

- Frontend is one HTML file: an SPA with routes `dash | customers | customer | cases | case | admin`, a modal system, and a floating mobile "Quick log" button. No framework, no build step.
- All server functions are prefixed **`api_`** and called via `google.script.run` (wrapped in a promise helper `gs(fn, ...args)` with a 30 s timeout).
- `api_bootstrap` returns user + settings + nav + peers + self-dashboard + recent activity in **one call** (speed).
- Every server call re-derives identity (`me_()`) and permissions (`context_(u)` → `{hMap, ownSet, idx}`). **Nothing is trusted from the client.**
- Row reads are memoised per execution (`_ROWS`), invalidated on every `append_` / `setCells_` / `deleteRowsWhere_`. `setCells_` batches a multi-field update into **one** `setValues()` (contiguous) or one read + one write (scattered) — it used to issue one `setValue()` per field.
- **Perceived speed is a client-architecture problem, not a server one.** Apps Script has ~0.3–1 s fixed latency per `google.script.run` call; you cannot optimise that away. The app therefore never blocks on it: `api_workspace` warms dashboard+grid+cases in one call at boot; `CACHE` serves every view instantly and revalidates in the background (`fresh()` / `sameData()` guards prevent pointless repaints); grid edits are optimistic and batched through `api_saveCustomerCells` (700 ms debounce, rollback on failure). `gridBusy()` stops a background refresh repainting under a user's cursor.
- Caches: settings (10 min, key `settings_v3`), compact customer search index (2 min, `custIndex_v3`, cleared via `clearCustIndex_()` on any customer change). Client caches the bootstrap payload for 45 s and busts it on any non-read call.
- IDs are allocated under `LockService`: `CUST-0001`, `CT-0001` (contacts), `CASE-2026-0001`, `ACT-00001`, `QTN-2026-0001`.
- Editor-run utilities (not exposed to the web app): `setupCRM()`, `resetCRM()`, `makeMeAdmin()`, `backupDatabase()`.
- Sheets are auto-created from the `HEADERS` map, so **adding a key to `HEADERS` creates the tab** on the next `setupCRM()`.
- No email sending, no order execution, no accounting. The system stops at "order won".

---

## 2. Schema (authoritative — from `HEADERS`)

```
Users:          Email, Name, Role, AllowedTags, Active, AddedOn, AddedBy
Customers:      CustomerID, Name, Tags, Type, Priority, Area, Address, GSTIN, Website,
                Notes, SEI, Remarks, Status, CreatedBy, CreatedOn, UpdatedOn
Contacts:       ContactID, CustomerID, Name, Designation, Phone, Email, Notes, CreatedBy, CreatedOn
Handlers:       CustomerID, UserEmail, AssignedBy, AssignedOn
Cases:          CaseID, CustomerID, Title, Details, Source, Stage, Outcome, OrderValue,
                WonCategories, OutcomeNote, Owner, ExtraOwners, Assignee, ClosedOn,
                CreatedBy, CreatedOn, UpdatedOn
Actions:        ActionID, CaseID, CustomerID, Title, DueDate, Assignees, Status, Note,
                CreatedBy, CreatedOn, DoneOn, DoneBy
Quotations:     QuoteNo, Rev, CaseID, CustomerID, Title, Source, FileName, TemplateId, TemplateName,
                Status, Subtotal, TaxPct, TaxAmount, Total, Currency, ValidUntil, Notes,
                DocLink, PdfLink, CreatedBy, CreatedOn
QuoteBOQ:       QuoteNo, Rev, Block, Title, Headers, Rows     (Headers/Rows are JSON strings)
RecycleBin:     <all Customers columns incl. Area/SEI/Remarks> + DeletedBy, DeletedOn
Settings:       Key, Value
Counters:       Key, Last
ActivityLog:    When, Who, Action, Entity, CustomerID, Details
Import:         Name, Tag, Type, Priority, Area, Address, GSTIN,
                ContactName, ContactDesignation, ContactPhone, ContactEmail, Handlers
ImportContacts: CustomerName, ContactName, Designation, Phone, Email, Notes
```

Defaults seeded into `Settings`: stages `Lead|Opportunity|Quoted`; outcomes `Won|Lost|Hold`; tags `Punjab|Chandigarh|NCR|Geo|Other`; types `OEM|End User|EPC|Other`; priorities `High|Medium|Low`; 16 won-order categories; roles `L1..L6`; GST 18%; currency INR.

Storage quirks: **won categories and action assignees are pipe-joined** (`|`), *not* comma — because one category is literally `"Lighting, Switches, Wires"`. `parseList_` splits on both `|` and `,`; `parsePipe_`/`joinPipe_` split on `|` only. Phone and GSTIN columns are formatted as plain text so leading zeros survive.

---

## 3. The two rules that govern the whole system

**These are the most important things to understand. Most bugs are violations of one of them.**

### 3.1 Tags = visibility. Handlers = access.
`accessLevel_(u, cust, ctx)` returns `FULL | NAME | NONE`:

| Level | Handler / holds a case-ticket | Tag matches | No tag match |
|---|---|---|---|
| L4–L6 | FULL | FULL | FULL |
| L3 | FULL | **FULL** | NAME |
| L2 | FULL | **NAME** | **NONE** |
| L1 | FULL | NONE | NONE |

`NONE` customers are filtered out of search entirely and `api_getCustomer` throws. `ensureFull_()` is the gate on every write path (contacts, cases, quotations).
A user also gets FULL on any customer where they **own or are assigned a case** (`ctx.ownSet`) — this is required, otherwise a ticket assigned across tags would be unworkable. It is not an escalation path, because creating a case already requires FULL.

### 3.2 Case owners = the customer's handlers. "Assigned to" = one ticket-holder.
- `caseOwners_(o, ctx)` derives owners from `ctx.hMap[CustomerID]`, falling back to the stored `Owner` column (the creator) only if the customer has no handlers. **The `Owner` column is a fallback record, not the source of truth.** There is no owner-reassign UI — you change ownership by changing handlers.
- `Assignee` is the opportunity ticket. Any active CRM user can hold it (`resolveUser_`, no tag/handler/level requirement); **anyone who can see the case can reassign it** while the case is open (`api_assignTicket`).
- **Won credit is shared in full, not split** — a won order counts its whole value for every handler. Confirmed by Himanshu: *"its fine dont split"*.
- **Owners = handlers (mandatory) + `ExtraOwners` (removable).** Only a **current owner** (or L4+) may add/remove owners.
- **Quote status is Draft→Sent→Superseded only** (no Accept/Reject). Preparing a quote does NOT bump the case; only marking **Sent** advances to Quoted (upload bumps only if status Sent). Draft auto-created case starts at **Opportunity**.
- **`quotedValue`** per case (`quotedValueMap_`, latest non-superseded quote total) shows in the case list/detail Value cell.
- **Reassign UI** = search typeahead + owner suggestion bubbles (`mAssign`/`wkSearch`/`wkPick`), not a dropdown.
- **The opportunity-ticket assignee gets the CASE only, NOT the customer.** `ctx.ownSet` was removed from `accessLevel_` — customer access is now handler-or-tag only. `caseVisible_` still lets the assignee (and extra owners) see the case. `api_getCase` returns only `{id,name,tags}` of the customer, so nothing leaks.
- **`Direct` handler placeholder:** a customer created by L5/L6 gets a handler row with `UserEmail='Direct'` (displayed via `nameOf_`), cleared automatically by `api_addHandler` when a real handler is added. `caseHandlerOwners_` filters out `direct`.
- **Grids:** `api_myCustomers` (handler-based, L1–L4) vs `api_allCustomers` (L4+, no cap, explicit fetch). Both via `custRow_` including `area/sei/remarks/contacts/handlers`.
- Marking a case **Won or Lost clears `Assignee`**. Hold does not.

---

## 4. Settled decisions (do not re-open without being asked)

| Decision | Detail |
|---|---|
| Follow-ups REMOVED | The follow-ups/actions module was **removed for now** (may return). All `api_addAction`/`completeAction`/`reopenAction`, the dashboard follow-up list, the case follow-up card, and the quick-log follow-up field are gone. **The `Actions` sheet + `HEADERS.Actions` are intentionally KEPT** so re-adding is a code-only change (no schema reset). `api_getCase` no longer returns `actions`; `computeDash_` no longer returns `followups`. |
| Won credit | **Shared in full** to each co-handler. Not split. |
| BOQ subtotal | **Entered manually.** Never computed from pasted cells. |
| BOQ columns | **No preset columns.** Each pasted Excel table's **first row is its headers**. Multiple titled tables per quote. |
| Customer creation | **Search-first.** No standalone "New customer" button — you search, then create from the result panel. Duplicate-name guard on save. |
| Case creation | Does **not** ask for a "source". |
| Priority editing | **L2+**. Tag and Type editing are **L3+**. |
| Levels in UI | Shown **only** top-right and in Admin. Nowhere else. |
| Handler/assignee input | **Username only** — `@automationsystems.org` is appended server-side (`expandEmail_`). |
| Customer deletion | Soft delete → RecycleBin sheet. **Blocked** if the customer has cases or quotations. L6 restores/purges. |
| Removed fields | Customer `Industry` and case `EstValue` were **deliberately removed**. Don't reintroduce. |
| Naming | "ASNG CRM" was renamed to **"AS CRM"** everywhere. |
| Dashboards | L5/L6 are back-office: **no personal sales dashboard**. L4 keeps one. |

---

## 5. Working patterns that have proven necessary

**Verification before delivery — every time.** This project has no runtime here; Apps Script cannot be executed. So:
1. `node --check` on `Code.gs` (copy to `.js` first).
2. Extract the `<script id="appjs">` block from `Index.html` and `node --check` it.
3. Verify scriptlet hygiene: **exactly one** `<?!= boot ?>`, no stray `<?`, exactly 2 balanced `<script>` tags.
4. **API parity check:** every `gs('api_x')` in `Index.html` must exist as `function api_x` in `Code.gs`. A one-liner with `comm -23` catches renames instantly.
5. For non-trivial logic (access matrix, filters, attribution), **write a small Node trace** that replicates the function and asserts expected outputs. This has caught real bugs.

**Editing method.** Use Python scripts with an assertive `rep(old, new, n=1)` helper that *fails loudly* if the anchor text isn't found exactly n times. Blind `sed` on this codebase is how you get silent corruption.

**Bugs previously caught this way (don't reintroduce):**
- A `\u0000` sentinel used as an HTML `<option>` value — HTML parsing rewrites NUL to U+FFFD, so the filter silently matched nothing. Use an ASCII sentinel (`__BLANK__`).
- `notesMasterIdLst`-style ordering issues don't apply here, but the same class of "looks fine, silently broken" issue does. Trace, don't assume.

**Deployment rule of thumb.** Code-only changes → **Manage deployments → Edit → New version** (URL stays the same). **Any schema change** (a new tab or column) → `resetCRM()` then `setupCRM()` for a fresh database. Himanshu has been re-running fresh setup during build-out, so schema changes have been cheap; once live, they won't be.

---

## 6. Known gotchas

- **`Hold` is stored as an Outcome**, so any code testing `String(o.Outcome||'').trim()` treats a held case as closed. Consequence: a held case **cannot have its ticket reassigned** (`api_assignTicket` refuses, `canAssignTicket` is false) even though it keeps its assignee. Workaround is to change the stage first, which clears the Hold. Flagged to Himanshu; change it only if he asks.
- `setupCRM()` guards on a **stored Script Property**, not on the Drive folder. Deleting the folder does **not** reset it — you get "Setup already done". `resetCRM()` clears the four `CRM_*` properties. This bit us once.
- **Triggers do not transfer** with Drive ownership. Moving the CRM to a new owner account means recreating the weekly `backupDatabase` trigger.
- A deployed web app serves the **version it was deployed from**, not the current editor code. A stale deployment referencing a since-deleted library threw a confusing "you do not have access to library …" error for new users. Fix = deploy a new version.
- `google.script.run` cannot take a `File`. Uploads must be read to **base64 in the browser** (`FileReader.readAsDataURL`, strip the prefix) and decoded server-side with `Utilities.base64Decode` + `Utilities.newBlob`. Cap ~8 MB.
- Apps Script has no `localStorage` restriction concerns here, but **do not** use browser storage in the frontend anyway — state lives in `S` and on the server.

---

## 7. Current status

All requested functionality is **implemented and syntax-clean**. Not yet exercised against a live deployment — the outstanding validation items are: (a) generate one quotation PDF and confirm the multi-table `{{BOQ_TABLE}}` rendering looks right in the real template; (b) confirm delete → Recycle Bin → restore round-trips; (c) confirm a co-handled customer shows both names as Owners, and that marking Won clears "Assigned to" and credits both dashboards.

**Next natural module (discussed, not built):** the **order execution workflow** that starts where this stops — coordination review → drawing approvals → BOM → panel work order → fabrication/wiring → testing → inspection → dispatch, with partial-delivery tracking. Same architecture, no new infrastructure.

---

## 8. Working style (useful for whoever picks this up)

Himanshu is direct and output-focused. He issues corrections tersely, often edits files himself and re-uploads, and expects working code rather than narration. Give him the changed files, a short summary of what changed and why, flag genuine trade-offs and assumptions, and ask at most one question — the one that actually matters.
