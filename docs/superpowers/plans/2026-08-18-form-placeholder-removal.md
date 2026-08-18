# Form Placeholder Removal Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove every `placeholder=` attribute from the CRM client, preserving the bulk-import column guidance by moving it to a visible hint line.

**Architecture:** All 21 placeholders live in one file, `docs/source-appscript/Index.html`, which is the source of truth for the generated client. Edit that file, regenerate, and add a source-level guard so a placeholder cannot creep back in.

**Tech Stack:** Plain JS string-templated HTML in a generated legacy client, vitest, Playwright.

## Global Constraints

- **Design spec:** `docs/superpowers/specs/2026-08-18-form-placeholder-removal-design.md`. Read it first.
- **Branch:** `feat/admin-config-module`, already created. The spec is already committed on it.
- **Run everything from** `D:\AutomationSystems\CRM\migrated-crm`. Windows; use the PowerShell tool. Never work in the parent directory `D:\AutomationSystems\CRM` — that is the old Apps Script project.
- **Never hand-edit `src/app/crm/legacy-full.generated.ts`.** Edit `docs/source-appscript/Index.html` and run `node scripts/port-legacy-index.mjs`.
- **Every `placeholder=` attribute goes.** The project owner chose this explicitly, with the bulk-import risk spelled out. Do not keep one because it seems useful.
- **The bulk-import column format must survive** as a visible `.hint` line. Deleting it outright makes a paste-import map columns wrong and write bad data to every row.
- **Baseline: 426 vitest tests and 24 Playwright tests pass, zero failures.** It must stay at zero.
- Playwright needs env vars or the dev server will not boot:
  `$env:NEXT_PUBLIC_SUPABASE_URL="http://127.0.0.1:3999"; $env:NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY="dummy-key-for-e2e"; npx playwright test`
  **Never pipe Playwright through `tail` or `head`** — it masks the exit code.
- **Never commit secrets.** Do not open, read, or echo `.env.local`.

---

## File Structure

| File | Responsibility | Change |
|---|---|---|
| `docs/source-appscript/Index.html` | Legacy client source of truth | **Modify** — remove 21 attributes, add 2 hint lines |
| `src/app/crm/legacy-full.generated.ts` | Generated client | **Regenerate only** |
| `src/app/crm/legacy-app.test.ts` | Client guards | **Modify** — add the no-placeholder guard |
| `tests/e2e/crm-smoke.spec.ts` | Browser tests | **Modify only if** a test selects by placeholder |

---

### Task 1: Remove every placeholder, keep the import guidance

**Files:**
- Modify: `docs/source-appscript/Index.html` (21 sites, listed below)
- Modify: `src/app/crm/legacy-app.test.ts`
- Regenerate: `src/app/crm/legacy-full.generated.ts`

**Interfaces:**
- Produces: nothing consumed by later tasks. This task is self-contained.

- [ ] **Step 1: Write the failing guard**

Add to `src/app/crm/legacy-app.test.ts`. Read the file first and match its existing import and describe style — it already reads the generated script for other guards.

```ts
import fs from 'node:fs';
import path from 'node:path';

const indexHtml = fs.readFileSync(
  path.join(__dirname, '..', '..', '..', 'docs', 'source-appscript', 'Index.html'),
  'utf8'
);

describe('form fields carry no placeholder text', () => {
  it('has no placeholder attribute anywhere in the legacy client source', () => {
    const found = [...indexHtml.matchAll(/placeholder\s*=/gi)].map((match) => {
      const upto = indexHtml.slice(0, match.index ?? 0);
      return `line ${upto.split('\n').length}`;
    });
    expect(found, `placeholder attributes remain at: ${found.join(', ')}`).toEqual([]);
  });

  it('still tells the user the bulk-import column order', () => {
    // The placeholder that carried this was removed deliberately; the guidance
    // moved to a visible hint. Without it a pasted Excel range maps every column
    // wrong and writes bad data to every row, silently.
    expect(indexHtml).toContain('Name \u00b7 Location \u00b7 Type \u00b7 Priority \u00b7 Area');
    expect(indexHtml).toContain('Name \u00b7 Designation \u00b7 Phone \u00b7 Email');
  });
});
```

**Check the path depth before running.** `src/app/crm/legacy-app.test.ts` is three levels below the repo root, so `'..','..','..'` reaches it. Verify by reading how the file's existing code locates the generated artifact, and match that rather than trusting this snippet.

- [ ] **Step 2: Run the guard to verify it fails**

Run: `npx vitest run src/app/crm/legacy-app.test.ts`

Expected: FAIL. The first test lists 21 line numbers. The second fails too, since the hint lines do not exist yet.

- [ ] **Step 3: Remove the 20 straightforward placeholders**

In `docs/source-appscript/Index.html`, delete the `placeholder="…"` attribute (and the single space before it) at each of these lines. Line numbers are from the current file; work from the **bottom up** so earlier edits do not shift later line numbers.

| Line | Element | Placeholder text being removed |
|---|---|---|
| 1974 | `uq_title` | `e.g. VFD panel offer — rev 2` |
| 1893 | `qb_bx_<i>` | `Paste this table from Excel — first row = headers` |
| 1891 | `qb_bt_<i>` | `e.g. Main panel BOQ` |
| 1844 | `qb_sub` | `enter manually` |
| 1841 | `qb_title` | `e.g. ATV630 VFD panel — boiler feed pump` |
| 1787 | `ql_q` | `Search by name…` |
| 1779 | `ql_cname` | `Customer name` |
| 1763 | `ql_title` | `e.g. Enquiry for VFD panel` |
| 1698 | `cf_q` | `Search title / ID / customer` |
| 1660 | `w_note` | `e.g. PO no. / negotiated terms` |
| 1536 | `wk_note` | `What has been done so far, and what the next person needs to know.` |
| 1532 | `wk_q` | `type a name or username…` |
| 1458 | `stNote` | `e.g. BOQ received, costing in progress` |
| 1390 | `pc_q` | `Search customer by name…` |
| 1311 | `fo_title` | `e.g. ATV630 panel for boiler feed pumps` |
| 1221 | `f_hmail` | `username` |
| 778 | `ftext` filter input | `filter` |
| 632 | `custQ` | `Search customers by name, location, type or area…` |

That is 18 lines. Two more are handled in Steps 4 and 5.

**After each edit, keep the surrounding string concatenation valid.** These are attributes inside single-quoted JS strings; removing one must not leave a doubled space inside the tag or an unbalanced quote.

- [ ] **Step 4: Remove the outcome-note placeholder and its now-dead ternary**

Line 1675 currently reads:

```js
    '<label>Note (optional)</label><input id="o_note" placeholder="'+(outcome==='Lost'?'e.g. lost to competitor on price':'e.g. on hold pending budget')+'">',
```

The placeholder is the only consumer of that ternary. Replace the whole line with:

```js
    '<label>Note (optional)</label><input id="o_note">',
```

Do **not** leave `'+(…)+'` behind with an empty result — delete the expression. A leftover conditional inside a template string is exactly the shape that has broken the generator before.

- [ ] **Step 5: Move the two bulk-import format guides to visible hints**

Line 1062, the customer bulk-add paste box, currently:

```js
    '<textarea id="bc_paste" style="min-height:130px;font-family:var(--mono);font-size:12px;margin-top:10px" placeholder="ABC Industries\tPunjab\tOEM\tHigh\tLudhiana"></textarea>'+
```

becomes:

```js
    '<p class="hint" style="margin-top:10px;margin-bottom:4px">Columns, tab-separated: Name \u00b7 Location \u00b7 Type \u00b7 Priority \u00b7 Area</p>'+
    '<textarea id="bc_paste" style="min-height:130px;font-family:var(--mono);font-size:12px"></textarea>'+
```

Line 1269, the contact bulk-add paste box, currently:

```js
    '<textarea id="bk_paste" style="min-height:130px;font-family:var(--mono);font-size:12px;margin-top:10px" placeholder="Rajesh Kumar\tPurchase Manager\t98140xxxxx\trajesh@abc.com"></textarea>'+
```

becomes:

```js
    '<p class="hint" style="margin-top:10px;margin-bottom:4px">Columns, tab-separated: Name \u00b7 Designation \u00b7 Phone \u00b7 Email</p>'+
    '<textarea id="bk_paste" style="min-height:130px;font-family:var(--mono);font-size:12px"></textarea>'+
```

Note the `margin-top:10px` moves from the textarea to the hint, so the block spacing is unchanged.

`\u00b7` is the middle dot `·`, already used by the two import cards further down the same view — match that existing convention rather than inventing a separator.

- [ ] **Step 6: Regenerate and run the guards**

```
node scripts/port-legacy-index.mjs
npx vitest run src/app/crm/legacy-app.test.ts
```

Expected: both new tests PASS, and the file's existing guard asserting the generated script parses (`new Function(legacyAppScript)` does not throw) still passes. If that parse guard fails, an edit broke a JS string — fix it in `Index.html` and regenerate. **Never fix it in the generated file.**

- [ ] **Step 7: Check no test selects an element by placeholder**

```
grep -rn "getByPlaceholder\|placeholder" tests/ src/app/crm/*.test.ts
```

If any test locates a field by its placeholder, re-anchor it to a label, id, or role. **Do not restore a placeholder to make a test pass** — the test is asserting the wrong thing about a field that still exists.

- [ ] **Step 8: Confirm no field is left without a label**

For each of the 21 edited sites, confirm the input still has an adjacent `<label>` or an equivalent visible caption. The spec's accessibility risk is that a placeholder was some field's only description.

Two to check specifically, because they are the likeliest to have relied on their placeholder alone:
- `ftext` (line 778) — an inline column-filter input inside a table header.
- `wk_q` (line 1532) — the user-search box in the reassign modal.

If either has no visible caption, add a `<label>` rather than keeping the placeholder. Report what you found for both.

- [ ] **Step 9: Run the full gate**

```
npm test
npx tsc --noEmit
```
plus Playwright with the env vars from Global Constraints.

Expected: 426 vitest plus your 2 new tests, **zero failures**; typecheck clean; 24 Playwright passing.

- [ ] **Step 10: Commit**

```bash
git add docs/source-appscript/Index.html src/app/crm/legacy-full.generated.ts src/app/crm/legacy-app.test.ts
git commit -m "refactor(crm): remove every form placeholder

All 21 placeholder attributes removed at the owner's instruction. The two
bulk-import paste boxes kept their column format, moved from the placeholder
into a visible hint line: without it a pasted Excel range maps every column
wrong and writes bad data to every row, with nothing on screen to say so.

A source guard now asserts the client carries no placeholder attribute, and
a second asserts the import column guidance is still present, so neither can
be undone by a later tidy-up."
```

---

### Task 2: Verify in a browser

**Files:** none, unless a defect is found.

- [ ] **Step 1: Start the dev server and look at the edited forms**

```
$env:NEXT_PUBLIC_SUPABASE_URL="http://127.0.0.1:3999"
$env:NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY="dummy-key-for-e2e"
npm run dev
```

The mocked-session Playwright helpers in `tests/e2e/crm-smoke.spec.ts` show how to reach an authenticated view without real Supabase credentials; reuse that approach rather than trying to log in.

Check that every edited field still renders, is still labelled, and that no field collapsed or lost its width now that its placeholder is gone — an empty input with no placeholder can size differently in some layouts.

Specifically confirm the two bulk-add modals show the new hint line above the paste box.

- [ ] **Step 2: Report**

State which fields you checked and whether any lost its visible caption or changed size. If a defect is found, fix it in `Index.html`, regenerate, re-run the gate from Task 1 Step 9, and commit separately.

---

## Follow-ups deliberately excluded

1. Re-wording any label or `.hint` line that is not a `placeholder` attribute.
2. Any layout or styling change beyond the two hint lines this plan adds.
3. Adding placeholders back under a setting or feature flag.
