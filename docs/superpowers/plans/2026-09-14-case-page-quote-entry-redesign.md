# Case Page Quote-Entry Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the case page's three redundant, confusing action buttons (`Request revision`,
`+ Quotation`, `Upload quotation`) with a single entry point — the Stage card's dropdown + Update
stage button — while closing a real gap where a case can currently reach Quoted with zero
quotations ever created.

**Architecture:** Client-only change to the legacy generated UI (`docs/source-appscript/Index.html`,
regenerated into `src/app/crm/legacy-full.generated.ts`). No server change — every rule this depends
on (Quoted-stage quote-creation rejection, auto-bump-to-Quoted-on-Sent) already exists and ships.

**Tech Stack:** Legacy Apps Script-ported client, TypeScript/Vitest/jsdom for unit-level UI tests,
Playwright for real-browser coverage.

## Global Constraints

- Never hand-edit `src/app/crm/legacy-full.generated.ts`. Edit `docs/source-appscript/Index.html`,
  then regenerate with `node scripts/port-legacy-index.mjs`.
- No new CSS. Reuse existing classes (`btn`, `btn ghost`, `hint`, `frow`, etc.) already in the file.
- No server change. If a task's implementer finds they need one, stop and report it rather than
  making it — this plan was designed specifically to avoid that.
- The Customer detail page's own `+ Quotation`/`Upload quotation` buttons and the quote viewer's
  `New revision` button are explicitly OUT OF SCOPE — confirmed with the project owner, do not touch
  them.
- No admin override anywhere for reaching Quoted without a real quotation — confirmed, do not add one.
- Design reference: `docs/superpowers/specs/2026-09-14-case-page-quote-entry-redesign-design.md`.
- Run `npm test` and `npm run typecheck` after every task; both must be clean before moving on.

---

## Task 1: Disabled-until-changed Update stage / Update priority buttons

**Files:**
- Modify: `docs/source-appscript/Index.html` (`renderCase`, lines ~1459-1467 as of this plan)
- Modify: `src/app/crm/legacy-full.generated.ts` (regenerated)
- Test: `src/app/crm/legacy-app.test.ts`

**Interfaces:**
- Produces: `toggleStageBtn()`, `togglePriBtn()` — no return value, mutate `#stUpdateBtn`/
  `#priUpdateBtn`'s `disabled` property. Not consumed by later tasks, but the two button `id`s
  (`stUpdateBtn`, `priUpdateBtn`) and the fact both start `disabled` on render are relied on by
  Task 2's and Task 3's tests (they assert the buttons exist with these ids).

- [ ] **Step 1: Write the failing tests**

Open `src/app/crm/legacy-app.test.ts`. Inside the existing `describe('case lifecycle UI', ...)` block
(it starts around line 2272 and already has the `stage`/`mapped`/`role` fixture state and the `rpc()`
mock this test needs — do not build a new harness), add two new tests. A good place is right after
the last existing test in that block, before its closing `});`.

```typescript
  test('Update stage button starts disabled and enables only when the selection differs from the current stage', async () => {
    stage = 'Opportunity';
    await startCase();

    const btn = screen.getByRole('button', { name: 'Update stage' });
    expect(btn).toBeDisabled();

    const select = document.getElementById('stSel') as HTMLSelectElement;
    select.value = 'Lead';
    window.eval(select.getAttribute('onchange') ?? '');
    expect(btn).not.toBeDisabled();

    select.value = 'Opportunity';
    window.eval(select.getAttribute('onchange') ?? '');
    expect(btn).toBeDisabled();
  });

  test('Update priority button follows the same disabled-until-changed rule', async () => {
    stage = 'Opportunity';
    await startCase();

    const btn = screen.getByRole('button', { name: 'Update priority' });
    expect(btn).toBeDisabled();

    const select = document.getElementById('priSel') as HTMLSelectElement;
    select.value = 'High';
    window.eval(select.getAttribute('onchange') ?? '');
    expect(btn).not.toBeDisabled();

    select.value = '';
    window.eval(select.getAttribute('onchange') ?? '');
    expect(btn).toBeDisabled();
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node node_modules/vitest/vitest.mjs run src/app/crm/legacy-app.test.ts -t 'disabled'`
Expected: FAIL — `Update stage`/`Update priority` buttons don't have the `disabled` property set, or
`select.getAttribute('onchange')` returns null (no such handler exists yet).

- [ ] **Step 3: Implement**

In `docs/source-appscript/Index.html`, find this block inside `renderCase` (search for
`<label>Stage</label>`):

```js
      if(o.outcome!=='Won' && o.outcome!=='Lost'){
        html += '<div class="frow" style="align-items:flex-end"><div><label>Stage</label><select id="stSel">'+
          S.settings.stages.filter(function(st){ return st!=='Revision' || o.stage==='Quoted' || o.stage==='Revision'; })
            .map(function(st){ return '<option'+(st===o.stage?' selected':'')+'>'+esc(st)+'</option>'; }).join('')+'</select></div>'+
          '<div style="flex:2"><label>Note (optional)</label><input id="stNote"></div>'+
          '<div style="flex:0"><button class="btn" onclick="doStage(\''+esc(o.id)+'\')">Update stage</button></div></div>';
      }
      html += '<div class="frow" style="align-items:flex-end"><div><label>Priority</label><select id="priSel">'+
        '<option value="">— none —</option>'+ selOptions(S.settings.priorities || ['High','Medium','Low'], o.priority||'') +
        '</select></div><div style="flex:0"><button class="btn" onclick="doPriority(\''+esc(o.id)+'\')">Update priority</button></div></div>';
```

Replace it with (adds `onchange`, `id`, and a starting `disabled` on each button):

```js
      if(o.outcome!=='Won' && o.outcome!=='Lost'){
        html += '<div class="frow" style="align-items:flex-end"><div><label>Stage</label><select id="stSel" onchange="toggleStageBtn()">'+
          S.settings.stages.filter(function(st){ return st!=='Revision' || o.stage==='Quoted' || o.stage==='Revision'; })
            .map(function(st){ return '<option'+(st===o.stage?' selected':'')+'>'+esc(st)+'</option>'; }).join('')+'</select></div>'+
          '<div style="flex:2"><label>Note (optional)</label><input id="stNote"></div>'+
          '<div style="flex:0"><button class="btn" id="stUpdateBtn" disabled onclick="doStage(\''+esc(o.id)+'\')">Update stage</button></div></div>';
      }
      html += '<div class="frow" style="align-items:flex-end"><div><label>Priority</label><select id="priSel" onchange="togglePriBtn()">'+
        '<option value="">— none —</option>'+ selOptions(S.settings.priorities || ['High','Medium','Low'], o.priority||'') +
        '</select></div><div style="flex:0"><button class="btn" id="priUpdateBtn" disabled onclick="doPriority(\''+esc(o.id)+'\')">Update priority</button></div></div>';
```

Then, right after `renderCase`'s closing `}` (find `function doStage(id){` — add the two new
functions immediately before it):

```js
function toggleStageBtn(){ var b=el('stUpdateBtn'); if(b) b.disabled = (v('stSel')===CUR.caseData.case.stage); }
function togglePriBtn(){ var b=el('priUpdateBtn'); if(b) b.disabled = (v('priSel')===(CUR.caseData.case.priority||'')); }
```

- [ ] **Step 4: Regenerate**

Run: `node scripts/port-legacy-index.mjs`

- [ ] **Step 5: Run tests to verify they pass**

Run: `node node_modules/vitest/vitest.mjs run src/app/crm/legacy-app.test.ts -t 'disabled'`
Expected: PASS, both new tests green.

- [ ] **Step 6: Run the full suite and typecheck**

Run: `npm test` and `npm run typecheck`
Expected: both clean, no regressions in any other test in the file (the `disabled` attribute change
does not affect any existing test's assertions, since none of them currently check this button's
disabled state).

- [ ] **Step 7: Commit**

```bash
git add docs/source-appscript/Index.html src/app/crm/legacy-full.generated.ts src/app/crm/legacy-app.test.ts
git commit -m "feat: disable Update stage/priority until the dropdown actually changes"
```

---

## Task 2: Remove the three case-page buttons; single Quoted entry point

**Files:**
- Modify: `docs/source-appscript/Index.html`
- Modify: `src/app/crm/legacy-full.generated.ts` (regenerated)
- Test: `src/app/crm/legacy-app.test.ts`

**Interfaces:**
- Consumes: `caseCanQuote(d)`, `caseQuoteContext(d)`, `withQuoteCustomer(ctx, next)`, `mQuoteBuilder`,
  `mUploadQuote(base, context)` — all pre-existing, unchanged. `stUpdateBtn`/`toggleStageBtn` from
  Task 1 (this task's `doStage` edit sits right next to Task 1's, same function).
- Produces: `mAddQuotationForCase()` — no arguments, no return value. Opens the Create/Upload choice
  modal. Not consumed by any later task in this plan, but is the function Task 3's Draft-hint link
  text points at conceptually (Task 3 does not call it directly, just says "see Quotations below").

- [ ] **Step 1: Extend the shared `rpc()` mock, then write the failing tests**

The block's shared `rpc()` function (used by every test in `describe('case lifecycle UI', ...)`,
not just this task's) currently has no `api_setQuoteStatus` branch at all, and its
`api_createQuotation || api_uploadQuotation` branch never changes `stage` — it only sets
`mapped = true`. That's sufficient for the Draft-path test below (stage staying put is the whole
point), but it means nothing in this describe block can currently prove a quote reaching Sent status
actually flips the case to Quoted — a real gap, not an oversight to leave in place, since this
plan's own Task 2 Step 1 test #4 needs to prove exactly that.

Find:

```typescript
    if (fn === 'api_createQuotation' || fn === 'api_uploadQuotation') { mapped = true; return { quoteNo: 'Q-1', rev: 0 }; }
```

Replace with:

```typescript
    if (fn === 'api_createQuotation') { mapped = true; return { quoteNo: 'Q-1', rev: 0 }; }
    if (fn === 'api_uploadQuotation') {
      mapped = true;
      const payload = args[0] as { status?: string };
      if (payload.status === 'Sent') stage = 'Quoted';
      return { quoteNo: 'Q-1', rev: 0 };
    }
    if (fn === 'api_setQuoteStatus') {
      if (args[2] === 'Sent') stage = 'Quoted';
      return { ok: true };
    }
```

(`api_createQuotation` never carries a status — the generate/Save-quotation path always creates a
Draft, matching `mQuoteBuilder`'s real single-button form; only `api_uploadQuotation`'s payload and
the separate `api_setQuoteStatus` call can move a quote to Sent, matching the real client.)

Now add these to the same `describe('case lifecycle UI', ...)` block, after Task 1's two tests.

```typescript
  test('the three old case-page buttons are gone at every stage', async () => {
    for (const s of ['Lead', 'Opportunity', 'Quoted', 'Revision']) {
      stage = s;
      await startCase();
      expect(screen.queryByRole('button', { name: 'Request revision' })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: '+ Quotation' })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Upload quotation' })).not.toBeInTheDocument();
      cleanup();
      document.body.innerHTML = '';
    }
  });

  test('picking Quoted and Update stage opens a Create/Upload choice instead of calling api_setCaseStage', async () => {
    stage = 'Opportunity';
    await startCase();

    const select = document.getElementById('stSel') as HTMLSelectElement;
    select.value = 'Quoted';
    window.eval(select.getAttribute('onchange') ?? '');
    press('Update stage');

    await screen.findByRole('button', { name: 'Create a new quotation' });
    expect(screen.getByRole('button', { name: 'Upload an existing one' })).toBeInTheDocument();
    expect(calls.filter((c) => c.fn === 'api_setCaseStage')).toHaveLength(0);
  });

  test('choosing Create opens the quote builder and saving as Draft does not change the case stage', async () => {
    stage = 'Opportunity';
    await startCase();

    const select = document.getElementById('stSel') as HTMLSelectElement;
    select.value = 'Quoted';
    window.eval(select.getAttribute('onchange') ?? '');
    press('Update stage');
    await screen.findByRole('button', { name: 'Create a new quotation' });
    press('Create a new quotation');

    await screen.findByRole('heading', { name: 'New quotation' });
    set('qb_title', 'Panel quotation');
    set('qb_tpl', 'TPL-1');
    set('qb_sub', '100');
    set('qb_bx_0', 'Item\nPanel');
    press('Save quotation');

    await waitFor(() => expect(calls.some((c) => c.fn === 'api_createQuotation')).toBe(true));
    expect(calls.filter((c) => c.fn === 'api_setCaseStage' && c.args[1] === 'Quoted')).toHaveLength(0);
    expect(stage).toBe('Opportunity');
  });

  test('choosing Upload and picking Sent status commits the case to Quoted', async () => {
    stage = 'Opportunity';
    await startCase();

    const select = document.getElementById('stSel') as HTMLSelectElement;
    select.value = 'Quoted';
    window.eval(select.getAttribute('onchange') ?? '');
    press('Update stage');
    await screen.findByRole('button', { name: 'Upload an existing one' });
    press('Upload an existing one');

    await waitFor(() => expect(document.getElementById('uq_file')).not.toBeNull());
    set('uq_title', 'Panel quotation');
    set('uq_total', '118');
    Object.defineProperty(document.getElementById('uq_file'), 'files', {
      value: [new File(['quote'], 'quote.pdf', { type: 'application/pdf' })]
    });
    press('Upload quotation', document.getElementById('mfoot')!);

    await waitFor(() => expect(calls.some((c) => c.fn === 'api_uploadQuotation')).toBe(true));
    const uploadCall = calls.find((c) => c.fn === 'api_uploadQuotation');
    expect(uploadCall?.args[0]).toMatchObject({ caseId: 'CASE-1', status: 'Sent' });
    expect(stage).toBe('Quoted');
  });

  test('choosing Create, saving as Draft, then marking that quote Sent from the viewer commits the case to Quoted', async () => {
    stage = 'Opportunity';
    await startCase();

    const select = document.getElementById('stSel') as HTMLSelectElement;
    select.value = 'Quoted';
    window.eval(select.getAttribute('onchange') ?? '');
    press('Update stage');
    await screen.findByRole('button', { name: 'Create a new quotation' });
    press('Create a new quotation');
    await screen.findByRole('heading', { name: 'New quotation' });
    set('qb_title', 'Panel quotation');
    set('qb_tpl', 'TPL-1');
    set('qb_sub', '100');
    set('qb_bx_0', 'Item\nPanel');
    press('Save quotation');

    await screen.findByRole('button', { name: 'Mark Sent' });
    expect(stage).toBe('Opportunity');
    press('Mark Sent');

    await waitFor(() => expect(calls.some((c) => c.fn === 'api_setQuoteStatus')).toBe(true));
    expect(stage).toBe('Quoted');
  });

  test('the Quotations card explains where to add a quotation, worded for the case\'s current stage', async () => {
    stage = 'Opportunity';
    await startCase();
    expect(document.getElementById('main')?.textContent).toContain('set the stage to Quoted above');

    cleanup();
    document.body.innerHTML = '';
    stage = 'Quoted';
    await startCase();
    expect(document.getElementById('main')?.textContent).toContain('request a revision above');
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node node_modules/vitest/vitest.mjs run src/app/crm/legacy-app.test.ts -t 'case lifecycle UI'`
Expected: FAIL. The first new test fails because `+ Quotation`/`Upload quotation`/`Request revision`
still render. The others fail because `mAddQuotationForCase` doesn't exist yet and the hint text
isn't in the Quotations card.

- [ ] **Step 3: Remove the three buttons**

In `docs/source-appscript/Index.html`, find (inside `renderCase`, right after the owners/assigned-to
line):

```js
    if(d.canRequestRevision && o.stage==='Quoted' && !o.outcome) html += '<button class="btn ghost" onclick="mRequestRevision()">Request revision</button>';
    if(d.canEdit) html += '<button class="btn ghost" onclick="mEditCase(CUR.caseData.case)">Edit</button>';
    if(caseCanQuote(d) && !o.outcome) html += '<button class="btn ghost" onclick="openBuilderForCase()">+ Quotation</button>'+
      '<button class="btn ghost" onclick="mUploadQuote()">Upload quotation</button>';
    html += '</div>';
```

Replace with:

```js
    if(d.canEdit) html += '<button class="btn ghost" onclick="mEditCase(CUR.caseData.case)">Edit</button>';
    html += '</div>';
```

- [ ] **Step 4: Add the Quotations-card discoverability hint**

Find (inside `renderCase`, the Quotations card opening):

```js
    html += '<div class="card"><div class="ovl">Quotations</div>';
    if(!(d.quotes||[]).length) html += '<div class="empty">No quotations yet for this case.</div>';
```

Replace with:

```js
    html += '<div class="card"><div class="ovl">Quotations</div>'+
      '<p class="hint" style="margin-top:0">'+(o.stage==='Quoted'?'To add a new quotation, request a revision above.':'To add a quotation, set the stage to Quoted above.')+'</p>';
    if(!(d.quotes||[]).length) html += '<div class="empty">No quotations yet for this case.</div>';
```

- [ ] **Step 5: Wire the new "Quoted" trigger into `doStage`, and add `mAddQuotationForCase`**

Find:

```js
function doStage(id){
  var stage=v('stSel'), d=CUR.caseData;
  if(stage===d.case.stage) return;
  if(stage==='Revision' && d.case.stage==='Quoted'){ mRequestRevision(null,d,v('stNote')); return; }
  gs('api_setCaseStage', id, stage, v('stNote')).then(function(){
```

Replace with:

```js
function doStage(id){
  var stage=v('stSel'), d=CUR.caseData;
  if(stage===d.case.stage) return;
  if(stage==='Revision' && d.case.stage==='Quoted'){ mRequestRevision(null,d,v('stNote')); return; }
  if(stage==='Quoted'){ mAddQuotationForCase(); return; }
  gs('api_setCaseStage', id, stage, v('stNote')).then(function(){
```

Then, immediately after `doStage`'s closing `}` (before `function doPriority`), add:

```js
function mAddQuotationForCase(){
  var d=CUR.caseData; if(!caseCanQuote(d)) return;
  openModal('Add a quotation',
    '<p class="hint" style="margin-top:0">This case doesn\'t have a sent quotation yet. Choose how to add one.</p>'+
    '<div style="display:flex;gap:8px;flex-wrap:wrap">'+
    '<button class="btn" onclick="closeModal();withQuoteCustomer(caseQuoteContext(CUR.caseData),mQuoteBuilder)">Create a new quotation</button>'+
    '<button class="btn ghost" onclick="closeModal();mUploadQuote(undefined,caseQuoteContext(CUR.caseData))">Upload an existing one</button>'+
    '</div>',
    '<button class="btn ghost" onclick="closeModal()">Cancel</button>');
}
```

- [ ] **Step 6: Remove `openBuilderForCase` — dead code once its only caller is gone**

Find and delete this whole function (its only caller was the now-removed `+ Quotation` button):

```js
function openBuilderForCase(){
  var d=CUR.caseData; if(!caseCanQuote(d)) return;
  var next=function(){ withQuoteCustomer(caseQuoteContext(d),mQuoteBuilder); };
  if(d.case.stage==='Quoted'){ mRequestRevision(next,d); return; }
  next();
}
```

Do NOT touch `mUploadQuote` itself — it is still called by the Customer page's own Upload button and
by `newRevision()` (both out of scope for this plan). Only its case-page button call site was removed
in Step 3; the function body stays exactly as it is.

- [ ] **Step 7: Regenerate**

Run: `node scripts/port-legacy-index.mjs`

- [ ] **Step 8: Run tests to verify they pass**

Run: `node node_modules/vitest/vitest.mjs run src/app/crm/legacy-app.test.ts -t 'case lifecycle UI'`
Expected: PASS, all tests in the block green, including Task 1's.

- [ ] **Step 9: Run the full suite and typecheck**

Run: `npm test` and `npm run typecheck`
Expected: both clean. Pay particular attention to any pre-existing test that referenced
`openBuilderForCase`, `+ Quotation`, `Upload quotation`, or `Request revision` by name elsewhere in
the file or in `tests/e2e/crm-smoke.spec.ts` (search both files for these strings before assuming
none exist) — such a test needs updating in this same task, not left broken.

- [ ] **Step 10: Commit**

```bash
git add docs/source-appscript/Index.html src/app/crm/legacy-full.generated.ts src/app/crm/legacy-app.test.ts
git commit -m "feat: single Quoted entry point replaces the three case-page quote buttons"
```

---

## Task 3: Draft-quote hint in the Stage card

**Files:**
- Modify: `docs/source-appscript/Index.html`
- Modify: `src/app/crm/legacy-full.generated.ts` (regenerated)
- Test: `src/app/crm/legacy-app.test.ts`

**Interfaces:**
- Consumes: `d.quotes` (array of `{ quoteNo, rev, status, ... }`, already present in `renderCase`'s
  scope, unchanged shape), `o.stage`.
- Produces: nothing consumed by later tasks — this is the last content change in the plan.

- [ ] **Step 1: Write the failing tests**

Add to the same `describe('case lifecycle UI', ...)` block:

```typescript
  test('the Stage card shows a Draft-quote hint when the case has unsent quotations', async () => {
    stage = 'Opportunity';
    await startCase();
    expect(document.getElementById('main')?.textContent).not.toContain('still Draft');
  });

  test('the Draft-quote hint names the count and does not pick one quote arbitrarily', async () => {
    mockRpc((fn) => {
      if (fn === 'api_workspace') {
        const w = workspace('L6');
        w.boot.settings.stages.push('Revision');
        w.cases = [];
        return w;
      }
      if (fn === 'api_getCase') {
        return {
          ...caseDetail([{ name: 'Original Owner', email: 'owner@automationsystems.org', source: 'creator' }]),
          canQuote: true,
          canRequestRevision: false,
          quotes: [
            { quoteNo: 'Q-1', rev: 0, status: 'Draft', title: 'A', date: '2026-09-14', by: 'sales@automationsystems.org', currency: 'INR', total: 100 },
            { quoteNo: 'Q-2', rev: 0, status: 'Draft', title: 'B', date: '2026-09-14', by: 'sales@automationsystems.org', currency: 'INR', total: 200 },
            { quoteNo: 'Q-3', rev: 0, status: 'Sent', title: 'C', date: '2026-09-14', by: 'sales@automationsystems.org', currency: 'INR', total: 300 }
          ]
        };
      }
      throw new Error(`Unexpected RPC ${fn}`);
    });
    render(createElement(CrmApp));
    await screen.findByRole('heading', { name: 'Overview' });
    window.eval('nav("case", "CASE-1")');
    await screen.findByRole('heading', { name: 'Panel upgrade' });

    expect(document.getElementById('main')?.textContent).toContain('2 quotations are still Draft');
    expect(document.getElementById('main')?.textContent).not.toContain('1 quotation');
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node node_modules/vitest/vitest.mjs run src/app/crm/legacy-app.test.ts -t 'Draft-quote'`
Expected: the first test passes trivially (nothing to assert failing on absence — this is fine, it's
a regression guard for the no-drafts case, not a RED/GREEN pair). The second test FAILS: the text
"2 quotations are still Draft" is not present anywhere in `#main`.

- [ ] **Step 3: Implement**

In `docs/source-appscript/Index.html`, find (inside `renderCase`, right where the Status card's
outcome-specific paragraphs end and the Stage `<select>` block begins — search for
`if(d.canEdit){` right before `if(o.outcome!=='Won' && o.outcome!=='Lost'){`):

```js
    if(d.canEdit){
      if(o.outcome!=='Won' && o.outcome!=='Lost'){
        html += '<div class="frow" style="align-items:flex-end"><div><label>Stage</label><select id="stSel" onchange="toggleStageBtn()">'+
```

Replace with (adds the Draft-count hint immediately before the Stage row, only inside the same
`o.outcome!=='Won' && o.outcome!=='Lost'` guard so it never shows on a closed case):

```js
    if(d.canEdit){
      if(o.outcome!=='Won' && o.outcome!=='Lost'){
        var draftCount = (d.quotes||[]).filter(function(q){ return q.status==='Draft'; }).length;
        if(draftCount) html += '<p class="hint" style="margin-top:0">'+draftCount+' quotation'+(draftCount===1?' is':'s are')+' still Draft — see Quotations below.</p>';
        html += '<div class="frow" style="align-items:flex-end"><div><label>Stage</label><select id="stSel" onchange="toggleStageBtn()">'+
```

- [ ] **Step 4: Regenerate**

Run: `node scripts/port-legacy-index.mjs`

- [ ] **Step 5: Run tests to verify they pass**

Run: `node node_modules/vitest/vitest.mjs run src/app/crm/legacy-app.test.ts -t 'Draft-quote'`
Expected: PASS.

- [ ] **Step 6: Run the full suite and typecheck**

Run: `npm test` and `npm run typecheck`
Expected: both clean.

- [ ] **Step 7: Commit**

```bash
git add docs/source-appscript/Index.html src/app/crm/legacy-full.generated.ts src/app/crm/legacy-app.test.ts
git commit -m "feat: show a Draft-quote count hint in the Stage card"
```

---

## Task 4: Playwright coverage and full gate

**Files:**
- Modify: `tests/e2e/crm-smoke.spec.ts`

**Interfaces:** none — verification only, no new production code.

- [ ] **Step 1: Write the failing Playwright tests**

Open `tests/e2e/crm-smoke.spec.ts`. Read its existing `case aging`/`case lifecycle` tests (search for
`a Quoted case has no ticket holder`) to match its harness conventions (`rpcData`, session setup)
exactly — do not build a new one. Add two tests near them:

```typescript
test('an Opportunity case has no old quote buttons; picking Quoted opens the Create/Upload choice', async ({ context, page }) => {
  await setUpAuthenticatedSession(context, page);
  await page.goto('/crm/case/CASE-2026-0002');
  await expect(page.getByRole('heading', { name: /./ })).toBeVisible();

  await expect(page.getByRole('button', { name: 'Request revision' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '+ Quotation' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Upload quotation' })).toHaveCount(0);

  const updateStage = page.getByRole('button', { name: 'Update stage' });
  await expect(updateStage).toBeDisabled();

  await page.getByLabel('Stage').selectOption('Quoted');
  await expect(updateStage).toBeEnabled();
  await updateStage.click();

  await expect(page.getByRole('button', { name: 'Create a new quotation' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Upload an existing one' })).toBeVisible();
});

test('Update priority stays disabled until the priority dropdown actually changes', async ({ context, page }) => {
  await setUpAuthenticatedSession(context, page);
  await page.goto('/crm/case/CASE-2026-0002');
  await expect(page.getByRole('heading', { name: /./ })).toBeVisible();

  const updatePriority = page.getByRole('button', { name: 'Update priority' });
  await expect(updatePriority).toBeDisabled();
  await page.getByLabel('Priority').selectOption('High');
  await expect(updatePriority).toBeEnabled();
});
```

Adjust the exact route/case id and any RPC-mocking setup this file's existing tests use for a
Lead/Opportunity fixture case (read the file first — do not guess a fixture that doesn't exist; reuse
whatever case fixture an existing nearby test already relies on rather than inventing a new
`CASE-2026-0002`).

- [ ] **Step 2: Run to verify they fail naturally, or via mutation if they pass immediately**

Since this is a real-browser run against already-implemented (Tasks 1-3) code, these tests may pass
on the first run. If so, temporarily re-introduce one of the old buttons in
`docs/source-appscript/Index.html`, regenerate, confirm the corresponding assertion fails, then
restore the file exactly (edit back, not `git checkout`) and regenerate again, confirming clean.
Record the mutation and restoration in your report.

Use the pre-warm procedure for this codebase's Playwright runs: start `npm run dev` in the
background, `curl` the `/crm` route once to force compilation, then run the suite against the warm
server — a cold first request can exceed the default timeout and fail an unrelated test.

- [ ] **Step 3: Run the full Playwright suite**

Run: `npx playwright test`
Expected: every test passes, including the two new ones.

- [ ] **Step 4: Full unit/integration suite and typecheck one more time**

Run: `npm test` and `npm run typecheck`
Expected: both clean.

- [ ] **Step 5: Regeneration is up to date**

Run: `node scripts/port-legacy-index.mjs && git status --short`
Expected: no diff — proves the last commit's generated file already matches what the generator
produces from the final source.

- [ ] **Step 6: Commit**

```bash
git add tests/e2e/crm-smoke.spec.ts
git commit -m "test(e2e): cover the case-page quote-entry redesign in a real browser"
```

- [ ] **Step 7: Report, do not merge**

Report final numbers (unit suite, Playwright, typecheck) and stop. Merge to `main` only on the
project owner's explicit go-ahead.
