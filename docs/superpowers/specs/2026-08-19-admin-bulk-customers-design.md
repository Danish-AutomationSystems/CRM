# Admin Bulk Customer Add — Design Spec (2026-08-19)

## Context

Bulk-adding customers today lives on the Customers page as a free-text paste box: an
admin pastes tab- or comma-separated rows copied from Excel, previews the parse, then
submits. The project owner called this "very shit" and wants it replaced with a
structured, repeatable-row form, moved into the Admin panel and restricted to L6.

## Decisions

Taken during brainstorming with the project owner:

| # | Decision | Notes |
|---|---|---|
| 1 | Moves from the Customers page into Admin. | Table-paste is removed entirely, not kept as a second option. |
| 2 | Restricted to **L6** (admin-only). | A deliberate access reduction from today's L2. Confirmed explicitly — L2-L5 users lose this path and fall back to the existing search-to-create form (`mNewCustomer`) for a single named customer. |
| 3 | **Multiple structured rows, one submit.** | Not a one-at-a-time "fill, click Add, fields clear" form — the owner pivoted to this after an initial one-at-a-time design was presented. Each row has its own Name/Location/Type/Priority/Area fields; any number of rows can be filled before one "Add customers" click submits all of them together. |
| 4 | Location is **optional** per row. | Matches today's bulk behaviour (only Name is required today), not the single-customer form's mandatory-location rule. The owner chose parity with the existing tool over consistency with the rest of the app. |
| 5 | `mNewCustomer` (search-to-create, with contact/address/GSTIN) is untouched. | Different tool, different page, not in scope. |

## Architecture

### No server change

`api_bulkCustomers` / `CustomerService.bulkCustomers` already does everything this needs:
validates `name` required, `tags`/`type`/`priority` against live settings (optional, per
decision 4 — it calls `validTags`, not `requiredTags`), skips duplicate names, caps at 500
rows per call. The client sends the identical payload shape it already accepts —
`{ name, tags, type, priority, area }[]` — so this is a pure client rebuild.

### Client: repeatable rows, following the existing BOQ-block pattern

The quote builder already has a working repeatable-row pattern (`B.blocks`,
`captureBlocks()`, `qb_bt_<i>`/`qb_bx_<i>` ids) — this reuses it rather than inventing a
new one:

```js
var BC = { rows: [{}] };  // one plain object per row: {name, tags, type, priority, area}

function bcCapture(){
  BC.rows.forEach(function(r,i){
    r.name = v('bc_name_'+i);
    r.tags = pickerVal('bc_tags_'+i);
    r.type = v('bc_type_'+i);
    r.priority = v('bc_priority_'+i);
    r.area = v('bc_area_'+i);
  });
}
```

Add/remove always captures current DOM state first, mutates `BC.rows`, then re-renders —
so in-progress edits on other rows are never lost, and ids stay contiguous `0..n-1` after
every render (no gap-tracking needed).

Each row: Name input, Location (`tagPickerHTML`, multi-select, optional), Type and
Priority (`selOptions` dropdowns, sourced from `S.settings.types`/`.priorities`, already
live per the admin-config-module work), Area input, and a Remove button — hidden when
`BC.rows.length === 1`, since there must always be at least one row visible to fill.
An "+ Add another customer" button appends `{}` and re-renders.

### Submit

"Add customers" calls `bcCapture()`, then filters to rows with a non-blank `name`
(blank rows — including any accidentally left empty after removing others — are silently
dropped, matching today's "every row needs a name" behaviour). If nothing survives the
filter, toast the same message the paste tool used: *"No valid rows (every row needs a
name)."* Otherwise `gs('api_bulkCustomers', rows)`, same success toast as today
(`r.created` added, `r.skipped.length` skipped as duplicates), then reset `BC.rows` to a
single blank row and re-render — ready for the next batch without leaving the page.

### Placement

A card titled "Add customers" in `vAdmin()`, immediately after the existing "Users &
access levels" card and before the config-list cards (`configCard('Customer
locations...)` etc.) — first among the day-to-day actions, ahead of the less-frequently
touched settings lists.

### Removed

From the Customers page (`vCustomers()`): the "Bulk add" button, and the functions
`mBulkCustomers`, `parseBulkRows`, `previewBulkCust`, `saveBulkCust`, and the `BCROWS`
module-level variable.

### One incidental wording fix

The existing "Import customers from the sheet" card in Admin has a hint reading *"Tip:
for everyday use the in-app 'Bulk add' on the Customers page is faster."* That sentence
is now wrong on two counts — Bulk add no longer lives on the Customers page, and it no
longer exists in its old form at all. Update it to point at the new "Add customers" card
in Admin.

### Access control

The card renders only when `isAdmin()` (`lvl() >= 6`) is true, matching every other card
in `vAdmin()`. Server-side, `bulkCustomers` keeps `requireLevel(user, 2)` unchanged — the
RPC itself is not being locked down, only its one UI entry point moved behind the L6
client-side gate that already guards the whole Admin page. This is consistent with how
every other Admin capability in this codebase is scoped: server permission is the real
boundary, client routing decides who is offered the button.

## Testing

- A source-level check that `mBulkCustomers`, `parseBulkRows`, `previewBulkCust`,
  `saveBulkCust`, and `BCROWS` no longer appear in `Index.html`, and that the Customers
  page no longer renders a "Bulk add" button.
- `bcCapture()` preserves values already typed into other rows across an add/remove
  cycle — the specific bug the BOQ-block pattern's capture-before-mutate exists to avoid.
- Submitting with all rows blank shows the "every row needs a name" toast and does not
  call `api_bulkCustomers`.
- Submitting with a mix of named and blank rows sends only the named rows.
- A row's optional fields (Location/Type/Priority/Area) genuinely reach `api_bulkCustomers`
  unmodified — no client-side stripping or renaming versus the server's existing
  `BulkCustomerInput` shape.
- After a successful submit, the form shows exactly one blank row, not zero and not the
  previous count.
- The card is present when `isAdmin()` is true and absent otherwise — existing Admin-page
  access tests already cover this shape; extend rather than duplicate.
- Regenerated `legacy-full.generated.ts` still parses (`new Function(legacyAppScript)`
  guard) and matches source (`node scripts/port-legacy-index.mjs` produces no diff).
- Playwright: reuse the existing mocked-session admin test's approach to assert the new
  card renders with at least one row's five fields and an "Add customers" button, and
  that the Customers page no longer shows a "Bulk add" button.

## Known risks

1. **Location optional in bulk, mandatory everywhere else.** A customer added here with
   no location is invisible to any non-`*` user until someone edits it — this is
   unchanged from today's tool, not a regression, but worth stating since it's now
   sitting in Admin rather than a less-visited page.
2. **No per-row validation feedback before submit.** Unlike the old preview step, there
   is no confirmation screen — rows go straight from the form to `api_bulkCustomers` on
   click. The server still enforces everything it always did (duplicate detection, live
   settings validation); this only removes the client-side preview table, which existed
   to catch paste-parsing mistakes that a structured form makes impossible in the first
   place.
3. **500-row cap is unchanged** but a form with hundreds of rows open at once has not
   been tried in this UI; the paste tool never rendered that many DOM elements at once.
   Not addressed here — flagged as a follow-up if it proves to matter in practice.

## Explicitly out of scope

- Any change to `api_bulkCustomers` / `CustomerService.bulkCustomers` — it is reused as-is.
- Any change to `mNewCustomer`, the search-to-create single-customer form.
- Making Location mandatory in bulk (decision 4).
- A confirmation/preview step before submit (risk 2, accepted).
- Raising or removing the 500-row cap.
