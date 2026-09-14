# Case page quote-entry redesign — design spec

Date: 2026-09-14
Status: Approved

## Problem

The already-shipped case-lifecycle feature (Quoted has no ticket holder; Revision requires an
explicit holder; customerless mapping) correctly gates new quote work on a Quoted case behind
`Request Revision`. But the case page still shows three separate buttons —
`Request revision`, `+ Quotation`, `Upload quotation` — and on a Quoted case all three silently
land on the exact same "pick a holder" modal. This is confusing: three buttons that look like
three different actions turn out to be one action, with no explanation of why.

Investigating this surfaced a second, unrelated gap: `setCaseStage` (server-side) allows a case to
be moved directly to `Quoted` via the plain Stage dropdown with **zero quotations ever created** —
the only guard is that a customer is mapped. A case can reach "Quoted" (meaning, by design, "a
quote was sent") without any quote existing at all.

## Scope

This redesign covers exactly:

- The case detail page's action-button row (`Request revision`, `+ Quotation`,
  `Upload quotation` — `docs/source-appscript/Index.html`'s `renderCase()`, currently around
  lines 1438-1441).
- The case page's Stage card and Priority card (`stSel`/`priSel` + their Update buttons).
- The Quotations card (an added hint line only).

Explicitly **out of scope**, confirmed not to touch:

- The Customer detail page's own `+ Quotation` / `Upload quotation` buttons
  (`openBuilderForCustomer()`, `mUploadQuote()` called with no case context) — a different flow
  for starting a quote from a customer rather than a specific case. Left exactly as-is.
- The quote viewer's `New revision` button (`newRevision()`) — already correctly requires a
  holder via `Request Revision` when the case is Quoted (existing, shipped behavior). Left
  exactly as-is.
- Everything about the underlying case-lifecycle rules themselves (Quoted-no-holder, the
  holder-select modal, customerless mapping, the DB constraints) — unchanged. This is a pure
  entry-point/UI redesign on top of already-correct server behavior.

## Rules

1. **Remove the three case-page buttons entirely.** `Request revision`, `+ Quotation`,
   `Upload quotation` no longer appear on the case page, at any stage.
2. **The Stage card (dropdown + `Update stage`) becomes the single entry point** for both
   revision requests and quotation creation on that case:
   - Picking **Revision** + `Update stage`: unchanged existing behavior — opens the mandatory
     holder-select modal (`mRequestRevision`). `doStage`'s existing
     `stage==='Revision' && d.case.stage==='Quoted'` branch already does this; only the now-removed
     standalone button was redundant with it.
   - Picking **Quoted** + `Update stage`: **new behavior.** Does not call `api_setCaseStage`.
     Instead opens a small "Create a new quotation / Upload an existing one" choice, then the
     matching existing form (`mQuoteBuilder` via `withQuoteCustomer`, or `mUploadQuote`), using
     the same case-locked context `caseQuoteContext(d)` already builds today. This is reachable
     only when the case's current stage is *not already* Quoted (see "Why no server change" below
     for why this is the only reachable state), so it covers both the first quote on a fresh
     Lead/Opportunity case and a revision quote while in Revision — one mechanism, no
     stage-specific branching needed in the new trigger itself.
   - **Saving as Draft does not commit the case.** The case's persisted stage is untouched by
     opening this form or saving a Draft from it — it only actually becomes Quoted when that
     quotation is later marked Sent, via the existing, unmodified `bumpCaseToQuoted` mechanism.
     Uploading directly as Sent (the upload form's existing status choice) still flips the stage
     immediately, exactly as it does today.
   - **No admin override.** There is no UI path, for any role, to set a case to Quoted without a
     real quotation behind it. If a case's data ever needs manual repair, that is a direct
     database action outside this UI, not a feature to build.
3. **`Update stage` and `Update priority` are both disabled** (native `disabled` attribute) whenever
   their dropdown's selected value equals the case's current stage/priority. Both enable the moment
   the user picks a different value. Same treatment on both cards for visual consistency.
4. **Discoverability hint, where the buttons used to be** (in or near the Quotations card): a plain
   sentence telling the user where quote-creation moved to, worded for the case's actual current
   state — e.g. "To add a quotation, set the stage to Quoted above" when not Quoted, or "To add a
   new quotation, request a revision above" when already Quoted. Plain text, no button.
5. **Draft-quote hint, in the Stage card, above the dropdown.** If the case has any quotation
   currently in Draft status (regardless of the case's own stage), show a line naming the count and
   linking down to the Quotations card — e.g. "2 quotations are still Draft — see Quotations
   below." No per-quote deep link; it points at the existing Quotations list, which already shows
   each Draft's own `Open` button.

## Why no server change is needed

Every server-side rule this redesign depends on already exists and already ships:

- `createQuotation`/`uploadQuotation` already reject any attempt to attach a quotation — fresh or
  revision — while the case is currently Quoted (the review-fix from the case-lifecycle work).
  Since the new "Quoted" trigger in the Stage card is reachable only when the dropdown's selected
  value (`Quoted`) differs from the case's actual current stage (rule 3's disabled-button gate),
  it is structurally never reachable while the case is already Quoted — so the client never needs
  to duplicate that guard.
- `bumpCaseToQuoted` already flips the case to Quoted, with the holder cleared, purely as a side
  effect of a quotation reaching Sent status — whether that quotation was reached via the old
  buttons or the new Stage-card trigger makes no difference to the server.
- Revision-stage quotation creation was never blocked server-side (only the Quoted-stage guard
  exists) — a revision quote reached via the new trigger needs no new server allowance.

This is a client-only (`docs/source-appscript/Index.html`) change.

## Architecture

- `doStage(id)`: gains one new branch, parallel to the existing Revision branch. When the selected
  value is `Quoted` (and, by construction, differs from the case's current stage — the disabled
  button already guarantees this), open the new Create/Upload choice instead of calling
  `api_setCaseStage`. The existing `stage===d.case.stage` early return and the Revision branch are
  otherwise unchanged.
- New function (name at implementer's discretion, e.g. `mAddQuotationForCase()`): renders the small
  Create/Upload choice card. Picking Create calls `withQuoteCustomer(caseQuoteContext(d), mQuoteBuilder)`
  (the same call `openBuilderForCase()` makes today, minus its now-dead Quoted-redirect branch).
  Picking Upload calls `mUploadQuote(undefined, caseQuoteContext(d))`-equivalent (reusing
  `mUploadQuote`'s existing case-context handling — check its current signature/behavior when
  called with a pre-built context rather than deriving one from `uploadCtx()`).
- `openBuilderForCase()`: becomes dead code once the `+ Quotation` button is removed (its only
  caller). Remove it, folding its logic into the new function above, rather than leaving an unused
  function behind — matches the project owner's explicit "no dead code" requirement.
- `mUploadQuote()`: unchanged as a function — it is still called from the Customer page's own
  Upload button (out of scope, kept) and from `newRevision()` (out of scope, kept). Only its
  case-page button call site (being removed) goes away; the function itself stays exactly as it is,
  including its own internal Quoted-redirect branch (lines ~2026-2027), which becomes unreachable
  dead code from the case page specifically once that page's buttons are gone but is still live for
  its other two callers — do not remove it.
- Stage/Priority `<select>` `onchange` handlers: added, toggling their sibling `Update` button's
  `disabled` attribute based on whether the current selection differs from the value the page was
  rendered with. Must handle the case where the user changes the selection back to the original
  value (re-disable), not just "any change enables, forever."
- Quotations card: gains the two hint lines described in rules 4 and 5, computed from `o.stage` and
  `d.quotes` respectively — both already available in `renderCase(d)`'s existing scope, no new data
  needed from the server.

## Testing

- jsdom tests (existing `legacy-app.test.ts` conventions): the three removed buttons are genuinely
  absent from the case page at every stage; picking Quoted + Update stage opens the Create/Upload
  choice and calls neither `api_setCaseStage` nor a quotation RPC until a further choice is made;
  saving a Draft from that flow leaves the case's rendered stage unchanged; marking that quote Sent
  flips it to Quoted, matching existing `bumpCaseToQuoted` coverage; picking Revision still reaches
  the existing holder modal unchanged; Update stage/priority buttons are disabled on load (dropdown
  matches current value) and enable/re-disable correctly as the selection changes; the Quotations
  hint text matches the case's actual stage; the Draft-count hint appears/updates correctly and
  is absent when there are no Drafts.
- Confirm by inspection (not a new test) that `mUploadQuote()`'s two remaining callers (Customer
  page, `newRevision()`) are unaffected — no behavior change to that function's body.
- Playwright: one or two real-browser tests covering the headline path (pick Quoted, choose Create,
  save Draft, confirm stage unchanged; mark Sent, confirm stage flips) — real DOM interaction is
  what proves the disabled/enabled button state and the choice-card flow actually work, which jsdom
  alone doesn't fully exercise for click-driven `disabled` toggling.

## Known risks / non-goals

- This changes a page real users are actively using (production, live data). No server/schema
  change accompanies it, so there is no migration/deploy-ordering risk like the case-lifecycle
  feature had — this can ship as a normal client-only release.
- Not addressed here, deliberately out of scope per explicit confirmation: the Customer page's
  parallel quote-creation buttons, and the quote viewer's `New revision` button. Revisit only if
  actually requested later.
