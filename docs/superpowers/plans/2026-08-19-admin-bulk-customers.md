# Admin Bulk Customer Add Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the paste-a-table bulk-add tool with a repeatable structured-row form, moved from the Customers page into the Admin panel and restricted to L6.

**Architecture:** Pure client rebuild. `api_bulkCustomers` already validates and accepts exactly the payload shape this needs, so no server code changes. The client reuses the quote builder's existing repeatable-row pattern — an array of plain row objects, a capture-before-mutate function, full re-render on add/remove — rather than inventing a new one.

**Tech Stack:** Plain JS string-templated HTML in a generated legacy client (`docs/source-appscript/Index.html` → `scripts/port-legacy-index.mjs` → `src/app/crm/legacy-full.generated.ts`), vitest, Playwright.

## Global Constraints

- **Design spec:** `docs/superpowers/specs/2026-08-19-admin-bulk-customers-design.md`. Read it first — it has the full reasoning behind every decision below.
- **Branch:** `feat/admin-bulk-customers`, already created; the spec is already committed on it (`7ee4b2d`).
- **Run everything from** `D:\AutomationSystems\CRM\migrated-crm`. Windows; use the PowerShell tool. Never work in the parent directory `D:\AutomationSystems\CRM` — that is a different, obsolete project. **Run `pwd` first every task** — this project's shell has drifted to the parent directory before.
- **No server changes.** `api_bulkCustomers` / `CustomerService.bulkCustomers` is reused exactly as it is. Do not touch `src/server/customers/service.ts`, `src/server/customers/repository.ts`, or `src/server/customers/rpc.ts`.
- **Location stays optional per row**, matching today's bulk behaviour — do not add a required-location check on this form. (This deliberately differs from the single-customer form, which does require it. That's decision 4 in the spec, not an oversight.)
- **Never hand-edit `src/app/crm/legacy-full.generated.ts`.** Edit `docs/source-appscript/Index.html`, then run `node scripts/port-legacy-index.mjs`.
- **TDD is mandatory.** Every code change is preceded by a test that is run and *seen to fail* first.
- **Never commit secrets.** Do not open, read, or echo `.env.local`.
- Playwright needs env vars or the dev server will not boot:
  `$env:NEXT_PUBLIC_SUPABASE_URL="http://127.0.0.1:3999"; $env:NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY="dummy-key-for-e2e"; npx playwright test`
  **Never pipe Playwright through `tail` or `head`** — it masks the exit code and a failing run reports as success.
- **Baseline that must not regress: check the current vitest and Playwright counts before starting** (`npm test` and the Playwright command above) and record them in your first report. This branch is cut from `main` after several other features shipped, so do not assume the counts from an earlier plan.

---

## File Structure

| File | Responsibility | Change |
|---|---|---|
| `docs/source-appscript/Index.html` | Legacy client source of truth | **Modify** — remove old bulk-add, add new card |
| `src/app/crm/legacy-full.generated.ts` | Generated client | **Regenerate only** |
| `src/app/crm/legacy-app.test.ts` | Client source-level guards | **Modify** — add guards for this change |
| `tests/e2e/crm-smoke.spec.ts` | Browser tests | **Modify** — new card test, removed-button test |

No server files change. No migration.

---

### Task 1: Remove the old bulk-add tool

Do this first and separately, so its own regeneration and guard pass cleanly before the new card is built on top.

**Files:**
- Modify: `docs/source-appscript/Index.html` — remove the "Bulk add" button from `vCustomers()`, and delete `mBulkCustomers`, `parseBulkRows`, `previewBulkCust`, `saveBulkCust`, and the `BCROWS` variable.
- Modify: `src/app/crm/legacy-app.test.ts`

**Interfaces:**
- Produces: nothing consumed by later tasks. Task 2 does not depend on any removed name still existing.

- [ ] **Step 1: Write the failing guard**

Add to `src/app/crm/legacy-app.test.ts`. Read the file first and match its existing style —
it already reads `docs/source-appscript/Index.html` for other source-level guards.

```ts
describe('the old paste-based bulk-add tool is gone', () => {
  it('has no Bulk add button on the Customers page', () => {
    expect(indexHtml).not.toContain('mBulkCustomers()');
  });

  it('has none of the old bulk-add functions', () => {
    for (const name of ['function mBulkCustomers(', 'function parseBulkRows(', 'function previewBulkCust(', 'function saveBulkCust(']) {
      expect(indexHtml, `${name} should have been removed`).not.toContain(name);
    }
  });
});
```

If `indexHtml` is not already a variable read at the top of this file, check how the
placeholder-removal guards (added on a previous branch) read the same file, and match that
exactly rather than inventing a second way to load it.

- [ ] **Step 2: Run the guard to verify it fails**

Run: `npx vitest run src/app/crm/legacy-app.test.ts`
Expected: FAIL — the button and all four functions are still present.

- [ ] **Step 3: Remove the button**

In `vCustomers()` (`docs/source-appscript/Index.html`), find:

```js
    '<button class="btn ghost" onclick="mBulkCustomers()">Bulk add</button></div>'+
```

Remove it. This line is inside the `pagehead` div's closing concatenation — check the
surrounding markup carefully so the `</div>` that was on the same line still closes the
right element after the button is gone. The line above it currently ends `...create it from
the search result.</div></div>+` (a `.grow` wrapper closing, then the pagehead div); the
`Bulk add</button></div>` piece is the pagehead's own closing div plus the button. Removing
just the button, not the div, means the line becomes:

```js
    '<div class="sub">Search first — if the customer isn\'t there, create it from the search result.</div></div></div>'+
```

Read the surrounding block yourself before editing — do not trust this snippet's exact
quoting over the real file.

- [ ] **Step 4: Delete the four functions and the module-level variable**

Delete `mBulkCustomers`, `parseBulkRows`, the `var BCROWS = [];` line, `previewBulkCust`, and
`saveBulkCust` in their entirety — from `docs/source-appscript/Index.html`. They are one
contiguous block (roughly forty lines) ending just before the `/* ===... CUSTOMER DETAIL
...=== */` comment. Confirm nothing else in the file calls any of the four function names
before deleting — `grep -n "mBulkCustomers\|parseBulkRows\|previewBulkCust\|saveBulkCust\|BCROWS"` across `Index.html` should return only the definitions themselves before your edit, and nothing after it.

- [ ] **Step 5: Regenerate and run the guards**

```
node scripts/port-legacy-index.mjs
npx vitest run src/app/crm/legacy-app.test.ts
```

Expected: the two new tests PASS. The file's existing guard asserting the generated script
parses (`new Function(legacyAppScript)` does not throw) must still pass — if it fails, an
edit broke a JS string; fix it in `Index.html` and regenerate, never in the generated file.

- [ ] **Step 6: Run the full gate**

```
npm test
npx tsc --noEmit
```

Record the resulting count against the baseline you captured in the Global Constraints.
Expected: no regressions from removing this code — nothing else in the codebase should have
referenced these four functions.

- [ ] **Step 7: Commit**

```bash
git add docs/source-appscript/Index.html src/app/crm/legacy-full.generated.ts src/app/crm/legacy-app.test.ts
git commit -m "refactor(crm): remove the paste-based bulk-add customer tool

The Bulk add button and its paste/preview/save functions are gone from
the Customers page. Replaced in the next commit by a structured
repeatable-row form in Admin. api_bulkCustomers itself is untouched -
only this one client entry point is being rebuilt."
```

---

### Task 2: The repeatable-row state and rendering

Build the row state machine and its rendering in isolation, proven against jsdom directly,
before wiring it into the Admin page in Task 3. This keeps the trickiest part — that
in-progress edits on other rows survive an add/remove — testable on its own.

**Files:**
- Modify: `docs/source-appscript/Index.html` — add `BC` state, `bcCapture`, `bcRowHTML`, `bcRenderRows`, `bcAddRow`, `bcRemoveRow`
- Modify: `src/app/crm/legacy-app.test.ts`

**Interfaces:**
- Consumes: `tagPickerHTML(id, all, selected, withStar)` (`Index.html:367`), `pickerVal(id)`
  (`:384`), `selOptions(list, sel)` (`:429`), `v(id)` and `el(id)` (existing helpers), all used
  unmodified.
- Produces, consumed by Task 3:
  ```js
  var BC = { rows: [{}] };
  function bcCapture();          // reads DOM into BC.rows, mutating in place
  function bcRowHTML(row, i);    // one row's markup, ids suffixed _<i>
  function bcRenderRows();       // sets #bc_rows innerHTML from BC.rows, calls bcCapture() first
  function bcAddRow();           // capture, push {}, re-render
  function bcRemoveRow(i);       // capture, splice(i,1), re-render (guards i===0 with length 1)
  function bcResetRows();        // BC.rows = [{}], re-render — used after a successful submit
  ```

- [ ] **Step 1: Write the failing tests**

Add to `src/app/crm/legacy-app.test.ts`, in whatever describe block already exercises the
mounted legacy app via jsdom (read the file's existing pattern for mounting and interacting
with the app before writing these — do not assume a specific harness API without checking).

```ts
describe('admin bulk-add repeatable rows', () => {
  it('starts with exactly one row', () => {
    // Navigate to Admin, as an L6 user, per this file's existing pattern for reaching
    // an authenticated admin view.
    expect(document.querySelectorAll('[id^="bc_name_"]').length).toBe(1);
  });

  it('adding a row does not lose text already typed into another row', () => {
    (document.getElementById('bc_name_0') as HTMLInputElement).value = 'Alpha Panels';
    (document.getElementById('bc_area_0') as HTMLInputElement).value = 'Ludhiana';
    (window as any).bcAddRow();
    expect((document.getElementById('bc_name_0') as HTMLInputElement).value).toBe('Alpha Panels');
    expect((document.getElementById('bc_area_0') as HTMLInputElement).value).toBe('Ludhiana');
    expect(document.querySelectorAll('[id^="bc_name_"]').length).toBe(2);
  });

  it('removing a row keeps the surviving rows contiguous and their values intact', () => {
    (document.getElementById('bc_name_0') as HTMLInputElement).value = 'Alpha';
    (window as any).bcAddRow();
    (document.getElementById('bc_name_1') as HTMLInputElement).value = 'Beta';
    (window as any).bcAddRow();
    (document.getElementById('bc_name_2') as HTMLInputElement).value = 'Gamma';
    (window as any).bcRemoveRow(1); // remove the middle row (Beta)
    expect(document.querySelectorAll('[id^="bc_name_"]').length).toBe(2);
    expect((document.getElementById('bc_name_0') as HTMLInputElement).value).toBe('Alpha');
    expect((document.getElementById('bc_name_1') as HTMLInputElement).value).toBe('Gamma');
  });

  it('does not show a remove button when there is only one row', () => {
    expect(document.querySelector('#bc_rows [data-bc-remove]')).toBeNull();
  });

  it('shows a remove button on every row once there are two or more', () => {
    (window as any).bcAddRow();
    expect(document.querySelectorAll('#bc_rows [data-bc-remove]').length).toBe(2);
  });
});
```

**Check the navigation-to-Admin mechanics against the file's existing tests before writing
the first test.** This plan cannot know the exact mount/navigate API your test harness
already uses — find an existing test that reaches an authenticated L6 view and copy its
setup verbatim, rather than guessing at a `nav('admin')` call that may not exist client-side
in the test environment.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/app/crm/legacy-app.test.ts`
Expected: FAIL — `bcAddRow` is not a function, `#bc_name_0` does not exist.

- [ ] **Step 3: Implement**

Add to `docs/source-appscript/Index.html`, near the other admin-related functions (a
sensible spot is just before `function vAdmin(){`):

```js
/* ---------------- Admin: bulk-add customers ----------------
   Repeatable rows, following the same capture-before-mutate pattern the
   quote builder's BOQ blocks already use (captureBlocks(), qb_bt_<i>): read
   the DOM back into state before any add/remove, then fully re-render with
   contiguous 0..n-1 ids. This is what stops an add/remove from silently
   discarding text already typed into another row. */
var BC = { rows: [{}] };

function bcCapture(){
  BC.rows.forEach(function(r,i){
    if(!el('bc_name_'+i)) return; // not yet rendered (e.g. right after a reset)
    r.name = v('bc_name_'+i);
    r.tags = pickerVal('bc_tags_'+i);
    r.type = v('bc_type_'+i);
    r.priority = v('bc_priority_'+i);
    r.area = v('bc_area_'+i);
  });
}

function bcRowHTML(row, i){
  row = row || {};
  var removeBtn = BC.rows.length > 1
    ? '<button type="button" class="btn ghost sm" data-bc-remove onclick="bcRemoveRow('+i+')">Remove</button>'
    : '';
  return '<div class="card" style="background:#FAFBFA;padding:12px;margin-bottom:8px">'+
    '<div class="frow"><div style="flex:2"><label class="req">Name</label><input id="bc_name_'+i+'" value="'+esc(row.name||'')+'"></div>'+
    '<div style="flex:0;display:flex;align-items:flex-end">'+removeBtn+'</div></div>'+
    '<div class="frow"><div style="flex:1"><label>Location</label>'+tagPickerHTML('bc_tags_'+i, S.settings.tags, row.tags||[], false)+'</div></div>'+
    '<div class="frow">'+
    '<div><label>Type</label><select id="bc_type_'+i+'"><option value="">—</option>'+selOptions(S.settings.types, row.type)+'</select></div>'+
    '<div><label>Priority</label><select id="bc_priority_'+i+'"><option value="">—</option>'+selOptions(S.settings.priorities, row.priority)+'</select></div>'+
    '<div><label>Area</label><input id="bc_area_'+i+'" value="'+esc(row.area||'')+'"></div>'+
    '</div></div>';
}

function bcRenderRows(){
  var body = el('bc_rows');
  if(!body) return;
  body.innerHTML = BC.rows.map(function(r,i){ return bcRowHTML(r,i); }).join('');
}

function bcAddRow(){
  bcCapture();
  BC.rows.push({});
  bcRenderRows();
}

function bcRemoveRow(i){
  if(BC.rows.length <= 1) return;
  bcCapture();
  BC.rows.splice(i,1);
  bcRenderRows();
}

function bcResetRows(){
  BC.rows = [{}];
  bcRenderRows();
}
```

Note `bcCapture` guards on `el('bc_name_'+i)` existing — this matters because `bcRenderRows`
itself does not call `bcCapture` (the callers do, before mutating), so calling
`bcRenderRows` alone never touches state; only `bcAddRow`/`bcRemoveRow` do the
capture-then-mutate sequence.

**Note:** `bcRowHTML`, `bcRenderRows`, etc. are not yet called from anywhere — nothing
renders `#bc_rows` into the page yet, so the tests above will still fail at Step 2's normal
target (no `#bc_rows` container exists in the DOM). **This task's tests genuinely require a
minimal container to mount into.** Add a temporary direct call so the functions are
reachable and testable in isolation, without wiring the full Admin card yet:

Find `function vAdmin(){` and, immediately after the existing `isAdmin()` guard, temporarily
render a bare `<div id="bc_rows"></div>` plus a call to `bcRenderRows()` after the page's
`innerHTML` is set — the minimum needed for Task 2's tests to have somewhere to mount.
**Task 3 replaces this temporary wiring with the real card**; do not spend effort making it
pretty here.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/app/crm/legacy-app.test.ts`
Expected: PASS.

- [ ] **Step 5: Regenerate and run the full gate**

```
node scripts/port-legacy-index.mjs
npm test
npx tsc --noEmit
```

- [ ] **Step 6: Commit**

```bash
git add docs/source-appscript/Index.html src/app/crm/legacy-full.generated.ts src/app/crm/legacy-app.test.ts
git commit -m "feat(crm): repeatable customer-row state for admin bulk add

Follows the quote builder's existing BOQ-block pattern: capture the DOM
into a plain-object array before any add/remove, then fully re-render
with contiguous ids, so in-progress edits on other rows are never lost.

Rendering is wired to a bare container for now; the real Admin card and
submit button are the next commit."
```

---

### Task 3: The Admin card, submit, and removing the temporary wiring

**Files:**
- Modify: `docs/source-appscript/Index.html` — replace Task 2's temporary wiring with the
  real card inside `vAdmin()`/`renderAdmin()`, add `bcSubmit()`, fix the "Import customers
  from the sheet" hint wording.
- Modify: `tests/e2e/crm-smoke.spec.ts`

**Interfaces:**
- Consumes: `BC`, `bcCapture`, `bcRenderRows`, `bcAddRow`, `bcRemoveRow`, `bcResetRows` from
  Task 2. `api_bulkCustomers` (server, unchanged) accepting
  `Array<{ name, tags, type, priority, area }>` and returning `{ created: number, skipped:
  string[] }`.
- Produces: nothing consumed by a later task. This is the last client task.

- [ ] **Step 1: Write the failing Playwright tests**

Add to `tests/e2e/crm-smoke.spec.ts`. Read the file's existing mocked-session admin tests
first (the ones this project's earlier config-module work added) and copy their session
setup and RPC-mocking approach exactly — do not build a second mocking layer.

```ts
test('the Admin page has an Add customers card with one row by default', async ({ page }) => {
  // ... reuse the existing mocked-session setup from the neighbouring admin test ...
  await page.goto('/crm/admin');
  const card = page.locator('.card', { hasText: 'Add customers' });
  await expect(card).toBeVisible();
  await expect(card.locator('[id^="bc_name_"]')).toHaveCount(1);
  await expect(card.getByRole('button', { name: 'Add another customer' })).toBeVisible();
  await expect(card.getByRole('button', { name: 'Add customers' })).toBeVisible();
});

test('the Customers page no longer has a Bulk add button', async ({ page }) => {
  // ... reuse the existing mocked-session setup ...
  await page.goto('/crm/customers');
  await expect(page.getByRole('button', { name: 'Bulk add' })).toHaveCount(0);
});

test('submitting two named rows and one blank row sends only the named rows', async ({ page }) => {
  // ... reuse the existing mocked-session setup, mocking api_bulkCustomers to capture
  // the request body and return { created: 2, skipped: [] } ...
  await page.goto('/crm/admin');
  await page.locator('#bc_name_0').fill('Alpha Panels');
  await page.getByRole('button', { name: 'Add another customer' }).click();
  await page.locator('#bc_name_1').fill('Beta Traders');
  await page.getByRole('button', { name: 'Add another customer' }).click();
  // row 2 left blank
  await page.getByRole('button', { name: 'Add customers' }).click();
  // assert the captured request body has exactly 2 rows, names 'Alpha Panels' and 'Beta Traders'
  // assert a success toast appears
  // assert the form now shows exactly 1 row again
});
```

**Fill in the actual mock-capture and assertion mechanics from the file's existing RPC-mocking
tests** — this plan states the properties to verify, not the exact Playwright API this
project's mocking helper exposes, because that must be read from the file, not guessed.

- [ ] **Step 2: Run the tests to verify they fail**

```
$env:NEXT_PUBLIC_SUPABASE_URL="http://127.0.0.1:3999"
$env:NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY="dummy-key-for-e2e"
npx playwright test -g "Add customers|Bulk add button"
```
Expected: FAIL — no "Add customers" card exists yet.

- [ ] **Step 3: Build the real card**

In `renderAdmin(users, links)`, immediately after the existing "Users & access levels" card's
closing and before the `configCard('Customer locations...` row begins, insert:

```js
  html += '<div class="card"><div class="ovl">Add customers</div>'+
    '<p class="hint" style="margin-top:-4px">Fill as many rows as you need, then add them all at once. Only Name is required.</p>'+
    '<div id="bc_rows"></div>'+
    '<div style="display:flex;gap:8px;margin-top:8px">'+
    '<button type="button" class="btn ghost sm" onclick="bcAddRow()">+ Add another customer</button>'+
    '<button type="button" class="btn" id="bcSaveBtn" onclick="bcSubmit()">Add customers</button>'+
    '</div></div>';
```

`bcRenderRows()` needs to run once the card's `#bc_rows` container actually exists in the
DOM — call it at the end of `renderAdmin`, after `el('admBody').innerHTML = html;` (or
wherever this function currently assigns the built HTML — read the function to find the
exact assignment line rather than assuming).

Remove Task 2's temporary bare-container wiring from `vAdmin()` entirely — the real card
built here replaces it.

- [ ] **Step 4: Write a jsdom-level test for `bcSubmit`'s blank-row filter, before it exists**

This is cheaper and more reliable than covering the same logic only through Playwright.
Add to `src/app/crm/legacy-app.test.ts`, in the same describe block as Task 2's tests:

```ts
it('bcSubmit drops blank rows and calls the RPC with only the named ones', () => {
  // Reuse this file's existing pattern for stubbing `gs`/the RPC transport and capturing
  // what was sent, rather than hitting a real network call.
  (document.getElementById('bc_name_0') as HTMLInputElement).value = 'Alpha Panels';
  (window as any).bcAddRow();
  // row 1 left blank
  (window as any).bcSubmit();
  // assert the captured api_bulkCustomers call received exactly one row, name 'Alpha Panels'
});

it('bcSubmit shows an error and calls no RPC when every row is blank', () => {
  (window as any).bcSubmit();
  // assert no api_bulkCustomers call was made
  // assert a toast with 'every row needs a name' appeared
});
```

**Fill in the RPC-stubbing mechanics from this file's existing tests that already stub
`gs`** — do not invent a new mocking approach.

- [ ] **Step 5: Run these two tests to verify they fail**

Run: `npx vitest run src/app/crm/legacy-app.test.ts`
Expected: FAIL — `bcSubmit` does not exist yet.

- [ ] **Step 6: Write `bcSubmit`**

```js
function bcSubmit(){
  bcCapture();
  var rows = BC.rows
    .filter(function(r){ return (r.name||'').trim(); })
    .map(function(r){
      return { name: (r.name||'').trim(), tags: r.tags||[], type: r.type||'', priority: r.priority||'', area: r.area||'' };
    });
  if(!rows.length){ toast('No valid rows (every row needs a name).', true); return; }
  el('bcSaveBtn').disabled = true;
  gs('api_bulkCustomers', rows).then(function(r){
    el('bcSaveBtn').disabled = false;
    toast(r.created+' added'+(r.skipped.length?', '+r.skipped.length+' skipped (duplicates)':'')+'.');
    bcResetRows();
  }).catch(function(e){
    el('bcSaveBtn').disabled = false;
    oops(e);
  });
}
```

There is no client-side `asText` helper in this file (that name exists only in the server
code) — use plain `.trim()` on the captured string as shown above.

- [ ] **Step 7: Run the tests again to verify they pass**

Run: `npx vitest run src/app/crm/legacy-app.test.ts`
Expected: PASS.

- [ ] **Step 8: Fix the stale hint in the "Import customers from the sheet" card**

Find:
```js
'<p class="hint">Handlers accept comma-separated emails (must be active users). Rows whose Name already exists are skipped. Processed rows are cleared. Tip: for everyday use the in-app "Bulk add" on the Customers page is faster.</p>'+
```

Change the last sentence to point at the new location:
```js
'<p class="hint">Handlers accept comma-separated emails (must be active users). Rows whose Name already exists are skipped. Processed rows are cleared. Tip: for everyday use the "Add customers" card above instead.</p>'+
```

- [ ] **Step 9: Regenerate and run the full gate**

```
node scripts/port-legacy-index.mjs
npm test
npx tsc --noEmit
npm run build
```

Then Playwright:
```
$env:NEXT_PUBLIC_SUPABASE_URL="http://127.0.0.1:3999"
$env:NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY="dummy-key-for-e2e"
npx playwright test
```
**Never pipe through `tail` or `head`.**

Expected: everything passes, including the three new Playwright tests and the guards added
in Tasks 1-2.

- [ ] **Step 10: Manual verification in a browser**

Start the dev server with the same env vars and, as an L6 user (or via the mocked session
approach used elsewhere in this project's manual-check steps):

1. Open Admin. Confirm the "Add customers" card appears, above the config-list cards, with
   one blank row.
2. Fill Name only on row 1, click "+ Add another customer" — a second blank row appears,
   row 1's value is unchanged.
3. Fill row 2's Name, Location, Type, Priority, Area. Click "Add customers".
4. Confirm a success toast, and that the form now shows exactly one blank row again.
5. Confirm both customers exist (Customers page search, or Admin → Users if a quick check is
   easier) with the fields you entered.
6. Confirm the Customers page no longer shows a "Bulk add" button.
7. Log in as (or simulate) an L2-L5 user and confirm the Admin nav item and page are not
   reachable — this should already be true from the existing `isAdmin()` gate and is not new
   behaviour, but confirm it wasn't broken by this change.

- [ ] **Step 11: Commit**

```bash
git add docs/source-appscript/Index.html src/app/crm/legacy-full.generated.ts tests/e2e/crm-smoke.spec.ts src/app/crm/legacy-app.test.ts
git commit -m "feat(admin): Add customers card with repeatable rows

Replaces the removed paste-based bulk-add. One card, any number of rows,
one submit. Blank rows are silently dropped before the call to
api_bulkCustomers, which is unchanged - this ships no server change.

Also fixes the 'Import customers from the sheet' card's hint, which
still pointed at the old Customers-page Bulk add button."
```

---

### Task 4: Gate and merge

No production database is affected by this branch — there is no migration and no schema
change — so this task is lighter than a typical deploy task in this project, but the full
local gate still runs before merging.

**Files:** none, unless a gate fails.

- [ ] **Step 1: Run the complete local gate one more time from a clean state**

```
npm run typecheck
npm test
npm run build
```
plus Playwright with the env vars from the Global Constraints.

Expected: everything green, matching or exceeding the baseline count recorded in Task 1.

- [ ] **Step 2: Merge**

```bash
git checkout main
git merge --no-ff feat/admin-bulk-customers
git push origin main
```

No migration to apply. Vercel deploys `main` automatically.

- [ ] **Step 3: Verify in production**

Repeat Task 3 Step 10's manual checks against the live site once the deploy finishes.

- [ ] **Step 4: Rollback if anything looks wrong**

`git revert` the merge commit and push. No schema change, so the revert is immediate and
complete.

---

## Follow-ups deliberately excluded

1. Making Location mandatory on this form (spec decision 4 — parity with today's tool, not
   an oversight).
2. A confirmation/preview step before submit (spec risk 2, accepted).
3. Raising or removing the 500-row cap `bulkCustomers` already enforces server-side (spec
   risk 3).
4. Any change to `mNewCustomer`, the search-to-create single-customer form — untouched,
   different page, different tool.
