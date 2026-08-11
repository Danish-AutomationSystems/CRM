# Role-Based Access Matrix (as of 2026-08-11)

Manager review point P2: "Make a role-based matrix of who can do what for similar scenarios."

This document is a **read-only trace of the current source code** on `feat/crm-points-manager-feedback`. It documents behaviour rewritten earlier the same day (2026-08-11) — do not cross-reference `CONTEXT.md` or older docs for the ownership/handler rules; they describe the pre-rewrite model. Every claim below cites a `file:line`. Where a rule could not be located in code, it is marked **UNVERIFIED** rather than asserted.

Roles are `L1` (lowest) .. `L6` (admin). `roleLevel(user) = Number(user.role.slice(1))` — e.g. `src/server/auth/access.ts:15-17`, duplicated identically in `src/server/customers/service.ts:201-203`, `src/server/cases/service.ts:170-172`, `src/server/quotes/service.ts:190-192`, `src/server/dashboard/service.ts:35-37`.

---

## 1. Primary action matrix

Legend: **Yes** = unconditionally allowed at that level. **No** = never allowed regardless of anything else. **Cond.** = allowed only if the named condition holds; the condition is always checked in addition to, not instead of, the level shown.

| Action | L1 | L2 | L3 | L4 | L5 | L6 | Condition (for Cond. cells) / citation |
|---|---|---|---|---|---|---|---|
| Create customer | No | Yes | Yes | Yes | Yes | Yes | `requireLevel(user, 2)` — `customers/service.ts:550-551`. L5/L6 creators are auto-recorded as the virtual `Direct` handler, not themselves — `customers/service.ts:214-216` (`creatorHandlerEmail`), used at `customers/service.ts:592-597`. |
| Edit customer details (area/address/gstin/website/notes/sei/remarks/name) | No | Cond. | Cond. | Cond. | Cond. | Cond. | Requires FULL access to the customer (`ensureFullCustomer` → `ensureFull` → `accessLevel`, `customers/service.ts:403-414,628-631`). See §2 for who gets FULL. |
| Edit priority | No | Cond. | Cond. | Cond. | Cond. | Cond. | FULL access **and** `requireLevel(user, 2)` — `customers/service.ts:384-387`. Below L2 the RPC itself is blocked earlier by `ensureFullCustomer`; L2+ additionally needs the explicit priority gate (redundant with the outer L2 update gate but present). `customerMeta().canEditPriority = roleLevel>=2` — `customers/service.ts:335`. |
| Edit location (tags) / type / archive status | No | No | Cond. | Cond. | Cond. | Cond. | FULL access **and** `roleLevel(user) >= 3` — `customers/service.ts:389-398`. `canEditClass`/`canEditTags` in the UI payload mirror this — `customers/service.ts:336,540`. Tags can never be emptied (`requiredTags`, `customers/service.ts:250-256`). |
| Delete customer (soft-delete → recycle bin) | No | No | Cond. | Cond. | Cond. | Cond. | `requireLevel(user, 3)` — `customers/service.ts:905-906` — **plus** the caller must independently have FULL access per-row (`ensureFull` inside the loop, `customers/service.ts:920-921`; a no-access row is silently skipped, not a hard error) — **plus** the customer must have zero cases and zero quotations (`customers/service.ts:927-930`). |
| Add account handler | No | Cond. | Cond. | Cond. | No | No | Caller must be an existing handler of that customer, OR `roleLevel(user) >= 3` — `customers/service.ts:830-834`. Target user must be active — `customers/service.ts:837-840`. Target must NOT be L5/L6 — `customers/service.ts:841-847` ("L5 and L6 users cannot be account handlers"). |
| Remove account handler | No | Cond. | Cond. | Cond. | No¹ | No¹ | Same "existing handler OR L3+" gate — `customers/service.ts:882-887`. ¹L5/L6 can never be a handler in the first place (see row above), so this is moot for them, not a separate rule. |
| Create case (on an existing customer) | No | Yes | Yes | Yes | Cond. | Cond. | `requireLevel(user, 2)` — `cases/service.ts:354-355` — **plus** FULL access to the customer (`ensureFull`, `cases/service.ts:360`). At L5+, if no `assignee` was supplied and it's not an order, the call is **rejected**: "Choose who this case is assigned to." — `cases/service.ts:373-376`. Below L5, an omitted assignee silently defaults to the creator — `cases/service.ts:376-378`. |
| Change case stage | Cond. | Cond. | Cond. | Cond. | Cond. | Cond. | Gated purely by case visibility (`ensureCanSeeCase` inside `loadVisibleCase`, `cases/service.ts:417-418,434-436` calling `cases/service.ts:277-290`), not by role level — see §3 "who can see a case" for the condition. Blocked while `outcome` is `Won`/`Lost` — `cases/service.ts:438-440`. |
| Set case outcome (Won/Lost/Hold/reopen) | Cond. | Cond. | Cond. | Cond. | Cond. | Cond. | Same visibility gate, no extra level check — `cases/service.ts:456-458`. Won requires order value > 0 and ≥1 category — `cases/service.ts:485-489`. |
| Add case owner | Cond. | Cond. | Cond. | Cond. | Cond. | Cond. | Caller must (a) already be visible to the case AND (b) either already be a case owner OR `roleLevel(user) >= 4` — `cases/service.ts:513-518`. Target must be an active, non-Direct user (`resolveUser`, `cases/service.ts:239-245`) — so L5/L6 CAN be added as case owners. |
| Remove case owner | Cond. | Cond. | Cond. | Cond. | Cond. | Cond. | Same "owner OR L4+" gate — `cases/service.ts:534-539`. Blocked if it would leave the case with 0 owners — `cases/service.ts:544-548`. Blocked outright if the target is a real account handler of the customer ("Remove them as a handler on the customer instead") — `cases/service.ts:549-551`. |
| Assign / reassign ticket | Cond. | Cond. | Cond. | Cond. | Cond. | Cond. | Requires case visibility only, no role gate (`assignTicket`, `cases/service.ts:565-566`). Blocked whenever `row.outcome` is truthy, i.e. the case is closed — `cases/service.ts:567`. `getCase().canAssign = roleLevel>=2` is a **separate UI-only flag** returned alongside `canAssignTicket:!row.outcome` (`cases/service.ts:591-592`) — the two are not the same gate; `canAssign` does not actually gate `assignTicket` server-side. Target must be an active, non-Direct user — `cases/service.ts:239-245,349` (Direct can never hold a ticket). |
| Create/generate quotation (from template) | No | Cond. | Cond. | Cond. | Cond. | Cond. | `requireLevel(user, 2)` — `quotes/service.ts:456-457` — plus FULL customer access — `quotes/service.ts:255-264,459`. |
| Upload external quotation | No | Cond. | Cond. | Cond. | Cond. | Cond. | Same: `requireLevel(user, 2)` — `quotes/service.ts:538-539` — plus FULL customer access — `quotes/service.ts:541`. |
| Set quote status (Draft/Sent) | Cond. | Cond. | Cond. | Cond. | Cond. | Cond. | FULL customer access only, via `loadQuote`→`ensureFull` — `quotes/service.ts:412-419,661,666`. No `requireLevel` call on this action at all. |
| Generate Doc/PDF, save to Drive | Cond. | Cond. | Cond. | Cond. | Cond. | Cond. | Same: FULL customer access only, no `requireLevel` — `quotes/service.ts:683-684`, `src/server/drive/service.ts` (**UNVERIFIED** whether `saveQuotationToDrive` in `drive/service.ts` adds its own gate beyond calling into `quoteService`; not read in this pass — see note below). |
| View own dashboard | Yes | Yes | Yes | Yes | Yes | Yes | `dashboard(user)` with no `forEmail` defaults `target = normalizeEmail(user.email)` — `dashboard/service.ts:283-291`, always permitted. |
| View another named user's dashboard | No | No | Cond. | Cond. | Cond. | Cond. | Requires `roleLevel(user) >= 3` — `dashboard/service.ts:307`. At exactly L3, two extra conditions both apply: target must be role `L2` AND must share ≥1 tag with the viewer (or viewer has `'*'`) — `dashboard/service.ts:310-312`. L4+ can view any active user's dashboard with no tag/role restriction — `dashboard/service.ts:310` (`roleLevel(user) < 4` guards the extra checks). |
| View the virtual `Direct` dashboard | No | No | No | Yes | Yes | Yes | `roleLevel(user) < DIRECT_VISIBLE_FROM_LEVEL` (=4) throws — `dashboard/service.ts:294-299`, constant at `domain/direct.ts:28`. `Direct` is also only offered in the peer picker to L4+ — `dashboard/service.ts:253-257`. |
| Admin: user management (list/save users) | No | No | No | No | No | Yes | `ensureAdmin(user)` requires `user.role === 'L6'` exactly — `auth/access.ts:155-161`, called at `admin/service.ts:443,472`. |
| Admin: settings (tags/types/priorities/categories/SEI/sources/tax/currency/company) | No | No | No | No | No | Yes | `ensureAdmin` — `admin/service.ts:522`. **Sharp edge**: writes succeed but most consumers still read hardcoded `DEFAULT_SETTINGS`, not this table — see CONTEXT.md's 2026-08-11 "settings table is write-only" entry; not re-verified in this pass, flagged here only because it changes what "can edit settings" actually accomplishes. |
| Admin: recycle bin (list/restore/purge) | No | No | No | No | No | Yes | `ensureAdmin` — `admin/service.ts:756,773,799`. |
| Admin: run import (customers/contacts) | No | No | No | No | No | Yes | `ensureAdmin` — `admin/service.ts:592,695`. Imported rows whose sheet-supplied handler emails resolve to L5/L6 users are filtered out and the customer falls back to `Direct` (if the importing admin is themself backend-role) or to the importing admin — `admin/service.ts:606-607,662-669`. |
| Admin: view DB/table links | No | No | No | No | No | Yes | `ensureAdmin` — `admin/service.ts:568`. |
| See all customers regardless of tag/handler (`allCustomers`) | No | No | No | Yes | Yes | Yes | `requireLevel(user, 4)` — `customers/service.ts:485-486`. This is also exactly the level at which `accessLevel()`'s `seesAll()` kicks in (see §2), so it is consistent with, not an exception to, the FULL/NAME/NONE matrix. |

---

## 2. Customer-access sub-matrix — `accessLevel()`

Source: `src/server/auth/access.ts:34-50` (`accessLevel`), consumed everywhere a customer is loaded. Evaluated top-to-bottom, first match wins:

1. `seesAll(user)` — `roleLevel(user) >= 4` → **FULL**, unconditionally, regardless of handler/tag. (`access.ts:19-21,39`)
2. Else if the caller's email is in the customer's stored handler set → **FULL**. (`access.ts:41-42`, `customerHandlers`/`ownership.handlerEmailsByCustomerId`)
3. Else, `matchesTag = tagMatches(user, customer)` — true if the user has `'*'` in `allowedTags`, or the customer's tags intersect the user's `allowedTags` (`access.ts:27-32`).
4. If `roleLevel(user) >= 3` → **FULL** if tag matches, else **NAME**. (`access.ts:47`)
5. If `roleLevel(user) === 2` → **NAME** if tag matches, else **NONE**. (`access.ts:48`)
6. Else (L1) → **NONE** always. (`access.ts:49`)

| Role | Is a handler of this customer | Not a handler, tag matches | Not a handler, tag does not match |
|---|---|---|---|
| L1 | FULL² | NONE | NONE |
| L2 | FULL | NAME | NONE |
| L3 | FULL | FULL | NAME |
| L4 | FULL | FULL | FULL |
| L5 | FULL³ | FULL | FULL |
| L6 | FULL³ | FULL | FULL |

² The handler check at `access.ts:41-42` runs before any level branching and has no minimum-level guard, so a stored handler gets FULL access at any role including L1. Whether an L1 can legitimately end up as a handler is a separate question: `addHandler` only requires the *adder* to be an existing handler or L3+ (`customers/service.ts:832-834`); it places no restriction on the *target's* level, only that they are an active user (`customers/service.ts:838`) and not L5/L6 (`customers/service.ts:841-847`) — so an L1 target is a valid handler.

³ L5/L6 reach FULL here via `seesAll()` (role ≥ 4, `access.ts:39`), never via handler membership — they are structurally barred from ever being a stored handler (`customers/service.ts:206-208,841-847`). Their FULL access is role-derived, not handler-derived; see Scenario B in §5 for why that distinction matters.

NAME access exposes only `{id, name, tags, type, priority}` and the handler list, never contacts/cases/quotes — `customers/service.ts:519-531`. FULL access exposes the full customer plus contacts, cases and quotes — `customers/service.ts:533-547`.

`ensureFull` (`access.ts:129-141`) is the hard gate used by every mutating customer/case/quote action; it throws unless `accessLevel(...) === 'FULL'`.

---

## 3. Case visibility — `caseVisible()` / `ensureCanSeeCase()`

Source: `access.ts:115-153`. A case is visible to a user if **any** of:

1. `seesAll(user)` (L4+) — always visible. (`access.ts:120`)
2. The user's email is in `caseOwners(caseRecord)` (see §4 below for what that set is). (`access.ts:122-123`)
3. The user's email equals the case's `assignee`. (`access.ts:124`)
4. The customer-level access for that case's customer is `FULL` (per §2). (`access.ts:126`)

This is role-independent below L4 — an L1 who happens to be a case owner, the assignee, or has FULL customer access can see/act on that case (change stage, set outcome, reassign the ticket — none of those three actions add a further `requireLevel` call, confirmed by their absence from the `requireLevel` call-site list in `cases/service.ts`).

---

## 4. Case ownership — `caseOwners()` / `caseOwnerEntries()` (rewritten today, P10/P11)

Source: `access.ts:52-113`, seeding logic in `cases/service.ts:331-338,396-398,752-753`.

- **Ownership is materialised on the case row** (`cases.extra_owners`), not derived live from `handlers` at read time — `access.ts:62-66` (doc comment), `access.ts:68-74` (`caseOwners`): returns the stored `extraOwners` set if non-empty, else falls back to `[creator]` (excluding `Direct`) if the creator isn't Direct, else `[]`.
- **Seeding at case creation** (`seedOwners`, `cases/service.ts:331-338`): starts as the customer's *real* account handlers (excludes `Direct`, via `customerRealHandlers`, `access.ts:58-60`) if any exist; otherwise falls back to `[creatorEmail]`. So a case on a `Direct`-only account is owned solely by its creator, even if the creator is L5/L6 (their own email, not `Direct`, since `Direct` itself can never be a case owner — enforced structurally: `seedOwners` only ever inserts `creatorEmail`, and `resolveUser`/`addCaseOwner` reject Direct — `cases/service.ts:239-245`).
- **`caseOwnerSource()`** (`access.ts:84-93`) tags each owner email as `'handler'` (currently a real account handler of the customer), `'creator'` (the case's original creator, no longer/never a handler), or `'manual'` (added via `addCaseOwner`, neither of the above).
- **`caseOwnerEntries()`** (`access.ts:100-113`): `removable = source !== 'handler' && owners.length > 1`. Handler-sourced owners are never removable from the case UI — the instruction is to remove them as an account handler instead (matches the runtime check in `removeCaseOwner`, `cases/service.ts:549-551`).
- **When a handler is added** to a customer, they are retroactively added as an owner of every currently-**open** (no `outcome`) case on that account — `customers/service.ts:861-868`. Closed cases, including `Hold` (see §5), are left untouched.
- **When a handler is removed** from a customer, no code path removes them from cases they already own — `customers/service.ts:882-903` only calls `repo.removeHandler`, never touches `cases.extra_owners`. They remain a stored owner of every case they were added to (now surfaced with `source: 'manual'` or `'creator'`, since `caseOwnerSource` re-evaluates against the *current* handler list on each read — `access.ts:90`).

---

## 5. Scenarios

**Scenario A — an L2 creates a customer with tags `["Pune"]`, no explicit handler chosen.**
The creator is auto-added as the sole handler (`creatorHandlerEmail`, `customers/service.ts:214-216`, not backend role so it's their own email) — `customers/service.ts:592-597`. Who can then see it:
- The creator (L2, is a handler): FULL (§2 row 2 → FULL regardless of level, since handler check precedes level branch).
- Any L4+ user: FULL (`seesAll`).
- Any other L3 user whose `allowedTags` includes `Pune`: FULL. If tags don't overlap: NAME.
- Any other L2 user whose `allowedTags` includes `Pune`: NAME (can see name/tags/type/priority/handler list only, not contacts/cases/quotes).
- Any L2 without a `Pune` tag, or any L1: NONE — the customer doesn't appear in search/lists for them at all (`searchCustomers` filters out `NONE`, `customers/service.ts:445-446`).

**Scenario B — an L5 creates a customer with no handler chosen (backend role).**
`creatorHandlerEmail` returns `DIRECT_EMAIL` because `isBackendRole('L5')` is true (`customers/service.ts:206-208,214-216`) — the customer is handled by the virtual `Direct` account, not the L5 creator. The L5 creator themself still gets FULL access via `seesAll()` (L5 ≥ 4), but that's role-derived, not handler-derived — if their role were ever dropped below L4 they would lose FULL unless tags matched.

**Scenario C — that same L5 then creates a case on that Direct-handled customer.**
`seedOwners` finds zero *real* handlers (`Direct` is excluded by `customerRealHandlers`, `access.ts:58-60`) and falls back to `[creatorEmail]` — `cases/service.ts:336-337`. So the case is owned by the L5 personally, sourced as `'creator'` (`caseOwnerSource`, `access.ts:91`), **not** `'handler'` and **not** unowned. This is deliberate per the P11 comment at `access.ts:63-66` ("guarantees the every-case-has-at-least-one-owner rule").

**Scenario D — a handler is removed from a customer after cases already exist.**
The handler-removal code path (`customers/service.ts:882-903`) only deletes the `handlers` row. It never touches any case's `extraOwners`. So:
- Cases where that person's ownership came from being a handler keep them as an owner, but `caseOwnerSource()` will now classify them as `'creator'` (if they created it) or `'manual'` (otherwise) on the next read, since the live handler check no longer matches — `access.ts:90`.
- They become **removable** as a case owner going forward (source is no longer `'handler'`) — `access.ts:110`.
- They keep case visibility via §3 rule 2 (still in `caseOwners`) even though they've lost customer-level FULL access via handler membership — they'd need tag-based NAME/FULL or L4+ to still see the *customer* record, but case visibility itself doesn't require customer FULL access if they're still a listed case owner.

**Scenario E — who can reassign a ticket on a case that is on `Hold`?**
Nobody. `assignTicket` checks `if (row.outcome) throw ...` (`cases/service.ts:567`), and `Hold` is stored as a non-empty `outcome` value (`CaseRow.outcome: '' | 'Won' | 'Lost' | 'Hold'`, `cases/service.ts:57`; set at `cases/service.ts:497-499`). So a held case is, for this purpose, indistinguishable from a Won/Lost case — see §6.

**Scenario F — an L3 user tries to view an L2 colleague's dashboard.**
Allowed only if the target is exactly role `L2` (not L1, L3, etc.) **and** shares at least one tag with the viewer (or the viewer holds `'*'`) — `dashboard/service.ts:307,310-312`. An L3 cannot view another L3's, L4's, or L1's dashboard at all; an L4+ has no such restriction.

**Scenario G — can an L5/L6 be a case owner or ticket assignee even though they can't be an account handler?**
Yes to both, and this is explicit in the product-facing error text: `addHandler`'s rejection message for L5/L6 targets literally says "...can still be added as a case owner or a ticket assignee." — `customers/service.ts:844-846`. `addCaseOwner`/`resolveUser` only exclude the virtual `Direct` account, not any real role — `cases/service.ts:239-245`.

---

## 6. Known sharp edges

1. **`Hold` counts as closed for ticket reassignment.** `outcome` is a tri-state closer (`'' | 'Won' | 'Lost' | 'Hold'`, `cases/service.ts:57`), and `assignTicket` blocks on *any* non-empty outcome (`cases/service.ts:567`), so a case put on Hold cannot have its ticket reassigned until it's moved back to an active stage (which clears `outcome` — `cases/service.ts:444`: "if `row.outcome === 'Hold'`, `setCaseStage` clears it"). Also, `assignee` is force-cleared to `''` on Won/Lost (`cases/service.ts:493,496`) but **not** on Hold (`cases/service.ts:497-499` sets only `closedOn: ''`, leaving `assignee` as-is) — yet `listCases`/`getCase` both blank the *displayed* assignee whenever `outcome` is truthy (`cases/service.ts:592,677`), so a held case shows no assignee in the UI even though the underlying row still has one stored.
2. **Won credit is not split among multiple owners.** In dashboard aggregation, `wonMonthValue`/`won2wValue` add the case's full `orderValue` for **every** subject who is in `caseOwners(row)`, with no division by `owners.length` — `dashboard/service.ts:145-155` (`if (mine && row.outcome === 'Won') { ...wonMonthValue += value... }`, where `mine = owners.includes(subjectEmail)`). A case with 3 owners shows the full order value on all 3 people's dashboards simultaneously.
3. **Handler-sourced case owners cannot be removed from the case, only from the customer**, and the reverse is not symmetric: removing them from the customer does *not* retroactively remove them from cases (§4 Scenario D) — so "remove them as a handler instead" (the error text at `cases/service.ts:550`) does not actually remove their case ownership; it only changes how that ownership is *labelled* going forward.
4. **A newly added handler only inherits ownership of currently-open cases**, not closed ones, including `Hold` — `customers/service.ts:862-868` explicitly `continue`s past any case with a non-empty `outcome`. A handler added the day after a case goes on Hold will never appear as an owner of that case even once it's reopened later, unless separately added via `addCaseOwner`.
5. **`accessLevel`'s handler check has no minimum role** — an L1 stored as a handler gets FULL customer access (§2 correction note). Whether an L1 can legitimately end up as a handler depends entirely on who adds them; `addHandler` doesn't check the *target's* level at all, only that they're active and not L5/L6 (`customers/service.ts:838-847`).
6. **`getCase().canAssign` (`roleLevel >= 2`) is cosmetic, not enforced.** The real gate on `assignTicket` is case visibility plus an open outcome, with no role-level check (`cases/service.ts:565-567`) — an L1 who is a case owner or the current assignee, or who has FULL customer access, can call `assignTicket` server-side regardless of what `canAssign` said in a prior `getCase()` response.
7. **`Direct` is excluded from `listAssignableUsers`** (`cases/service.ts:346-351`, filters `!isDirect(row.email)`) and from being resolved as an owner/assignee (`resolveUser`, `cases/service.ts:242`), but it IS still listed (read-only) in `api_admin_listUsers` (`admin/service.ts:459-467`) and offered as a dashboard-picker peer for L4+ (`dashboard/service.ts:253-257`). It is a "subject" you can view, never a "target" you can assign to.
8. **Settings writes may be inert.** `api_admin_saveSettings` persists to `public.settings` and round-trips through the admin service's own read path, but `dashboard/service.ts`, `customers/service.ts`, and `cases/service.ts` all import validation lists from the hardcoded `src/server/settings/defaults.ts` constant instead of reading the table — flagged in `CONTEXT.md`'s 2026-08-11 entry, not independently re-verified line-by-line in this pass. Treat as **UNVERIFIED-BUT-DOCUMENTED-ELSEWHERE** rather than re-confirmed here.

---

## 7. Verified follow-ups and remaining scope limits

The two items left unverified in the first pass were subsequently traced and are now
**confirmed**:

- **`saveQuotationToDrive` is gated by FULL customer access, with no role floor.**
  Chain: `src/server/drive/service.ts:35` calls `quoteService.getDownloadArtifact()`
  (`src/server/quotes/service.ts:788`), which calls `loadQuote()`
  (`src/server/quotes/service.ts:412`), which calls `ensureFull()` at
  `src/server/quotes/service.ts:418`. So the earlier assumption was right, and it is
  consistent with the other quote-lifecycle actions in §1: access-gated, not level-gated.

- **The RPC registry applies no blanket authorisation gate.** `callRpc()`
  (`src/server/rpc/registry.ts:62-82`) only looks the handler up by name and dispatches it;
  the file contains no role, level or access logic at all. The blanket gate that does exist
  is **authentication**, one layer up: `src/app/api/rpc/route.ts:35` calls
  `getRequestContext(request)` before dispatch, which re-derives identity from the Supabase
  session, enforces the allowed email domain and rejects inactive users
  (`src/server/auth/context.ts:142-154`).

  The practical consequence is worth stating plainly for the matrix's audience:
  **authentication is centralised, authorisation is not.** Every "who can do what" rule in
  this document lives in an individual service function. There is no single chokepoint that
  would catch a new RPC registered without a permission check — such an endpoint would be
  reachable by any authenticated company user. That is a maintenance risk rather than a
  present defect: every action listed in §1 was individually traced and is gated.

Genuinely still out of scope:

- Exact behavior of `saveCustomerCells` batching (`customers/service.ts:642-659`) beyond
  "it calls `updateCustomer` per patch and collects failures" — its per-row error semantics
  under partial permission failure were read but not separately tested.
- Exact behavior of `saveCustomerCells` batching (`customers/service.ts:642-659`) beyond "it calls `updateCustomer` per patch and collects failures" — its per-row error semantics under partial permission failure were not separately tested here, only read.
