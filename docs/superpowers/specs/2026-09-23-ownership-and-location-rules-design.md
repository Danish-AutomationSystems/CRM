# Ownership and location rules — design spec

Date: 2026-09-23
Status: Approved by the owner (breakdown and sequencing confirmed before writing)

Supersedes parts of `docs/reports/2026-09-21-case-creation-redesign.html`, whose Q4, Q5, Q6 and Q8
answers the owner amended on 2026-09-23. Builds on the live model in
`docs/superpowers/specs/2026-09-18-eliminate-case-owner-layer-design.md`.

## The model, in one place

**A case's handler is its customer's account handler. Always.** Case ownership is derived from the
customer's handlers and never stored on the case — already true since 2026-09-18. What changes:

1. **The creator fallback is deleted.** A case whose account has no real handler is owned by
   **Direct**, not by whoever created it. This is the "ghost visibility" the owner wants gone.
2. **`direct` stops being filtered out of ownership.** It is already stored as a real row in
   `public.handlers` (CUST-0003, 0004, 0006, 0010 hold one today), so this exposes an existing
   mechanism rather than inventing one.
3. **Every customer always has at least one handler row** — a real user, or `direct`.

Nobody gains access from Direct: no account has the email `direct`, so a Direct-owned case is
visible only to L4+ (who see everything by role) and to the case's assignee.

### Rules

| Situation | Account handler becomes |
|---|---|
| L2–L4 creates a customer | that creator |
| L5 or L6 creates a customer | `direct` |
| A Direct-held customer is later given a real handler (L2–L4, assigned by L3–L6) | that handler, who thereby owns all of its cases |
| A handler is removed, others remain | the remaining handlers |
| The **last** real handler is removed | `direct` |

L5 and L6 can never be an account handler and therefore never a case handler.

## Verified starting state

Checked directly against production, not assumed:

- **1** customerless case exists (`CASE-2026-0012`) — Q6 is a one-row cleanup, not a migration.
- **0** customers hold more than one tag — the single-location rule needs no data migration.
- **4** customers have no handler row at all (`CUST-0002`, `CUST-0007`, `CUST-0008`, `CUST-0011`) —
  these need `direct` backfilled.
- `allowed_tags` holding `'*'`: `testing@` (L2) and `danish@` (L4).
- `accessLevel()` returns `FULL` for L4+ **before** tags are consulted, so tags are functionally
  irrelevant above L3. For L2 the wildcard grants only `NAME`, not full detail.

## Work packages

### P1 — Direct replaces the creator fallback

Delete the creator fallback from `caseHandlers()` (`src/server/auth/access.ts`). Stop excluding
`direct` from displayed ownership. Backfill a `direct` handler row for the four customers that have
none.

- **Goal:** no case or customer ever displays an empty owner, and a creator never sees a case purely
  because they created it.
- **Blast radius: HIGH.** `access.ts` decides who sees every customer and case.
- **Security:** this *reduces* access, which is the point. The test matrix must prove nobody
  **gains** access — particularly that `direct` grants nothing to anyone.
- **Scalability:** none. Pure derivation, no new queries.

### P2 — A case cannot exist without a customer

Remove the "create without customer" control **and its server path**. `createCase`, `quickLog` and
the quotation auto-case path all reject an empty customer. Delete `CASE-2026-0012`.

- **Goal:** customerless cases become impossible, so P1's fallback question can never recur.
- **Blast radius:** medium — three creation paths plus the UI.
- **Security:** neutral.
- **Scalability:** none.
- **Note:** this replaces the approved design's 5-4-3-2-1 timed redirect. With no way to start a
  case without a customer, there is nothing to redirect away from.

### P3 — The creator owns what they create

On customer creation: an L2–L4 creator becomes the account handler; an L5/L6 creator yields `direct`.
The handler / assignee / neither opt-in from the approved design is **removed** — there is no opt-out
at creation. A creator who should not hold the account is removed afterwards through the existing
handler-removal flow, which P4 governs.

The owner's rule was "default handler **and** assignee". The assignee half **already behaves this
way and needs no change**: `createCase` assigns the creator when they are below L5 and no assignee
was given, and requires L5/L6 to choose someone explicitly
(`src/server/cases/service.ts:642-648`). Verified before writing this, and recorded here so it is
not "fixed" into something else later. Only the handler half is new work.

- **Goal:** every customer has an owner from the moment it exists.
- **Blast radius:** medium — the customer creation path and the UI control being deleted.
- **Security:** grants the creator `FULL` on their own customer. Intended.
- **Scalability:** none.

### P4 — Removal cascade, with Direct as the floor

Removing an account handler removes them from every one of that customer's cases. **This already
happens** — ownership is derived, so nothing needs to propagate. The new requirement is the floor:
removing the **last** real handler inserts a `direct` row in the same transaction.

- **Goal:** ownership can never reach zero.
- **Blast radius:** medium — handler removal in `customers/service.ts`.
- **Security:** removes access. Intended.
- **Scalability:** none.

### P5 — A customer holds exactly one location

Validation and UI: a customer's `tags` must contain exactly one entry, on create and on edit. Users
are unaffected and keep multiple locations.

- **Goal:** one location per customer, so "customers in this location" is unambiguous — which P7 depends on.
- **Blast radius:** low. No customer currently violates it.
- **Security:** neutral.
- **Scalability:** none.

### P6 — Remove the `*` wildcard

Delete the `allowedTags.includes('*')` branch from `tagMatches()`. Migrate the two accounts holding
it: `danish@` (L4) to `[]`, `testing@` (L2) to the explicit list of all current locations.

- **Goal:** a location grant means one thing — a named list.
- **Blast radius: HIGH.** This is access control.
- **Security:** `danish@` is provably unaffected (L4 short-circuits to `FULL` before tags).
  `testing@` keeps exactly today's reach because the explicit list is equivalent to the wildcard. A
  refactor must not silently change who can see what; narrowing that account later is a separate,
  deliberate decision.
- **Scalability:** none.

### P7 — Location removal is blocked by unhandled customers

Removing a location from a user is refused while that user still handles any customer carrying that
location. The UI shows those customers, each with a dropdown to choose a replacement handler.
Only once every conflict is resolved does the removal succeed.

- **Reassignment target:** any active L2–L4 user, or **Direct**. Direct is offered because it is the
  legitimate "no real owner" state, and without it an admin could be stuck with no eligible user.
  No location-tag requirement on the new handler: being a handler already grants `FULL` regardless
  of tags (`accessLevel()` returns `FULL` for a handler before tags are read).
- **Atomicity:** reassignments and the location removal happen in one transaction. A partial apply
  must be impossible — half-reassigned customers would leave owners wrong with no error shown.
- **Goal:** a location can never be removed in a way that strands customers.
- **Blast radius: HIGH** — new RPC, new UI, and a transaction touching handlers.
- **Security:** the replacement handler must be validated server-side as an active L2–L4 user or
  Direct. The client's list is a convenience, never the authority.
- **Scalability:** needs customers filtered by handler **and** location. At the owner's volume
  (~1,000 customers) this is trivial, but it must not reintroduce a per-customer query loop — the
  exact defect that caused the 2026-09-22 outage. One batched query.

## Sequencing

**P1 lands first and alone.** Everything else assumes Direct semantics, and it is the
highest-risk file in the codebase.

```
P1  →  P2 → P3 → P4      (ownership / creation)
       P5 → P6 → P7      (locations)
```

The two tracks are **not** implemented in parallel: both modify `customers/service.ts`, and a merge
conflict in the file governing ownership is precisely where a silent mistake would do most damage.
They may be reviewed in parallel.

## Testing

Test-first throughout. Every test must be watched failing before its implementation exists.

**P1 — the access matrix, the sharpest part of this work:**
- a creator does **not** see a case on a Direct-held account (the defect being fixed)
- a creator **does** still see it if they are the assignee
- a real handler sees it; an unrelated L2/L3 does not; L4+ always does
- `direct` grants access to nobody
- a customer with zero handler rows still resolves to Direct rather than to empty
- adding a real handler to a Direct-held customer transfers ownership of **all** its cases

**P2:** each of the three creation paths rejects an empty customer, with a legible error.

**P3:** L2, L3 and L4 creators become the handler; L5 and L6 creators yield `direct`.

**P4:** removing one of several handlers leaves the rest; removing the last inserts `direct` in the
same transaction; the removed handler immediately loses access.

**P5:** zero tags rejected; two tags rejected; exactly one accepted — on both create and edit.

**P6:** `'*'` no longer grants anything; an L2 with an explicit list sees exactly the customers in
those locations and no others; an L4 with `[]` still sees everything.

**P7:** removal blocked while conflicts exist; the conflict list contains exactly the right
customers; reassignment to an ineligible user (L5/L6, inactive, unknown) is rejected server-side;
a failure mid-way rolls back every reassignment; removal succeeds once clear.

Plus: the full existing suite (793 tests) stays green.

## Non-goals

- No change to the assignee/ticket-holder model beyond what the rules above require.
- No pagination or read-model rework — see `docs/reports/2026-09-23-capacity-assessment.md`.
- No caching. The duplicate-query defect was fixed by removing duplication, not by caching it.
- The role-level staff guide (`role-guide-l1-l6.docx`) is not updated here; its L2 section will need
  revising once these rules ship.
