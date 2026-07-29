# AS CRM — Functionalities, Behaviours & Defaults

**Automation Systems NG Pvt Ltd** · Internal sales CRM
Built on Google Workspace (Apps Script web app + one private Google Sheet). No hosting cost, no third-party service holds the data.

> **How to read this.** Part I is what the system does. **Part II is the important one** — it states exactly who can do what, what happens automatically, and what every default is. If you are trying to answer a question like *"who does a new case get assigned to?"*, go straight to Part II.

---

# PART I — What the system does

## 1. Scope

Covers the full pre-order sales cycle: **customer → enquiry → opportunity → quotation → won/lost order**, plus per-person performance reporting.
> **Note:** the follow-ups / actions module has been **removed for now** and may return later. Dashboards show open cases and opportunity tickets; cases no longer carry dated follow-ups.


It deliberately does **not** do: order execution (design, fabrication, dispatch), accounting, or email sending. It stops at the moment an order is won.

All data lives in one Google Sheet only the owning account can open. Staff never touch that sheet — they use a web app that runs *as the owner* but *knows who is signed in*, and enforces every rule on the server. There is no export button, no "select all", and all searches are capped.

## 2. Modules at a glance

| Module | What it holds |
|---|---|
| **Customers** | Company record, geography tag, type, priority, address, GSTIN, contacts, account handlers |
| **Cases** | The pipeline unit — an enquiry/opportunity/order on a customer |
| **Quotations** | Numbered, revisioned offers — built in the CRM or uploaded from outside |
| **Dashboards** | Per-person performance and work lists |
| **Admin** | Users, lists, settings, imports, recycle bin |

## 3. Customers

- **Search-first creation.** There is no standalone "New customer" button. You search the name; if it isn't found, a **+ Create "<name>"** panel appears beside the results. This is the main defence against duplicates, backed by a duplicate-name warning on save.
- **Fields:** Name, Tag (geography), Type, Priority, **Area**, Address, GSTIN, Website, Notes, **SEI**, **Remarks**.
- **Spreadsheet-style grid** — edit Name / Type / Priority / Area / SEI / Remarks inline, saved automatically in the background. Each column has its **own filter in the header** (dropdowns for Tag/Type/Priority with a **(blank)** option; text filters for Name/Area/SEI/Remarks; a Contacts filter for 0 / has-some). Customers with **zero contacts are highlighted** in red. Next to each row are **open** and **+ case** buttons.
- **Who sees which grid:** L1–L4 see **My customers** (the ones they handle). **L5–L6 see All customers** — the full list, fetched only when they click **Fetch** (to avoid loading the whole database on every visit), with a **multi-select handler filter** to find jointly-handled accounts. In the L5/L6 view the column is **Handlers** (they don't own accounts); elsewhere it is **Other handlers**.
- **Contacts:** unlimited per customer (name, designation, phone, email, notes).
- **Handlers:** the people who work the account — added by **username only** (`@automationsystems.org` is appended automatically). A customer created by an **L5/L6** user has no owner yet, so its handler shows as **Direct** until a real user is added.
- **Bulk add:** paste from Excel — `Name · Tag · Type · Priority · City`.
- **Delete:** select rows → moves to a **Recycle Bin** sheet; an L6 admin can restore or purge.

## 4. Cases

Stages are deliberately shallow — **Lead → Opportunity → Quoted** — with an **Outcome** overlay: blank (open), **Won**, **Lost** or **Hold**.

You can create a **Lead**, an **Opportunity**, or book an **Order (Won) directly** for repeat business that never had a pipeline stage.

## 6. Quotations

**Built in the CRM:** pick a Google Doc template, paste **one or more BOQ tables straight from Excel** (each table's **first row becomes its headers**, so any column layout works), give each table a title, enter the **subtotal manually**, and generate a Doc + PDF.

**Uploaded from outside:** attach a PDF/Word/Excel offer prepared elsewhere (up to ~8 MB) so it is on record against the case.

Both kinds get a quote number (`QTN-2026-0001`) and take revisions (R0, R1, R2…). Status is simply **Draft → Sent** (an older revision is auto-marked Superseded). There is no accept/reject step.

## 7. Dashboards

- **L2–L4:** four stat cards — My customers, Open cases, Value Won this month, Value Won last 2 weeks — plus the opportunity tickets assigned to them.
- **L1:** a single list of the tickets assigned to them.
- **L5/L6:** back-office Overview with no personal sales numbers.
- **L3+** can open other people's dashboards read-only.

## 8. Mobile

The web app is responsive — the same URL works in any phone browser ("Add to Home Screen" gives an app icon). A floating **Quick log** button captures a site enquiry in one step: find or create the customer, title the case, and set the stage.

## 9. Admin (L6 only)

Users and levels · editable lists (tags, types, priorities, won-order categories, sources) · defaults (GST %, currency, company name) · sheet-based bulk imports · recycle bin · database and Drive links.

---

# PART II — Behaviours, rules and defaults

## 10. Who can access which customer

Two concepts govern everything:

> **Tags decide what you can SEE. Being an account handler decides what you can OPEN.**

Every customer has a geography **tag** (Punjab / Chandigarh / NCR / Geo / Other) and a list of **account handlers**.

**The full access matrix.** Each cell is what that user gets for that customer:

| User level | They are a **handler** (or hold a case/ticket on it) | Customer's tag **matches** their tags | Tag does **not** match |
|---|---|---|---|
| **L1** | Full | *No access* | *No access* |
| **L2 (Sales)** | **Full** | **Search only** — name, tag, type, handler names. Cannot open | **Invisible** — not in search at all |
| **L3 (Supervisor)** | Full | **Full** | Search only |
| **L4 / L5 / L6** | Full | Full | Full |

**What "search only" means in practice.** An L2 salesperson with the *Punjab* tag can browse the Punjab customer base and see who owns each account, but clicking it gives: *"You are not an account handler for this customer… ask one of the handlers (or an L3+ user) to add you."* They cannot see contacts, cases or quotations.

**Ticket assignment does NOT grant customer access.** If a case is assigned to you, you can open and work **that case** and reassign it when done — but you get **no access to the customer** (its other cases, contacts or details) unless you are also an account handler. A ticket is deliberately narrow: it lets you do the one job, nothing more. When the job is done you reassign the ticket back (there is a **Reassign** button on both the case and your dashboard).

**How access is granted:** open the customer → **Account handlers → + Add handler** → type their username. Any existing handler, or any L3+ user, can do this. The customer appears in that person's grid immediately.

## 11. Case ownership vs. assignment — the two are different

| | **Owners** | **Assigned to** |
|---|---|---|
| How many | **All account handlers** (mandatory) **plus** any extra owners added for this case | **Exactly one person** |
| Set how | Handlers come automatically; extra owners added via **Owners → manage** on the case | Directly, on the case |
| Meaning | Who the account/deal belongs to; drives credit and stats | Who is currently working this case (the "opportunity ticket") |
| Changed by | Changing the customer's handlers (for handler-owners) or add/remove extras (L2+) | Anyone who can see the case, while it is open |

**Handlers are owners of every case on their account and cannot be removed as owners** — to drop a handler-owner you remove them as a handler on the customer. **Extra owners** can be added to a specific case (e.g. a specialist helping close it) and removed again, but **only a current owner of the case may add or remove owners**. An owner sees the case and shares credit, but **only account handlers get access to the customer** — being an extra owner does not open the customer record.

### 11.1 When a case is created for a customer with multiple handlers, who is it assigned to?

- **Owners:** *all* the handlers of that customer, automatically. If a customer has three handlers, all three own the case and all three see it in their "mine" filters and stats.
- **Assigned to:** **the person creating the case, by default.** The New Case form has an **Assign to** dropdown pre-selected to you — you can change it to anyone before saving.
- Cases created automatically (by generating or uploading a quotation, or by Quick log) are **assigned to the person who did that action**.
- **Reassigning a ticket** uses a search box plus one-tap **suggestion bubbles for the case's current owners** — not a long dropdown.
- The **Value** column on the cases list shows the won order value, or the latest **quoted** value for an open case.
- A case created directly as a **Won order** gets **no assignee at all** — it is already closed, so there is no open ticket.

### 11.2 How many people can a case be assigned to at once?

**One.** The case assignee is a single person — it is a ticket, and a ticket has one holder. If you want several people working an account, add them all as **handlers** (that makes them all owners).


### 11.3 Who can a case be assigned to?

**Any active CRM user** — the dropdown lists every active user in the system. There is deliberately **no restriction** on:

- their **level** (an L1 ticket-worker or an L6 admin can hold a ticket equally),
- their **tags** (the customer's geography is irrelevant),
- whether they **handle that customer**.

The only requirement is that the user exists and is marked **Active** in Admin → Users. Assigning the ticket is itself what grants that person access to the customer (see §10).

### 11.4 Who can reassign, and until when?

**Anyone who can see the case can reassign it to anyone** — no special level needed.

Reassignment stops the moment **any outcome is set** — Won, Lost **or Hold**. The reassign control disappears and the server refuses: *"This opportunity is closed — the ticket can no longer be reassigned."*

> **Worth knowing:** putting a case on **Hold keeps its assignee but freezes it** — you cannot hand it to someone else while it is held. To transfer a held case, change its **stage** first (which resumes it and clears the Hold), then reassign.

## 12. Who can do what to a case

Once you can see a case, you can work it. There is intentionally **no extra level gate** on progressing a case — an L1 holding the ticket can move it and close it.

| Action | Who |
|---|---|
| See the case | An owner (handler), the assignee, anyone with full access to the customer, or L4+ |
| Change stage | Anyone who can see it |
| Mark Won / Lost / Hold | Anyone who can see it |
| Reassign the ticket | Anyone who can see it, while no outcome is set |
| Edit title/details | Anyone who can see it |
| **Create** a case | **L2+**, and only on a customer they have full access to |

## 13. What happens automatically

| Trigger | Automatic effect |
|---|---|
| You **create a customer** | You are added as its first **account handler** |
| You **create a case** | Assigned to you by default; all the customer's handlers become its owners |
| You **prepare a quotation** (Draft) | The case is **not** advanced. If no case was picked, one is auto-created at the **Opportunity** stage |
| You mark a quotation **Sent** | Its case moves up to **Quoted** — the *only* action that auto-advances a case to Quoted (never backwards, never on a closed case) |
| You mark a case **Won** | Stage forced to **Quoted**, close date stamped, **assignee cleared** |
| You mark a case **Lost** | Close date stamped, **assignee cleared** |
| You mark a case **Hold** | Stage kept, assignee kept, no close date — but the ticket can no longer be reassigned until it resumes |
| You **change the stage** of a held case | The Hold is cleared — the case resumes |
| You save a **new quotation revision** | Previous Draft/Sent revisions become **Superseded** |
| You **delete a customer** | Moved to the Recycle Bin with who/when; its contacts and handlers are removed |
| Any record is created or changed | Written to the **ActivityLog** (who, when, what, which customer) |

## 14. Defaults

| Thing | Default |
|---|---|
| New case stage | **Lead** (first stage in the list) |
| New case assignee | **The creator** (changeable at creation) |
| New case owners | **All handlers** of the customer |
| New customer status | **Active** |
| New customer handler | **The creator** |
| Generated quotation status | **Draft** |
| Uploaded quotation status | **Sent** |
| First revision number | **R0** |
| GST | **18%** |
| Currency | **INR** |
| Won-order categories | None — **at least one must be chosen** |
| Customer tag / type / priority | Blank (all optional) |

## 15. Rules the system enforces

These are checked on the server; the interface cannot bypass them.

**Cannot be done at all**
- Mark a case **Won** without an **order value greater than zero** *and* **at least one product category**.
- Change the **stage** of a Won or Lost case — it must be reopened first.
- **Reassign** the ticket once any outcome is set — Won, Lost or Hold (change the stage first to resume a held case).
- **Delete a customer that has cases or quotations** — it is skipped, so linked work is never orphaned.
- Assign a ticket to a user who is **inactive** or not in the system.
- Generate a Doc/PDF for an **uploaded** quotation (there is no template behind it).
- Open a customer outside your access (§10), or reach the database sheet as anything below L6.

**Capped**
| Limit | Value |
|---|---|
| Customer search results | 80 |
| Case list | 300 |
| Customer grid | 400 |
| Bulk customer import | 500 per run |
| Quotation file upload | ~8 MB |
| Dashboard lists | 60 each |

**Editing rights by level**
| Field | Level needed |
|---|---|
| Customer Priority | **L2+** |
| Customer Tag and Type, archive | **L3+** |
| Delete customers | **L3+** |
| View another person's dashboard | **L3+** (L3: only L2 sharing a tag; L4+: anyone) |
| Admin area | **L6** |

## 16. Deliberate design choices

Things that surprise people, and why they are that way.

- **Won credit is shared in full, not split.** A ₹5,00,000 win on a two-handler account shows ₹5,00,000 on *both* dashboards, with both names on the entry. *Consequence:* totalling "Won this month" across people will exceed the company's booked value wherever accounts are co-handled. These are per-person views, not a revenue roll-up.
- **The BOQ subtotal is typed in manually**, never computed from the pasted cells — real BOQs carry discounts, lump sums and non-numeric rows.
- **BOQ tables have no fixed columns.** Each pasted table's first row becomes its headers.
- **Customer creation is search-first.** The extra step is the point.
- **A tag alone never grants access** to a customer's details for a salesperson — only handler status does.
- **Access level is shown only in the top-right corner and in Admin**, nowhere else in the interface.

## 17. Speed behaviour

Apps Script adds roughly 0.3–1 second of fixed overhead to every server call, so the app is built never to wait on it:

- The whole workspace (dashboard, customer grid, case list) loads in **one call** at sign-in, so the first tab switch costs nothing.
- Views render **instantly from memory** and refresh quietly in the background, repainting only if something actually changed.
- Grid edits appear **immediately** and save in the background, several batched into one request. Only a failure interrupts you — the cell reverts and says so.

*Consequence to be aware of:* a colleague's change can be up to ~90 seconds stale on your screen. Any change **you** make refreshes your view immediately.

---

## 18. Technical shape (one page)

- **Frontend:** one HTML file — the whole app. No framework, no build step.
- **Backend:** one Apps Script file, ~40 server functions.
- **Database:** one Google Sheet, 14 tabs — Users, Customers, Contacts, Handlers, Cases, Actions, Quotations, QuoteBOQ, RecycleBin, Settings, Counters, ActivityLog, Import, ImportContacts.
- **Identity:** Google Workspace sign-in; the web app runs **as the owner** with access **"Anyone within the domain"** — that pairing is what keeps the sheet private while still identifying each user.
- **IDs:** `CUST-0001`, `CT-0001`, `CASE-2026-0001`, `ACT-00001`, `QTN-2026-0001`, allocated under a lock so simultaneous users cannot collide.
- **Editor utilities:** `setupCRM()` builds the database · `resetCRM()` clears stored IDs for a fresh build · `makeMeAdmin()` promotes the running account to L6 · `backupDatabase()` snapshots the sheet (schedule weekly).
- **Capacity:** comfortable for ~20 users, thousands of customers, tens of thousands of rows. Requests finish well under a second, except PDF generation (~3–6 s).

## 19. Natural next module

The **order execution workflow** that begins where this stops: coordination review → drawing approvals → BOM → panel work order → fabrication/wiring → testing → inspection → dispatch, with partial-delivery tracking. Same architecture, no new infrastructure. For management reporting, Looker Studio can read the database sheet directly without touching the CRM.
