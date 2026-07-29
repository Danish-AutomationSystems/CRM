# AS CRM — Setup & Deployment Guide (v2)

A custom CRM for ~20 sales users, built entirely on Google Workspace. There is nothing to host and nothing to pay for beyond the Workspace licences you already have.

**How it works:** all data lives in one private Google Sheet owned by the admin. Your team never opens that sheet — they use a web app (built with Google Apps Script) that talks to the sheet on their behalf. Because the web app runs *as the admin* but *knows who is signed in*, it enforces the access rules: who can search, who sees full customer details, who sees whose dashboard, and who can change what. There is no export or "download all" anywhere in the interface.

**The two files:**

| File | What it is |
|---|---|
| `Code.gs` | Server: database setup, permissions, all read/write APIs, quotation PDF generation |
| `Index.html` | The entire user interface (dashboard, customers, cases, quote builder, mobile quick-log, admin) |

---

## What changed in v2 (read this if you ran v1)

- **Roles are now six levels, L1–L6** (was Sales / Manager / Admin). See the table in §3. Old roles still work if present (Admin→L6, Manager→L4, Sales→L2), but new users are created as L1–L6.
- **"Opportunities" is now "Cases."** A case moves through **Lead → Opportunity → Quoted**, and at any point can be marked **Won**, **Lost**, or **Hold**. You can also create a Lead, an Opportunity, or book an **Order (Won)** directly.
- **Customers gained two fields:** **Type** (OEM / End User / EPC / Other) and **Priority** (High / Medium / Low).
- **Customer tags are now a fixed geography list:** Punjab / Chandigarh / NCR / Geo / Other. Tags still drive who can see a customer.
- **Follow-ups / actions are removed for now** (may return in a later version). Dashboards show open cases and opportunity tickets instead.
- **Owner and Assignee are now separate.** A case has an account **Owner** and a separate **Assignee** ("currently working on") — the opportunity ticket. **L1** users now see only the tickets assigned to them.
- **Bulk add** customers *and* contacts from inside the app (paste from Excel), plus a sheet-based importer for each.
- **Mobile quick-log:** a floating button logs a case in one step from a phone.
- **Inline customer grid:** the Customers tab has a spreadsheet-style grid of the customers you handle, with auto-saving inline edits.
- **Freer opportunity tickets:** the "working on" assignee can be any CRM user, and anyone who can see the case can reassign the ticket until it closes.
- **Quotation BOQ:** paste any Excel table(s) with their own header rows and titles; the subtotal is entered manually.
- **Usernames:** handler/assignee inputs take just a username (`@automationsystems.org` is appended).
- **The database schema changed.** The cleanest path is a **fresh database** (see §2, note at the end). If you must keep v1 data, see §11.

---

## 1. Prerequisites

- A Google Workspace account for the **admin** (owns the database sheet, the Drive folders, and the script). Use a stable, ideally generic account like `crm@yourdomain.com`.
- Every user needs a Workspace account on the **same domain**.

## 2. Install (one time, ~15 minutes)

1. Sign in as the admin and open **[script.new](https://script.new)** — this creates a blank Apps Script project. Name it `AS CRM` (click "Untitled project" at the top).
2. Replace the contents of the default `Code.gs` with the provided `Code.gs`.
3. Click **+ → HTML** in the Files panel, name the file exactly `Index` (Apps Script adds `.html`), and paste the provided `Index.html`.
4. **Save** (Ctrl/Cmd+S).
5. Set the function dropdown to **`setupCRM`** and click **Run**.
6. Google shows a *"Google hasn't verified this app"* warning for your own unpublished script — click **Advanced → Go to AS CRM (unsafe)** and allow. (Normal for in-house scripts; you're authorizing your own code on your own account.)
7. When the run finishes, the **Execution log** prints the database URL. Drive now has a folder **AS CRM** with the database sheet, a **Templates** folder (starter quotation template), and a **Quotations** folder (generated files land here).
8. **Deploy → New deployment** → gear icon → **Web app**, then set:
   - **Execute as:** `Me` ← keeps the sheet private
   - **Who has access:** `Anyone within <your domain>` ← lets the app know who's signed in
9. **Deploy** and copy the web app URL (`https://script.google.com/a/macros/yourdomain.com/s/…/exec`).
10. Open the URL yourself — you land on the dashboard (setup registered you as the first user at **L6 / all tags**).

> **Upgrading from v1:** because the schema changed, the simplest and safest approach is to run `setupCRM` in a **new** Apps Script project to get a clean database, then re-import customers (§5) and re-add users (§3). If you redeploy v2 over a v1 project, the URL stays the same but the old `Customers`/`Opportunities` tabs will not line up with the new columns — a fresh database avoids subtle mismatches.

## 3. Add your team and pick levels

Open the web app → **Admin → Users → + Add user** for each person. Choose an **access level**:

| Level | What they can do |
|---|---|
| **L1** | **Tickets only.** Lands on a single list of **opportunity tickets assigned to them** (cases they are currently working on). They open a ticket to work it and update its stage/outcome. No customer browsing. |
| **L2** | **Sales.** Own performance dashboard (My customers, Open opportunities, Value Won this month, Value Won last 2 weeks) Can search customers **in their tags** and open only the ones they **handle** (see "Tags vs. handlers" below). Creates customers/cases/quotations assigns cases, and marks Won/Lost/Hold. |
| **L3** | **L2 + supervisor.** **Opens any customer inside their tags** (not just ones they handle), can view (read-only) the dashboard of any **L2** user who shares one of their tags, can edit a customer's **tag and type**, and can archive/delete customers. |
| **L4** | **L3 + all data.** Full access to every customer and case across all tags, regardless of tag matching. Keeps a personal sales dashboard. |
| **L5** | **Back-office.** Everything L4 can access, but **no personal sales performance dashboard** — lands on an Overview that can open any user's dashboard read-only. No Admin. |
| **L6** | **L5 + Admin.** Manage users, lists (tags/types/priorities/categories/sources), defaults, import, and Drive links. Also has no performance dashboard. |

**Tags vs. handlers — how customer access actually works.** These are two different things:

- **Tags control what a user can *see*.** A customer carrying one of your tags shows up in your search results.
- **Being an *account handler* controls what you can *open*.** Handlers see the contacts, cases and quotations, and can edit the record.

For an **L2 (Sales)** user that means:

| Customer | L2 sees it in search? | L2 can open it? |
|---|---|---|
| Carries one of their tags, they are **not** a handler | **Yes** — name, tag, type and who handles it | **No** — they're told to ask a handler to add them |
| Carries one of their tags, they **are** a handler | Yes | **Yes** — full record |
| **Outside** their tags | **No** — invisible | No |

So a new salesperson with the *Punjab* tag can browse the Punjab customer base and see who owns each account, but only works the accounts they have actually been given. An **L2 also gets full access to any customer whose case or opportunity ticket is assigned to them**, so handing someone a ticket automatically gives them what they need to work it.

**L3 and above are different:** L3 can open any customer inside their tags, and **L4–L6 see and open everything** regardless of tags. Pick **All tags (\*)** to make every customer *visible* to a user without raising their level (for an L2 that still means view-in-search only, unless they handle the customer).

**Adding a handler.** Open the customer → **Account handlers → + Add handler** and type their username. Any existing handler (or an L3+ user) can do this. The customer then appears in that person's **My customers** grid immediately, with full access.

Then share the web app URL (email, or pin it in your team chat). Users bookmark it — no install, no login screen (Workspace sign-in is reused). Anyone on the domain who hasn't been added sees a "not registered" screen showing their email, so you know who to add.

## 4. Customers and cases (day-to-day)

**Customers** carry a **Tag** (geography — controls visibility), a **Type** (OEM / End User / EPC / Other) and a **Priority** (High / Medium / Low), an **Area**, and optional **SEI** and **Remarks** fields. To add one you **search first**: type the name in the Customers search bar, and if it isn't already there, use the **+ Create "<name>"** button that appears beside the results. That one habit keeps duplicates out of the database. Use **Bulk add** to paste many at once (see §5). Any L2+ user can set or change a customer's **Priority**; editing the **Tag and Type** (and archiving) needs L3+.

**Cases** live on a customer. Create one with **+ Case** and pick what you're making:
- **Lead** or **Opportunity** — an open case you're working; choose who it is **assigned to** (defaults to you, reassignable any time).
- **Order (Won)** — books a won order directly: enter the order value and pick one or more **product categories**.

(Creating a case no longer asks for a "source".)

A case shows **Lead → Opportunity → Quoted** as its stage, with **Won / Lost / Hold** as an outcome you can set at any point. Marking **Won** requires the **order value** and at least one **category** (VFDs, PLC, HMI, Panels, AVEVA, iMCC, Soft Starters, Motion Control & Robotics, Switchgear, Metering, EMS, BMS, "Lighting, Switches, Wires", Pneumatics, Service, Others). **Hold** keeps the stage; reopening or moving the stage clears it. Creating a quotation auto-creates a case at the **Quoted** stage if you don't pick an existing one, and marking a quote **Sent** moves its case to **Quoted**.

**Owners vs. Assigned to.** A case has **Owners** and an **Assigned to**, and they are different things:

- **Owners = the account handlers of that customer.** Ownership follows the account, so every handler is a co-owner of every case on it. Credit is **shared**: a won order counts towards each handler's "Won this month", and the case list shows all their names together, so you can always see who a deal is shared with. You don't set owners on the case — you set them by adding or removing **account handlers** on the customer.
- **Assigned to = the opportunity ticket**, the one person currently working the case. It can be **any** CRM user (not necessarily a handler, regardless of tag), and **anyone who can see the case can reassign it** while the case is open. This is what an **L1** user lives in — tickets assigned to them, nothing else.

When a case is closed as **Won** or **Lost**, the **Assigned to** is cleared automatically — a finished case is nobody's open ticket. (Putting a case on **Hold** keeps the assignee, since it isn't closed.)

When adding an account handler or assigning a ticket you type just the **username** — the app appends `@automationsystems.org` for you.

**Customers tab — inline grid.** The Customers tab is a single search bar over a spreadsheet-style grid of **the customers you handle** (L4+ see all). If a colleague creates a customer and adds you as a handler, it appears in your grid straight away. Type in the bar and the **search results replace the grid** (search spans everything visible to you, handled or not); clear it and the grid returns. In the grid you can **filter** by tag, type, priority, **other handler**, or a name/city text box — each dropdown also offers **(blank)** to find records where that field is empty (e.g. customers with no priority set, or ones only you handle). An **Other handlers** column shows who else works the account. You can edit cells inline (name, type, priority, city, state — Priority at L2+, Type at L3+, auto-saved), and **tick rows to delete** them. Deleting moves customers to a **recycle bin** (a separate sheet); any customer that still has cases or quotations is skipped so linked work is never orphaned. An L6 admin can **restore** or permanently remove items under **Admin → Recycle bin**.

**Viewing other people's dashboards.** L3 users can open the read-only dashboard of any L2 user who shares one of their tags; **L4–L6 can open any user's dashboard** (including L1 ticket-holders) from the **"Whose dashboard"** picker on the dashboard. If you're the only user so far, the picker is empty by design.

## 5. Import / bulk-add your existing data

**Fastest, in-app (any L2+):**
- **Customers page → Bulk add** — paste rows: `Name · Tag · Type · Priority · City` (tab- or comma-separated; only Name required). You become the handler for each.
- **Customer page → Contacts → Bulk add contacts** — paste rows: `Name · Designation · Phone · Email`.

**Sheet-based (L6 admin), for large or handler-assigned imports:** Admin → open the **Database sheet** link, then:
- **Import** tab (customers): `Name · Tag · Type · Priority · City · State · Address · GSTIN · ContactName · ContactDesignation · ContactPhone · ContactEmail · Handlers`. `Handlers` takes comma-separated emails (must be active users). Back in the app: **Admin → Run customer import**. Rows whose Name already exists are skipped and reported; processed rows are cleared.
- **ImportContacts** tab (contacts across many customers): `CustomerName · ContactName · Designation · Phone · Email · Notes`. `CustomerName` must match an existing customer exactly. **Admin → Run contact import**; unmatched rows are reported and skipped; processed rows are cleared.

## 6. Mobile access

The CRM is a responsive web app — the same URL works in any mobile browser, so there's no separate app to install. On a phone, open the web app URL and tap the browser's **Add to Home Screen** to get an app-style icon. Everything (dashboard, customers, cases, quotes, quick-log) adapts to the small screen.

### Log a case in one step

On a phone, tap the floating **＋ Quick log** button (shown for L2+). Search and pick an existing customer *or* add a new one inline (name + tag + type + priority), give the case a title and stage, and save. It creates the customer (if new) and the case in a single round-trip — built for capturing a site enquiry on the spot.

## 7. Quotation templates

Templates are ordinary **Google Docs** inside *AS CRM → Templates*. The quote builder lists every Doc there, so to add one (e.g. "Panel offer", "Trade supply offer", "Service offer") just create or copy a Doc — your letterhead, terms, signatures, all as normal Doc content.

Where the CRM should insert data, type these placeholders:

| Placeholder | Becomes |
|---|---|
| `{{QUOTE_NO}}` / `{{REV}}` / `{{DATE}}` | QTN-2026-0012 / R1 / today |
| `{{CUSTOMER_NAME}}` / `{{CUSTOMER_ADDRESS}}` / `{{CONTACT_NAME}}` | From the customer record |
| `{{TITLE}}` | Quotation title |
| `{{BOQ_TABLE}}` | **Keep on its own line** — replaced by each titled BOQ table (with your pasted headers), then a Subtotal / GST / Total table |
| `{{SUBTOTAL}}` / `{{TAX_PCT}}` / `{{TAX_AMOUNT}}` / `{{TOTAL}}` / `{{CURRENCY}}` | Amounts (use in a covering paragraph if you like) |
| `{{VALID_UNTIL}}` / `{{NOTES}}` / `{{COMPANY}}` / `{{PREPARED_BY}}` | Validity, builder notes, company name, the signed-in user |

The builder no longer uses fixed columns. Instead you **paste one or more BOQ tables straight from Excel** — for each table the **first pasted row is taken as the column headers**, and the rest as rows, so the quote can carry whatever columns your BOQ has. Use **+ Add another BOQ table** to include several tables (e.g. one per section), each with its own optional **title**. The **Subtotal is entered manually** (the app does not compute it from the pasted cells); GST % is then applied to give the total. **Generate Doc + PDF** copies the template, fills it, renders each titled table at `{{BOQ_TABLE}}` followed by the Subtotal / GST / Total, saves both files to the Quotations folder, and links them on the record. Every revision keeps its own files.

**Uploading a quotation prepared outside the CRM.** On any customer or case page, use **Upload quotation** to attach an offer you made elsewhere (PDF, Word or Excel, up to about 8 MB) so it is on record against the case. Give it a title, total value and status (Sent by default), pick the case (or let one be created at the **Quoted** stage), and the file is stored in the Quotations folder and linked to the record. Uploaded quotations get a normal quote number and take revisions like any other — **New revision** on an uploaded quote asks for another file. There is no Doc/PDF generation for them, since there is no template involved.

## 8. Security model — what to never do

Protection comes entirely from the sheet being private. So:

- **Never share the database spreadsheet** with anyone, not even view-only. Only **L6 (Admin)** opens it via the Admin links; the file itself stays owner-only.
- The interface has no export, no "select all", and caps searches (80 customers, 300 cases), so a Sales user cannot harvest the list.
- Every change is written to the **ActivityLog** tab with who/when/what.
- Generated quotation files are shared "anyone in the domain with the link" so colleagues can open them from the CRM. If your Workspace blocks link-sharing, files still open for the admin and can be shared case-by-case.

## 9. Changing the account that owns the CRM (e.g. `crm@` → `admin@`)

The CRM runs **as its owner**: the account that owns the script also owns the database sheet and the Drive folders, and the web app executes with that account's access. So switching accounts means moving all of it.

**If you have not gone live yet (recommended): just set it up as the new account.** Sign in as `admin@`, create the Apps Script project there, paste the code, run `setupCRM`, and deploy (§2). That gives `admin@` a clean database and folder, seeds it as the first **L6** admin, and produces a new web app URL to share. Then delete the old project and folder from `crm@`. This is by far the cleanest path and needs no migration steps.

**If you already have live data,** move the existing setup instead:

1. Signed in as `crm@`, in Drive transfer ownership of the **AS CRM** folder (and the files inside it — the database sheet, Templates and Quotations folders) to `admin@`.
2. Transfer ownership of the **Apps Script project** to `admin@` the same way (it appears in Drive).
3. Sign in as `admin@`, open the project, and **Deploy → Manage deployments → ✏️ Edit → Version: New version → Deploy**. The web app URL stays the same, but it now executes as `admin@`. Approve the authorization prompt when asked.
4. Run **`makeMeAdmin()`** once from the editor (function dropdown → Run). This makes the signed-in account an active **L6** admin with all tags, so `admin@` can reach the Admin screen.
5. Recreate the weekly **`backupDatabase`** trigger — triggers belong to the account that created them and do **not** transfer (§11).
6. Optionally demote or deactivate the old `crm@` user under **Admin → Users**.

Script Properties (which hold the database and folder IDs) belong to the project, not the user, so they survive the transfer — the CRM keeps pointing at the same sheet.

## 10. Updating the code later

Edit `Code.gs` / `Index.html` in the editor, save, then **Deploy → Manage deployments → ✏️ Edit → Version: New version → Deploy**. The URL stays the same. (Creating a *new* deployment gives a new URL — avoid that.)

## 11. Backups & migrating v1 data

- **Fresh start:** `resetCRM()` clears the stored database/folder IDs so the next `setupCRM()` builds a clean database (it deletes no data). Useful after deleting the Drive folder or to start over.
- **Backups:** `backupDatabase()` copies the sheet into the AS CRM folder with a date stamp. To run it weekly: editor → **Triggers (clock icon) → + Add Trigger** → function `backupDatabase`, *Time-driven*, *Week timer*, pick a day/time.
- **Keeping v1 data:** export your old `Customers` to Excel, add the new **Tag / Type / Priority** columns, and re-import via the **Import** tab into a fresh v2 database (§5). Old opportunities map to cases by stage; the simplest is to re-enter open ones and start clean. A fresh database is recommended over an in-place column shuffle.

## 12. Capacity notes

Apps Script comfortably handles a 20-person team: thousands of customers, tens of thousands of rows. v2 is noticeably faster than v1 because it reuses sheet handles within a request, caches settings and a compact search index, and loads the dashboard in a single call. Practical limits: ~30 simultaneous executions (fine for 20 users), each request finishes in well under a second except PDF generation (~3–6 s), and generous daily document quotas. If the sheet ever grows past ~50k quotation lines and feels slow, archive old years into a copy.

## 13. Troubleshooting

- **Blank screen / "Could not identify your Google account"** — deployment access is wrong. It must be *Anyone within your domain*, executing as *Me*. Also happens if a personal Gmail is signed into the same browser profile — open the URL in the work-account profile.
- **"You are not registered yet"** — working as designed; add the email shown under Admin → Users.
- **"Setup pending"** — `setupCRM()` was never run, or Script Properties were cleared. Re-run it (safe; it won't duplicate an existing database).
- **"Setup already done" but the Drive folder is gone** — `setupCRM()` checks a stored database ID, not the folder, so deleting the folder doesn't reset it. Run **`resetCRM()`** (function dropdown → Run) to clear the stored IDs, then run **`setupCRM()`** to build a fresh database. `resetCRM` never deletes data — any old spreadsheet/folders just stay in your Drive (and Trash) until you remove them by hand.
- **A user can't see a customer** — check the customer's tag against the user's allowed tags, or add them as an account handler. L1 users never browse customers by design.
- **Won won't save** — it needs both an order value greater than zero and at least one category selected.
- **Template didn't fill something** — check placeholder spelling (double braces) and that `{{BOQ_TABLE}}` sits on its own line.

## 14. Phase 2 ideas (when you're ready)

Your **Order workflow** (coordination review → design/drawing approvals → BOM → panel work order → fabrication/paint/wiring or vendor → testing → inspection → dispatch, plus supply break-ups and service commissioning) maps naturally onto the same architecture: an Orders module that picks up where a Won case leaves off, with partial-delivery tracking and a drawing-approval loop — no new infrastructure. For management reporting, point Looker Studio (free) at the database sheet without touching the CRM.
