# Case aging indicator — design spec

Date: 2026-08-24
Status: Approved

## Problem

Two of the project owner's outstanding requests (numbered 8 and 9 in the working task list):

8. In "My work," give a ticket a yellow flag if it's 2 days old with no update, red if 3 days old.
9. In the admin case list, the same yellow/red rule, but **only** for cases that are still Open (no
   outcome set) — a closed case sitting untouched is expected, not a problem.

Today there is no aging/staleness signal anywhere in the client. A case can sit untouched
indefinitely with zero visual difference from one updated an hour ago.

## Scope

Two render sites, one shared mechanism:

- **Cases tab table** (`renderCases()` in `docs/source-appscript/Index.html`) — the full case list
  every L5/L6 admin browses. This is task 9's "admin list."
- **"My work" / "assigned to me" ticket card** (`openCasesHTML()`, shared by `renderL1Dash()` and the
  regular dashboard's `dashBlocksHTML()`) — this is task 8. Because both dashboard variants already
  route through this one function, fixing it once covers every level ("any L[user]" per the original
  wording), not just L1.

Out of scope, deliberately: the customer-detail view's own cases table, quote lists, or any other
screen. Not requested; adding it there is a trivial follow-up later if wanted, not bundled in now.

## Rules

- **What resets the clock:** `cases.updated_at` — any field change on the case. Already tracked,
  already sent to the client on every case row that matters here. No new column, no new query.
- **Day math:** calendar-day difference in IST, not elapsed-hours. A case last touched yesterday
  evening is already "1 day old" this morning — matches how a manager actually thinks about staleness,
  not a strict 24h/48h/72h countdown. Computed with `Intl.DateTimeFormat` against `Asia/Kolkata`, the
  same approach `fmtDateTime()` (shipped 2026-08-24) already uses — not manual UTC-offset arithmetic.
- **Bands:** 0–1 days since update → nothing shown. Exactly 2 days → yellow. 3 or more days → red.
- **Outcome gate:** the chip only ever appears when `outcome === ''` (Open). Won/Lost/Hold cases never
  get colored, regardless of how stale `updated_at` is. This applies at both render sites — the "My
  work" list is already outcome-filtered to Open-only by the query that builds it, but the aging helper
  itself also checks outcome defensively, so it's correct even if a future caller feeds it a case with
  an outcome set.

## Data model change

None. No migration, no new column, no new RPC.

One existing gap: the dashboard's ticket payload (`src/server/dashboard/service.ts`, the `tickets` and
`openMine` arrays built inside the per-user dashboard aggregation) currently sends
`{ id, title, customerId, customerName, stage, priority }` — no `updatedOn`. The value is already on
the row each entry is built from (`row.updatedAt`), so this is a one-field addition to two object
literals and their TypeScript array types, not a new query or join.

The Cases tab's `api_listCases` payload already includes both `updatedOn` and `outcome` per row — no
server change needed for task 9 at all.

## Client architecture

Two small helpers, added next to the existing chip functions (`priChip`, `stageChip`, `outcomeChip`,
line ~360 of `Index.html`) and the existing date helper (`fmtDateTime`, added earlier today):

```js
function daysSinceIST(iso){
  // Calendar-day difference between `iso` and "now", both read as IST wall-clock dates.
  // Returns null for empty/unparseable input (caller decides what that means).
}

function agingChip(updatedOn, outcome){
  // '' if outcome is truthy (closed) or updatedOn is missing/invalid or days < 2.
  // '<span class="badge b-amber">2d stale</span>' at exactly 2 days.
  // '<span class="badge b-red">Nd stale</span>' at 3+ days, N = actual day count.
}
```

Visual treatment reuses the existing badge system (`.badge.b-amber` / `.badge.b-red`, already defined
in the stylesheet and already used by `priChip`/`stageChip`/`outcomeChip`/the user-role and
quote-status chips) rather than introducing new CSS or a bare color decoration. A colored badge with
text ("2d stale") is legible at a glance and doesn't rely on color alone to carry meaning.

### Call sites

- `renderCases()`: append `agingChip(o.updatedOn, o.outcome)` next to the existing "Updated" cell (or
  the Status cell — implementer's call on exact placement, but it must render inline with the row, not
  require a separate column, since this is a decoration, not new tabular data).
- `openCasesHTML()`: append `agingChip(t.updatedOn, t.outcome)` (or `''` fallback if `outcome` is
  absent on this object — see below) next to the existing stage/priority chips on each ticket card.

`openCasesHTML()`'s two callers (`dashBlocksHTML`'s `tickets` and `renderL1Dash`'s
`d.self.tickets || d.self.cases` fallback) both come from the same server aggregation, so both will
carry `updatedOn` once the server change lands. Neither currently carries an explicit `outcome` field
(they're pre-filtered to open-only server-side) — `agingChip` must treat a missing/undefined `outcome`
as open (proceed to check staleness), not as closed, so it still works correctly for these callers.

## Testing

- `daysSinceIST`: known IST-midnight-crossing case (mirrors the existing `fmtDateTime` test fixture —
  same UTC timestamp, prove the day boundary lands correctly in IST, not UTC); null/empty/invalid input
  returns `null` without throwing.
- `agingChip`: 0/1 days → `''`; exactly 2 → contains `b-amber` and `2d`; 3 and 5 days → contains `b-red`
  and the correct day count; any non-empty `outcome` → `''` regardless of day count; missing `outcome`
  (undefined) with 3+ days → still renders red (proves the dashboard call sites work without an
  explicit outcome field).
- Server: `src/server/dashboard/service.test.ts` — extend the existing per-user dashboard test to assert
  `updatedOn` is now present and correct on both `tickets` and `cases` (`openMine`) entries.
- One render-level jsdom test per call site (Cases tab row, My-work card) proving a stale Open case
  shows the chip and a stale-but-closed case doesn't.

## Known risks / non-goals

- This is a point-in-time signal computed at render time from data already on the page — it does not
  auto-refresh while a screen is left open (same as every other chip/value in this client; the whole
  app re-renders on navigation/poll, not live). Not a regression, matches existing behavior everywhere
  else.
- No admin-configurable thresholds. 2/3 days are hardcoded, same status as the hardcoded `STAGES`/
  `OUTCOMES` lists elsewhere in this codebase — revisit only if actually requested later.
