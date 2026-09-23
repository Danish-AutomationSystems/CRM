# Location Rules — Client UI Implementation Plan (Track C)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The client matches the rules the server now enforces — a customer picks exactly one location, the `*` wildcard is gone from every screen, and removing a location a user still handles customers in opens a card that reassigns them.

**Architecture:** The CRM client is a single legacy page, `docs/source-appscript/Index.html`. `src/app/crm/legacy-full.generated.ts` is GENERATED from it by `scripts/port-legacy-index.mjs` — always edit the HTML and regenerate, never hand-edit the generated file. Tests render the real client with `@testing-library/react` in `src/app/crm/legacy-app.test.ts` and stub RPCs.

**Tech Stack:** Legacy vanilla-JS client embedded in Next.js, Vitest + @testing-library/react.

Spec: `docs/superpowers/specs/2026-09-23-ownership-and-location-rules-design.md`
Server contract landed in: `7afe1e3` (P5), `32dceb9` (P6), `b60a8a3` (P7).

## Global Constraints

- **TDD is mandatory.** Write the test, run it, watch it fail for the right reason, then implement. Never weaken a test to make it green.
- Edit `docs/source-appscript/Index.html`, then run `node scripts/port-legacy-index.mjs` to regenerate. **Never hand-edit `src/app/crm/legacy-full.generated.ts`.** A reviewer will re-run the generator and diff it.
- The full suite must stay green. Baseline at the start of this plan: **816 passing**.
- The server is the authority. The UI must never be the only thing preventing an invalid state — every rule here is already enforced server-side, and the UI exists to make the rule obvious rather than to enforce it.
- Run `npx tsc --noEmit -p tsconfig.json` before every commit. Do not push.

---

### Task 1: Location pickers match the new rules

**Files:**
- Modify: `docs/source-appscript/Index.html`
- Modify: `src/app/crm/legacy-full.generated.ts` (by regeneration only)
- Modify: `src/app/crm/legacy-app.test.ts`

**What is wrong today**
- `tagPickerHTML(id, all, selected, withStar)` (~line 408) renders an **"All tags (*)"** button when `withStar` is set. The server now rejects `'*'` outright, so that button produces a guaranteed error.
- The admin users table (~line 2252) renders `All (*)` as a chip for a value that can no longer exist.
- The customer form's location picker is multi-select, and its validation message (~line 1045) says *"Location is required — pick at least one."* A customer now holds exactly one.

- [ ] **Step 1: Write the failing tests**

Add to `src/app/crm/legacy-app.test.ts`, matching the file's existing style (read it first — it uses `mockRpc`, `render(createElement(CrmApp))`, `press()`, `set()`, `screen`):

```typescript
test('the user location picker no longer offers the wildcard', async () => {
  mockRpc(rpc); render(createElement(CrmApp));
  await screen.findByRole('heading', { name: 'Overview' });
  window.eval('nav("admin")');
  await waitFor(() => expect(document.getElementById('main')?.textContent).toContain('Users'));
  press('Edit');
  await waitFor(() => expect(document.getElementById('au_tags')).not.toBeNull());
  expect(document.getElementById('au_tags')?.textContent).not.toContain('All tags');
  expect(document.querySelector('#au_tags [data-t="*"]')).toBeNull();
});

test('a customer keeps only the last location picked', async () => {
  mockRpc(rpc); render(createElement(CrmApp));
  await screen.findByRole('heading', { name: 'Overview' });
  window.eval('nav("customers")'); press('+ New customer');
  await waitFor(() => expect(document.getElementById('fc_tags')).not.toBeNull());
  const picker = document.getElementById('fc_tags') as HTMLElement;
  (picker.querySelector('[data-t="Punjab"]') as HTMLElement).click();
  (picker.querySelector('[data-t="NCR"]') as HTMLElement).click();
  expect(picker.querySelectorAll('.on').length).toBe(1);
  expect((picker.querySelector('.on') as HTMLElement).getAttribute('data-t')).toBe('NCR');
});
```

The customer form's picker element id may not be `fc_tags` — read the customer modal in `Index.html` and use the real id. Adjust the admin navigation steps to match how the existing admin tests reach that screen.

- [ ] **Step 2: Run them and watch them fail**

Run: `npx vitest run src/app/crm/legacy-app.test.ts`
Expected: the wildcard test FAILS (the button is rendered), and the single-location test FAILS (both stay selected).

- [ ] **Step 3: Remove the wildcard from the client**

In `Index.html`: delete the `withStar` parameter and the `All tags (*)` button from `tagPickerHTML`, and every call site that passes it. Replace the users-table cell (~line 2252) so it always renders `tagChips(u.allowedTags)` with no wildcard branch.

- [ ] **Step 4: Make the customer picker single-select**

Give `tagPickerHTML` a single-select mode used by the customer form, where choosing a location deselects the previous one. Users keep multi-select. `tgTag(this)` is the shared toggle — either give it a mode or add a sibling function; keep the change small and obvious.

Update the customer-form validation message (~line 1045) from *"pick at least one"* to wording that states the rule, e.g. `Location is required — pick one.`

- [ ] **Step 5: Run and watch them pass, then regenerate**

```bash
npx vitest run src/app/crm/legacy-app.test.ts
node scripts/port-legacy-index.mjs
```

- [ ] **Step 6: Full suite, type check, commit**

```bash
npx vitest run
npx tsc --noEmit -p tsconfig.json
git add docs/source-appscript/Index.html src/app/crm/legacy-full.generated.ts src/app/crm/legacy-app.test.ts
git commit -m "feat(ui): one location per customer and no wildcard in the pickers"
```

---

### Task 2: The location-removal conflict card

**Files:**
- Modify: `docs/source-appscript/Index.html`
- Modify: `src/app/crm/legacy-full.generated.ts` (by regeneration only)
- Modify: `src/app/crm/legacy-app.test.ts`

**The owner's requirement, verbatim**

> "when removing location tag from a user, if that user has even one customer of that location then first a card opens saying user holds these customers in this location reassign new handler first and below it list of customers and a drop down infront of each to add new user handler for that customer, once this conflict is solved only then location can be successfully removed from user."

**The server contract (already shipped, `b60a8a3`)**
- `api_admin_userLocationConflicts` with `{ email, removing }` returns `{ conflicts: [{ customerId, customerName, location }], eligibleHandlers: [{ email, name, role }] }`.
- `api_admin_saveUser` accepts an optional `reassign` map of `{ [customerId]: newHandlerEmail }`, recomputes the conflicts server-side, validates every replacement, and applies reassignments and the user update in one transaction.
- The server rejects the save, naming the customers, if any conflict is unresolved.

- [ ] **Step 1: Write the failing tests**

```typescript
test('removing a location the user still handles opens the conflict card', async () => {
  mockRpc(rpc); render(createElement(CrmApp));
  await screen.findByRole('heading', { name: 'Overview' });
  window.eval('nav("admin")');
  await waitFor(() => expect(document.getElementById('main')?.textContent).toContain('Users'));
  press('Edit');
  await waitFor(() => expect(document.getElementById('au_tags')).not.toBeNull());

  (document.querySelector('#au_tags [data-t="Punjab"]') as HTMLElement).click();
  press('Save user');

  await waitFor(() => expect(document.body.textContent).toContain('Reassign'));
  expect(document.body.textContent).toContain('Acme Ltd');
  expect(document.querySelector('select[data-customer="CUST-0001"]')).not.toBeNull();
  expect(calls.find((c) => c.fn === 'api_admin_saveUser')).toBeUndefined();
});

test('choosing a new handler for every conflict saves with the reassignments', async () => {
  mockRpc(rpc); render(createElement(CrmApp));
  await screen.findByRole('heading', { name: 'Overview' });
  window.eval('nav("admin")');
  await waitFor(() => expect(document.getElementById('main')?.textContent).toContain('Users'));
  press('Edit');
  await waitFor(() => expect(document.getElementById('au_tags')).not.toBeNull());
  (document.querySelector('#au_tags [data-t="Punjab"]') as HTMLElement).click();
  press('Save user');
  await waitFor(() => expect(document.body.textContent).toContain('Reassign'));

  const picker = document.querySelector('select[data-customer="CUST-0001"]') as HTMLSelectElement;
  picker.value = 'other@automationsystems.org';
  press('Reassign and save');

  await waitFor(() =>
    expect(calls.find((c) => c.fn === 'api_admin_saveUser')?.args[0]).toEqual(
      expect.objectContaining({ reassign: { 'CUST-0001': 'other@automationsystems.org' } })
    )
  );
});
```

Extend the test file's RPC stub so `api_admin_userLocationConflicts` returns one conflict (`CUST-0001` / `Acme Ltd` / `Punjab`) and two eligible handlers. Read how the existing stub is structured and follow it.

- [ ] **Step 2: Run them and watch them fail**

Run: `npx vitest run src/app/crm/legacy-app.test.ts`
Expected: FAIL — no conflict card exists, so `saveUser` posts immediately.

- [ ] **Step 3: Check for conflicts before saving**

In `saveUser(origEmail)` (~line 2408): compute `removing` as the locations the user held before, minus those now selected. The modal must know the user's original tags — capture them when `mUser(u)` opens, e.g. on a module-level variable alongside the other modal state.

If nothing is being removed, save exactly as today. Otherwise call `api_admin_userLocationConflicts` first; if it returns no conflicts, save as today.

- [ ] **Step 4: Render the card**

With conflicts, open a modal that states what is blocking, in the owner's own terms — the user holds these customers in that location and a new handler is needed first. Under it, one row per customer showing its name and location, with a `<select>` carrying `data-customer="<customerId>"`, populated from `eligibleHandlers` plus a **Direct** option (the server accepts `direct`, and without it an admin with no eligible user would be stuck).

Buttons: **Cancel** (closes, changes nothing) and **Reassign and save**. Escape the customer name and every option label with the existing `esc()` helper — a customer name is user-supplied text and must never be interpolated raw.

- [ ] **Step 5: Save with the reassignments**

On confirm, build `{ [customerId]: selectedEmail }` from the selects and call `api_admin_saveUser` with the existing payload plus `reassign`. On success close and refresh as the current save does. On failure show the server's message via the existing error toast — the server re-validates, so its refusal is authoritative and must surface rather than being swallowed.

- [ ] **Step 6: Run and watch them pass, then regenerate**

```bash
npx vitest run src/app/crm/legacy-app.test.ts
node scripts/port-legacy-index.mjs
```

- [ ] **Step 7: Full suite, type check, commit**

```bash
npx vitest run
npx tsc --noEmit -p tsconfig.json
git add docs/source-appscript/Index.html src/app/crm/legacy-full.generated.ts src/app/crm/legacy-app.test.ts
git commit -m "feat(ui): conflict card for removing a location a user still handles"
```
