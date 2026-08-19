# Admin Config Module Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Admin → Settings actually work: config lists read live from the database, edited item by item, with renames propagating to every record that holds the value and deletes propagating nowhere.

**Architecture:** One live settings reader replaces every hardcoded `DEFAULT_SETTINGS` read on the request path, leaving that constant as seed-and-fallback only. Item-level add/rename/delete RPCs replace the save-the-whole-textarea call. Rename runs one transaction per config key over an explicit column map; delete touches only the settings row, which forces validation to tolerate a stored value that is no longer offered.

**Tech Stack:** TypeScript, Next.js 15 App Router, `postgres.js`, Supabase Postgres 17.6, vitest, Playwright.

## Global Constraints

- **Design spec:** `docs/superpowers/specs/2026-08-18-admin-config-module-design.md`. Read it first — it carries the reasoning for every decision here.
- **Branch:** `feat/admin-config-module`. Spec and the placeholder plan are already committed on it.
- **Run everything from** `D:\AutomationSystems\CRM\migrated-crm`. Windows; use the PowerShell tool. Never the parent directory `D:\AutomationSystems\CRM` — that is the old Apps Script project.
- **TDD is mandatory.** Every code change is preceded by a test that is run and *seen to fail* first.
- **Baseline: 426 vitest and 24 Playwright tests pass, ZERO failures.** It must stay at zero.
- **Never hand-edit `src/app/crm/legacy-full.generated.ts`.** Edit `docs/source-appscript/Index.html`, run `node scripts/port-legacy-index.mjs`.
- **No `as any`, no casts, no optional properties added to dodge the typechecker.**
- **Never commit secrets.** Do not open, read, or echo `.env.local`. Do not print any database URL, password, or key.
- **Do not connect to a database or run a migration** in Tasks 1-6. There is no migration in this plan. Task 7 owns deployment.
- Playwright needs env vars or the dev server will not boot:
  `$env:NEXT_PUBLIC_SUPABASE_URL="http://127.0.0.1:3999"; $env:NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY="dummy-key-for-e2e"; npx playwright test`
  **Never pipe Playwright through `tail` or `head`** — it masks the exit code.

### Two storage facts that will bite you

**1. Pipe-joined columns are written with spaces and read without them.**
`joinPipe` (`src/server/domain/lists.ts:27`) writes `values.join(' | ')`. `parsePipe` (`:16`) splits on `'|'` and **trims** each element. So `cases.won_categories` holds `"VFDs | PLC"`, and any SQL that does `string_to_array(won_categories, '|')` gets `['VFDs ', ' PLC']` — with leading and trailing spaces. An `array_replace` against `'PLC'` matches nothing. Every pipe-column rename must trim per element. The exact SQL is given in Task 5.

**2. `parseList` splits on commas as well as pipes.**
`parseList` (`:5`) splits on `/[|,]/`. It is what `validTags` uses. So a location or SEI name containing a comma would be silently split into two values on the next save. Config values must therefore reject both `|` and `,`. The existing category `Lighting, Switches, Wires` is safe only because `validCategories` uses `parsePipe`, which splits on `|` alone — do not "fix" that inconsistency here, just respect it. The value-validation rules are in Task 4.

---

## File Structure

| File | Responsibility | Change |
|---|---|---|
| `src/server/settings/live.ts` | The one live settings reader | **Create** |
| `src/server/settings/live.test.ts` | Its tests | **Create** |
| `src/server/settings/config-targets.ts` | Which columns hold which config key | **Create** |
| `src/server/settings/config-targets.test.ts` | Its tests | **Create** |
| `src/server/settings/defaults.ts` | Seed values and per-key fallback | **Modify** — documentation only |
| `src/server/dashboard/service.ts` | `bootstrap()` settings block | **Modify** |
| `src/server/customers/service.ts` | Validation | **Modify** |
| `src/server/cases/service.ts` | Validation | **Modify** |
| `src/server/admin/service.ts` | Config item add/rename/delete | **Modify** |
| `src/server/admin/repository.ts` *(or wherever `PostgresAdminRepository` lives)* | Rename SQL | **Modify** |
| `src/server/admin/rpc.ts` | Three new RPCs | **Modify** |
| `docs/source-appscript/Index.html` | Admin cards, remove Case Sources, add SEI | **Modify** |
| `CONTEXT.md` | Project context | **Modify** — Task 7 |

---

### Task 1: The live settings reader

**Files:**
- Create: `src/server/settings/live.ts`, `src/server/settings/live.test.ts`

**Interfaces:**
- Consumes: `AdminSettingRow` (`{ key: string; value: string }`) as returned by `listSettings()` (`src/server/admin/service.ts:874`).
- Produces, used by every later task:
  ```ts
  export type ConfigListKey = 'TAGS' | 'TYPES' | 'PRIORITIES' | 'CATEGORIES' | 'SEI_NAMES';
  export type LiveSettings = {
    tags: string[]; types: string[]; priorities: string[];
    categories: string[]; seiNames: string[];
    taxPct: number; currency: string; company: string;
  };
  export type SettingsReader = { listSettings(): Promise<Array<{ key: string; value: string }>> };
  export async function loadSettings(repo: SettingsReader): Promise<LiveSettings>;
  export function selectableTags(settings: LiveSettings): string[];
  ```

- [ ] **Step 1: Write the failing tests**

Create `src/server/settings/live.test.ts`:

```ts
import { describe, expect, it } from 'vitest';

import { DEFAULT_SETTINGS, TAG_TO_BE_FILLED } from './defaults';
import { loadSettings, selectableTags } from './live';

function reader(rows: Array<{ key: string; value: string }>) {
  return { async listSettings() { return rows; } };
}

describe('loadSettings', () => {
  it('returns the stored value, not the hardcoded default', async () => {
    const settings = await loadSettings(reader([{ key: 'TYPES', value: 'Alpha | Beta' }]));
    expect(settings.types).toEqual(['Alpha', 'Beta']);
  });

  it('falls back per key when a row is missing', async () => {
    const settings = await loadSettings(reader([{ key: 'TYPES', value: 'Alpha' }]));
    expect(settings.types).toEqual(['Alpha']);
    expect(settings.priorities).toEqual([...DEFAULT_SETTINGS.PRIORITIES]);
  });

  it('falls back when a row is present but blank', async () => {
    const settings = await loadSettings(reader([{ key: 'TYPES', value: '   ' }]));
    expect(settings.types).toEqual([...DEFAULT_SETTINGS.TYPES]);
  });

  it('does NOT fall back for SEI_NAMES, which may legitimately be empty', async () => {
    // Defaulting this would resurrect names an admin deleted.
    const settings = await loadSettings(reader([{ key: 'SEI_NAMES', value: '' }]));
    expect(settings.seiNames).toEqual([]);
  });

  it('reads the whole set in a single query', async () => {
    let calls = 0;
    const counting = { async listSettings() { calls += 1; return []; } };
    await loadSettings(counting);
    expect(calls).toBe(1);
  });

  it('parses the scalar settings', async () => {
    const settings = await loadSettings(reader([
      { key: 'TAX_PCT', value: '12.5' },
      { key: 'CURRENCY', value: 'USD' },
      { key: 'COMPANY', value: 'Acme Ltd' }
    ]));
    expect(settings.taxPct).toBe(12.5);
    expect(settings.currency).toBe('USD');
    expect(settings.company).toBe('Acme Ltd');
  });

  it('falls back to the default tax when the stored value is not a number', async () => {
    const settings = await loadSettings(reader([{ key: 'TAX_PCT', value: 'abc' }]));
    expect(settings.taxPct).toBe(DEFAULT_SETTINGS.TAX_PCT);
  });
});

describe('selectableTags', () => {
  it('never offers the backfill placeholder', async () => {
    const settings = await loadSettings(reader([
      { key: 'TAGS', value: `Punjab | ${TAG_TO_BE_FILLED} | NCR` }
    ]));
    expect(settings.tags).toContain(TAG_TO_BE_FILLED);
    expect(selectableTags(settings)).toEqual(['Punjab', 'NCR']);
  });
});
```

`loadSettings` returns the **full** tag list including `TAG_TO_BE_FILLED` — validation must still recognise it — while `selectableTags` is what the client is offered. That split already exists today as `DEFAULT_SETTINGS.TAGS` versus `SELECTABLE_TAGS` (`defaults.ts`); keep the same meaning.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/server/settings/live.test.ts`
Expected: FAIL — the module does not exist.

- [ ] **Step 3: Implement**

Create `src/server/settings/live.ts`:

```ts
import { parsePipe } from '../domain/lists';
import { DEFAULT_SETTINGS, TAG_TO_BE_FILLED } from './defaults';

export type ConfigListKey = 'TAGS' | 'TYPES' | 'PRIORITIES' | 'CATEGORIES' | 'SEI_NAMES';

export type LiveSettings = {
  tags: string[];
  types: string[];
  priorities: string[];
  categories: string[];
  seiNames: string[];
  taxPct: number;
  currency: string;
  company: string;
};

export type SettingsReader = {
  listSettings(): Promise<Array<{ key: string; value: string }>>;
};

/**
 * The one place the request path learns what the configurable lists contain.
 *
 * Before this existed, api_admin_saveSettings wrote public.settings and every
 * consumer read the hardcoded DEFAULT_SETTINGS instead, so an admin's edit saved
 * and was then ignored. DEFAULT_SETTINGS is now seed-and-fallback only.
 *
 * Cached per request by the caller, never process-wide: on serverless, a
 * process-wide cache means one warm instance serves stale config while another
 * serves fresh, which is worse than no cache because it is intermittent.
 */
export async function loadSettings(repo: SettingsReader): Promise<LiveSettings> {
  const rows = await repo.listSettings();
  const byKey = new Map(rows.map((row) => [row.key, row.value]));

  const list = (key: ConfigListKey, fallback: readonly string[]): string[] => {
    const parsed = parsePipe(byKey.get(key) ?? '');
    return parsed.length ? parsed : [...fallback];
  };

  const storedTax = Number(byKey.get('TAX_PCT'));

  return {
    tags: list('TAGS', DEFAULT_SETTINGS.TAGS),
    types: list('TYPES', DEFAULT_SETTINGS.TYPES),
    priorities: list('PRIORITIES', DEFAULT_SETTINGS.PRIORITIES),
    categories: list('CATEGORIES', DEFAULT_SETTINGS.CATEGORIES),
    // No fallback: an admin may legitimately empty this list, and defaulting it
    // would resurrect names they deleted.
    seiNames: parsePipe(byKey.get('SEI_NAMES') ?? ''),
    taxPct: Number.isFinite(storedTax) ? storedTax : DEFAULT_SETTINGS.TAX_PCT,
    currency: (byKey.get('CURRENCY') ?? '').trim() || DEFAULT_SETTINGS.CURRENCY,
    company: (byKey.get('COMPANY') ?? '').trim() || DEFAULT_SETTINGS.COMPANY
  };
}

/** What a client may pick. Never includes the location-backfill placeholder. */
export function selectableTags(settings: LiveSettings): string[] {
  return settings.tags.filter((tag) => tag !== TAG_TO_BE_FILLED);
}
```

Note `Number('')` is `0`, which is finite — so a blank `TAX_PCT` yields `0`, not the default. That is deliberate: an admin may legitimately set 0% tax, and a blank row is indistinguishable from that. `Number('abc')` is `NaN` and does fall back.

**Wait — check that against the test.** The test asserts a blank `TYPES` falls back but says nothing about a blank `TAX_PCT`. Verify `Number('')` behaviour and if the test and implementation disagree, make the implementation explicit rather than relying on coercion: treat a blank string as absent for `TAX_PCT` too. Say which you chose and why in your report.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/server/settings/live.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/server/settings/live.ts src/server/settings/live.test.ts
git commit -m "feat(settings): a live settings reader

One query, per-key fallback, no fallback for SEI_NAMES because an admin may
legitimately empty it. DEFAULT_SETTINGS becomes seed-and-fallback only; before
this, every consumer read the constant and an admin's saved edit was ignored."
```

---

### Task 2: Bootstrap serves live settings

`bootstrap()` builds the `settings` block the entire client uses to render every dropdown. This is the task that makes an admin's edit visible.

**Files:**
- Modify: `src/server/dashboard/service.ts` (`settings:` block at line 261)
- Modify: `src/server/dashboard/service.test.ts`

**Interfaces:**
- Consumes: `loadSettings`, `selectableTags` from Task 1.
- Produces: the `bootstrap()` payload's `settings` block, now reflecting the database. `sources` is **removed** from it.

- [ ] **Step 1: Write the failing tests**

Add to `src/server/dashboard/service.test.ts`. Read the file's `makeService()` and its fake first — the fake must be able to return settings rows; if it has no `listSettings`, add one backed by a `settingRows` field, matching how the fake already stores `settingRows` for `getSetting`.

```ts
  it('serves the stored config lists, not the hardcoded defaults', async () => {
    const { repo, dashboard } = makeService();
    repo.settingRows = { TYPES: 'Alpha | Beta', PRIORITIES: 'Urgent | Routine' };

    const boot = await dashboard.bootstrap(sales);

    expect(boot.settings.types).toEqual(['Alpha', 'Beta']);
    expect(boot.settings.priorities).toEqual(['Urgent', 'Routine']);
  });

  it('never offers the location backfill placeholder', async () => {
    const { repo, dashboard } = makeService();
    repo.settingRows = { TAGS: 'Punjab | TO BE FILLED | NCR' };

    const boot = await dashboard.bootstrap(sales);

    expect(boot.settings.tags).toEqual(['Punjab', 'NCR']);
  });

  it('no longer sends case sources, which nothing consumes', async () => {
    const { dashboard } = makeService();

    const boot = await dashboard.bootstrap(sales);

    expect('sources' in boot.settings).toBe(false);
  });
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run src/server/dashboard/service.test.ts`
Expected: FAIL — the first two return the hardcoded defaults, the third finds `sources` present.

- [ ] **Step 3: Implement**

In `src/server/dashboard/service.ts`, load settings once alongside the other awaited work in `bootstrap()`, then replace the block at line 261:

```ts
        settings: {
          stages: [...DEFAULT_SETTINGS.STAGES],
          outcomes: [...DEFAULT_SETTINGS.OUTCOMES],
          tags: selectableTags(live),
          types: live.types,
          priorities: live.priorities,
          categories: live.categories,
          taxPct: live.taxPct,
          currency: live.currency,
          company: live.company,
          seiNames: live.seiNames
        },
```

`stages` and `outcomes` stay hardcoded — `cases.stage` has a CHECK constraint (`0001_initial_schema.sql:70`) and they are not admin-editable. `sources` is gone. `seiNames` is **added**, because Task 6's SEI card needs it.

`DashboardRepository` gains `listSettings(): Promise<Array<{ key: string; value: string }>>` if it does not already have it. Check first — the repository class behind it already implements `listSettings` for the admin service (`admin/service.ts:874`); you may only need to declare it on the dashboard's repository type.

- [ ] **Step 4: Run to verify they pass, then the whole suite**

```
npx vitest run src/server/dashboard/service.test.ts
npm test
npx tsc --noEmit
```

Expected: PASS, zero failures. If a client-side test asserts `settings.sources` exists, that is Task 6's client work leaking into this task — note it and leave it; Task 6 removes the consumer.

- [ ] **Step 5: Commit**

```bash
git add src/server/dashboard/service.ts src/server/dashboard/service.test.ts
git commit -m "fix(dashboard): bootstrap serves live settings, not the constant

This is the reported bug: every dropdown in the client is built from this
payload, and it was built from the hardcoded DEFAULT_SETTINGS, so an admin's
saved edit never appeared anywhere.

Also drops `sources` from the payload (nothing consumes it) and adds
`seiNames` (the admin card needs it)."
```

---

### Task 3: Validation reads live settings and tolerates a retired value

Deleting a config value must change nothing about existing records. Today it does: `validOne` and `validTags` strip any value not in the current list, so after deleting Punjab, saving an unrelated field on a Punjab customer blanks its location — and location is mandatory, so the save then fails.

**Files:**
- Modify: `src/server/customers/service.ts` (`validOne` :234, `validTags` :239, `requiredTags` :251, and their call sites)
- Modify: `src/server/cases/service.ts` (`validOne` :226, `validTags` :231, `validCategories` :237, and their call sites)
- Modify: `src/server/customers/service.test.ts`, `src/server/cases/service.test.ts`

**Interfaces:**
- Consumes: `loadSettings` from Task 1.
- Produces: the retired-value tolerance rule that Task 4's delete relies on.

- [ ] **Step 1: Write the failing tests**

Add to `src/server/customers/service.test.ts`:

```ts
  it('validates against the stored list, not the hardcoded defaults', async () => {
    const { repo, service } = makeService();
    repo.settingRows = { TYPES: 'Alpha | Beta' };

    await service.saveCustomerCells(sales, [{ id: 'CUST-0001', fields: { type: 'Alpha' } }]);

    expect((await repo.getCustomer('CUST-0001'))?.type).toBe('Alpha');
  });

  it('keeps a retired value when an unrelated field on the same record is edited', async () => {
    const { repo, service } = makeService();
    // 'Punjab' is on the customer but has been removed from the configured list.
    repo.settingRows = { TAGS: 'NCR | Chandigarh' };

    await service.saveCustomerCells(sales, [{ id: 'CUST-0001', fields: { area: 'Ludhiana' } }]);

    const saved = await repo.getCustomer('CUST-0001');
    expect(saved?.area).toBe('Ludhiana');
    expect(saved?.tags).toEqual(['Punjab']);
  });

  it('still refuses a value that is neither configured nor already stored', async () => {
    const { repo, service } = makeService();
    repo.settingRows = { TYPES: 'Alpha | Beta' };

    await service.saveCustomerCells(sales, [{ id: 'CUST-0001', fields: { type: 'Invented' } }]);

    expect((await repo.getCustomer('CUST-0001'))?.type).not.toBe('Invented');
  });
```

**Read the fixtures first.** These assume the default customer fixture has `tags: ['Punjab']` and that `saveCustomerCells` is the right entry point — verify both against the file and adapt. If the fake has no `settingRows`, add one and back `listSettings`/`getSetting` with it.

Add the equivalent three to `src/server/cases/service.test.ts` for `priority` and for `won_categories`, using `setCaseOutcome`'s Won path for categories.

- [ ] **Step 2: Run to verify they fail**

```
npx vitest run src/server/customers/service.test.ts src/server/cases/service.test.ts
```
Expected: FAIL — the first uses the hardcoded list so `Alpha` is stripped; the second blanks the retired tag.

- [ ] **Step 3: Implement**

Change the validator signatures to take the allowed list and the currently-stored value:

```ts
/**
 * A value is acceptable if it is currently configured, OR if it is unchanged from
 * what is already stored on this record. The second clause is what makes
 * "deleting a config value does not touch existing records" true through an edit:
 * without it, editing a customer's phone number blanks a retired location.
 */
function validOne(value: unknown, allowed: readonly string[], stored?: string): string {
  const text = asText(value);
  if (allowed.includes(text)) return text;
  if (stored !== undefined && text === stored) return text;
  return '';
}

function validTags(value: unknown, allowed: readonly string[], stored: readonly string[] = []): string[] {
  return parseList(Array.isArray(value) ? value.map(String) : String(value ?? ''))
    .filter((tag) => allowed.includes(tag) || stored.includes(tag));
}
```

Then thread the live list and the stored record through every call site. **Creation paths pass no `stored`** — a new record must use a currently-configured value. **Update paths pass the existing row's value.**

`validCategories` in `cases/service.ts` takes the same treatment, with `stored` being the case's current `wonCategories`.

`TAG_TO_BE_FILLED` must remain acceptable: it is in the stored `TAGS` list (Task 4 forbids deleting it), so no special case is needed here — **verify that** rather than assuming, and if it is not, add an explicit allowance with a comment.

- [ ] **Step 4: Run to verify they pass, then everything**

```
npm test
npx tsc --noEmit
```

Expected: zero failures. **If an existing validation test fails, read it before changing it.** A test asserting "an unknown type is stripped" is still correct for a *creation* path; if it is failing on an update path, that is this task's intended behaviour change and the test should be updated with a comment saying why. If it is failing on a creation path, you have threaded `stored` somewhere it does not belong.

- [ ] **Step 5: Add the regression guard for the original bug**

This is the test that stops the bug coming back. The defect was never "one file read
the wrong constant" - it was that reading the constant is the *easy* thing to write,
so it kept happening. Create `src/server/settings/no-hardcoded-reads.test.ts`:

```ts
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/** Request-path modules that must read live settings, never the seed constant. */
const REQUEST_PATH = [
  'dashboard/service.ts',
  'customers/service.ts',
  'cases/service.ts'
];

/** The keys an admin can edit. STAGES/OUTCOMES/QUOTE_STATUSES/ROLES stay hardcoded. */
const CONFIGURABLE = ['TAGS', 'TYPES', 'PRIORITIES', 'CATEGORIES', 'SEI_NAMES'];

describe('configurable settings are never read from the hardcoded constant', () => {
  it.each(REQUEST_PATH)('%s reads no configurable key from DEFAULT_SETTINGS', (relative) => {
    const source = fs.readFileSync(path.join(__dirname, '..', relative), 'utf8');
    const offenders = CONFIGURABLE.filter((key) =>
      new RegExp(`DEFAULT_SETTINGS\\.${key}\\b`).test(source)
    );
    expect(
      offenders,
      `${relative} reads DEFAULT_SETTINGS.${offenders.join(', ')} - use loadSettings() instead, ` +
        'or an admin edit will be silently ignored again'
    ).toEqual([]);
  });

  it('still finds the files, so the guard cannot pass vacuously', () => {
    for (const relative of REQUEST_PATH) {
      const source = fs.readFileSync(path.join(__dirname, '..', relative), 'utf8');
      expect(source.length).toBeGreaterThan(1000);
    }
  });
});
```

**Prove it fires** before committing: temporarily reintroduce a
`DEFAULT_SETTINGS.TYPES` read in `customers/service.ts`, run the test, confirm it
fails naming the file and key, then revert. Put that output in your report.

If the guard fails on a legitimate remaining read, do **not** add an exemption -
that read is the bug. Convert it to `loadSettings()`.

- [ ] **Step 6: Commit**

```bash
git add src/server/customers/service.ts src/server/cases/service.ts src/server/customers/service.test.ts src/server/cases/service.test.ts src/server/settings/no-hardcoded-reads.test.ts
git commit -m "fix(validation): read live settings, keep retired values on edit

Validation read the hardcoded lists, so an admin's edit was ignored on save
as well as in the dropdowns. It now reads the stored lists.

It also accepts a value that is unchanged from what is already on the record,
even if it is no longer configured. Without that, retiring a location would
blank it from a customer the next time anyone edited an unrelated field - and
location is mandatory, so the save would then fail."
```

---

### Task 4: Add and delete config items

**Files:**
- Modify: `src/server/admin/service.ts`
- Modify: `src/server/admin/rpc.ts`
- Modify: `src/server/admin/service.test.ts`

**Interfaces:**
- Consumes: `loadSettings`, `ConfigListKey` from Task 1.
- Produces:
  ```ts
  addConfigItem(user: CrmContext, key: unknown, value: unknown): Promise<{ ok: true }>
  deleteConfigItem(user: CrmContext, key: unknown, value: unknown): Promise<{ ok: true }>
  ```
  registered as `api_admin_addConfigItem` and `api_admin_deleteConfigItem`, both `{ read: false }`.

- [ ] **Step 1: Write the failing tests**

```ts
  it('adds an item to the stored list', async () => {
    const { repo, service } = makeService();
    repo.settingRows = { TYPES: 'Alpha' };

    await service.addConfigItem(admin, 'TYPES', 'Beta');

    expect(repo.settingRows.TYPES).toBe('Alpha | Beta');
  });

  it('refuses a duplicate, case-insensitively', async () => {
    const { repo, service } = makeService();
    repo.settingRows = { TYPES: 'Alpha' };

    await expect(service.addConfigItem(admin, 'TYPES', 'alpha')).rejects.toThrow(/already/i);
  });

  it('refuses a value containing a pipe or a comma', async () => {
    const { service } = makeService();

    await expect(service.addConfigItem(admin, 'TYPES', 'A | B')).rejects.toThrow(/cannot contain/i);
    await expect(service.addConfigItem(admin, 'TAGS', 'A, B')).rejects.toThrow(/cannot contain/i);
  });

  it('refuses an empty value and a value of only spaces', async () => {
    const { service } = makeService();

    await expect(service.addConfigItem(admin, 'TYPES', '   ')).rejects.toThrow();
  });

  it('refuses an unknown config key', async () => {
    const { service } = makeService();

    await expect(service.addConfigItem(admin, 'STAGES', 'Nope')).rejects.toThrow(/not configurable/i);
  });

  it('deletes an item from the stored list and touches no record', async () => {
    const { repo, service } = makeService();
    repo.settingRows = { TAGS: 'Punjab | NCR' };
    // A customer still on Punjab.
    const before = JSON.stringify(repo.customers);

    await service.deleteConfigItem(admin, 'TAGS', 'Punjab');

    expect(repo.settingRows.TAGS).toBe('NCR');
    expect(JSON.stringify(repo.customers)).toBe(before);
  });

  it('refuses to delete the last remaining location', async () => {
    const { repo, service } = makeService();
    repo.settingRows = { TAGS: 'Punjab' };

    await expect(service.deleteConfigItem(admin, 'TAGS', 'Punjab')).rejects.toThrow(/at least one/i);
  });

  it('refuses to touch the location backfill placeholder', async () => {
    const { repo, service } = makeService();
    repo.settingRows = { TAGS: 'Punjab | TO BE FILLED' };

    await expect(service.deleteConfigItem(admin, 'TAGS', 'TO BE FILLED')).rejects.toThrow();
  });

  it('refuses a non-admin', async () => {
    const { service } = makeService();

    await expect(service.addConfigItem(sales, 'TYPES', 'Beta')).rejects.toThrow();
  });
```

`admin` and `sales` are the file's existing fixtures — check their names before use.

**On the at-least-one rule:** today only `TAGS` has it (`admin/service.ts:527`). Keep exactly that scope. Do not extend it to other lists — the spec calls that out as a deliberate parity decision, not an oversight.

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run src/server/admin/service.test.ts`
Expected: FAIL — the methods do not exist.

- [ ] **Step 3: Implement**

Add to `src/server/admin/service.ts`. The shared value rules belong in one helper so add and rename cannot drift:

```ts
// ConfigListKey is defined in src/server/settings/live.ts (Task 1). Import it -
// do not declare a second, parallel key type here.
const CONFIGURABLE_KEYS: readonly ConfigListKey[] = ['TAGS', 'TYPES', 'PRIORITIES', 'CATEGORIES', 'SEI_NAMES'];

function configKey(value: unknown): ConfigListKey {
  const key = asText(value).toUpperCase();
  const match = CONFIGURABLE_KEYS.find((candidate) => candidate === key);
  if (!match) {
    throw new Error(`"${asText(value)}" is not configurable.`);
  }
  return match;
}

/**
 * `|` is the list separator in public.settings and in pipe-joined columns.
 * `,` matters because parseList (domain/lists.ts:5) splits on /[|,]/, so a comma
 * inside a location or SEI name would be silently split into two values on the
 * next save of any record holding it.
 */
function configValue(value: unknown): string {
  const text = asText(value).trim();
  if (!text) throw new Error('Enter a value.');
  if (text.includes('|') || text.includes(',')) {
    throw new Error('A config value cannot contain "|" or ",".');
  }
  if (text === TAG_TO_BE_FILLED) {
    throw new Error(`"${TAG_TO_BE_FILLED}" is reserved.`);
  }
  return text;
}
```

`addConfigItem` reads the current list via `loadSettings`, rejects a case-insensitive duplicate, appends, and writes with `setSetting(key, joinPipe(list))`. `deleteConfigItem` removes the exact match, enforces the `TAGS` at-least-one rule, and writes. Both call `ensureAdmin(user)` **first**, before touching the key or value, so a non-admin cannot probe which keys or values exist. Both log to `activity_log` with a distinct action — `CONFIG_ADD` and `CONFIG_DELETE` — rather than the generic `SETTINGS`, since these now change what the whole app offers.

- [ ] **Step 4: Register the RPCs**

In `src/server/admin/rpc.ts`, alongside the existing registrations:

```ts
  registry.registerRpc(
    'api_admin_addConfigItem',
    ({ args, context }) => adminService.addConfigItem(context, args[0], args[1]),
    { read: false }
  );
  registry.registerRpc(
    'api_admin_deleteConfigItem',
    ({ args, context }) => adminService.deleteConfigItem(context, args[0], args[1]),
    { read: false }
  );
```

If `src/server/rpc/api-parity.test.ts` fails, add the new names to its `intentionallyNew` allowlist — these are genuinely new capabilities with no Apps Script counterpart. **Do not weaken the test**; the allowlist entry must still require the RPC to be registered.

- [ ] **Step 5: Run everything**

```
npx vitest run src/server/admin/service.test.ts
npm test
npx tsc --noEmit
```
Expected: zero failures.

- [ ] **Step 6: Commit**

```bash
git add src/server/admin/service.ts src/server/admin/rpc.ts src/server/admin/service.test.ts src/server/rpc/api-parity.test.ts
git commit -m "feat(admin): add and delete individual config items

Values may not contain '|' or ',': the first is the list separator, and the
second is split by parseList, so a comma in a location would silently become
two locations on the next save of any record holding it.

Delete removes from the list and touches no record, per the owner's rule.
'TO BE FILLED' is reserved - it is the location backfill placeholder, and
validTags strips anything unrecognised, so losing it would re-empty every
backfilled customer."
```

---

### Task 5: Rename propagation

The largest and most dangerous task. A rename rewrites business data across up to three tables, one of which governs access control.

**Files:**
- Create: `src/server/settings/config-targets.ts`, `src/server/settings/config-targets.test.ts`
- Modify: `src/server/admin/service.ts`, `src/server/admin/rpc.ts`, `src/server/admin/service.test.ts`
- Modify: the Postgres admin repository (find it with `grep -rn "async listSettings" --include=*.ts src/server`)

**Interfaces:**
- Consumes: `configKey`, `configValue` from Task 4.
- Produces:
  ```ts
  export type RenameTarget = { table: string; column: string; kind: 'scalar' | 'array' | 'pipe' };
  export const RENAME_TARGETS: Record<ConfigListKey, readonly RenameTarget[]>;
  renameConfigItem(user: CrmContext, key: unknown, oldValue: unknown, newValue: unknown): Promise<{ ok: true }>
  ```
  registered as `api_admin_renameConfigItem`, `{ read: false }`.

- [ ] **Step 1: Write the target map and its test**

Create `src/server/settings/config-targets.ts`:

```ts
import type { ConfigListKey } from './live';

export type RenameTarget = {
  table: string;
  column: string;
  /** scalar: a plain text column. array: text[]. pipe: ' | '-joined text. */
  kind: 'scalar' | 'array' | 'pipe';
};

/**
 * Every column that stores a copy of a config value, per config key.
 *
 * A missing entry here means a rename silently leaves stale values behind.
 * users.allowed_tags is the one that matters most: locations gate who can see
 * which customers, so missing it would silently revoke access rather than merely
 * mislabel something.
 */
export const RENAME_TARGETS = {
  TAGS: [
    { table: 'customers', column: 'tags', kind: 'array' },
    { table: 'users', column: 'allowed_tags', kind: 'array' },
    { table: 'recycle_bin', column: 'tags', kind: 'array' }
  ],
  TYPES: [
    { table: 'customers', column: 'type', kind: 'scalar' },
    { table: 'recycle_bin', column: 'type', kind: 'scalar' }
  ],
  PRIORITIES: [
    { table: 'customers', column: 'priority', kind: 'scalar' },
    { table: 'cases', column: 'priority', kind: 'scalar' },
    { table: 'recycle_bin', column: 'priority', kind: 'scalar' }
  ],
  CATEGORIES: [{ table: 'cases', column: 'won_categories', kind: 'pipe' }],
  SEI_NAMES: [
    { table: 'customers', column: 'sei', kind: 'array' },
    { table: 'recycle_bin', column: 'sei', kind: 'array' }
  ]
} as const satisfies Record<ConfigListKey, readonly RenameTarget[]>;
```

Create `src/server/settings/config-targets.test.ts`:

```ts
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { RENAME_TARGETS } from './config-targets';

const schema = fs.readFileSync(
  path.join(__dirname, '..', '..', '..', 'supabase', 'migrations', '0001_initial_schema.sql'),
  'utf8'
);

describe('rename targets', () => {
  it('names only tables and columns that exist', () => {
    for (const targets of Object.values(RENAME_TARGETS)) {
      for (const target of targets) {
        const table = schema.match(
          new RegExp(`create table if not exists public\\.${target.table} \\(([\\s\\S]*?)\\n\\);`)
        );
        expect(table, `table public.${target.table} not found`).toBeTruthy();
        expect(
          table?.[1].includes(target.column),
          `column ${target.table}.${target.column} not found`
        ).toBe(true);
      }
    }
  });

  it('covers users.allowed_tags for locations, which is access control', () => {
    expect(RENAME_TARGETS.TAGS).toContainEqual({
      table: 'users', column: 'allowed_tags', kind: 'array'
    });
  });

  it('treats won_categories as pipe-joined, not scalar', () => {
    // A scalar rewrite would replace substrings: the live list has both
    // 'Other' and 'Others', and 'Panels' alongside 'Switchgear'.
    expect(RENAME_TARGETS.CATEGORIES[0].kind).toBe('pipe');
  });
});
```

`cases.priority` is added by migration `0011_case_priority.sql`, not `0001` — so the first test will fail for that one target. **Extend the schema read to concatenate every file in `supabase/migrations/` and match `alter table ... add column` as well**, rather than deleting the assertion. Getting this right is the point of the test.

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/server/settings/config-targets.test.ts`
Expected: FAIL — module missing. After creating it, expect the `cases.priority` gap described above; fix the test's schema derivation, not the map.

- [ ] **Step 3: Write the failing rename tests**

In `src/server/admin/service.test.ts`:

```ts
  it('renames the item in the stored list', async () => {
    const { repo, service } = makeService();
    repo.settingRows = { TAGS: 'Punjab | NCR' };

    await service.renameConfigItem(admin, 'TAGS', 'Punjab', 'PUN');

    expect(repo.settingRows.TAGS).toBe('PUN | NCR');
  });

  it('rewrites every record holding the old location, including user access', async () => {
    const { repo, service } = makeService();
    repo.settingRows = { TAGS: 'Punjab | NCR' };

    await service.renameConfigItem(admin, 'TAGS', 'Punjab', 'PUN');

    expect(repo.renames).toContainEqual({ table: 'customers', column: 'tags', from: 'Punjab', to: 'PUN' });
    expect(repo.renames).toContainEqual({ table: 'users', column: 'allowed_tags', from: 'Punjab', to: 'PUN' });
    expect(repo.renames).toContainEqual({ table: 'recycle_bin', column: 'tags', from: 'Punjab', to: 'PUN' });
  });

  it('refuses to rename to a value that already exists', async () => {
    const { repo, service } = makeService();
    repo.settingRows = { TAGS: 'Punjab | NCR' };

    await expect(service.renameConfigItem(admin, 'TAGS', 'Punjab', 'NCR')).rejects.toThrow(/already/i);
  });

  it('refuses to rename a value that is not in the list', async () => {
    const { repo, service } = makeService();
    repo.settingRows = { TAGS: 'Punjab' };

    await expect(service.renameConfigItem(admin, 'TAGS', 'Nowhere', 'PUN')).rejects.toThrow(/not found/i);
  });

  it('rolls back every column when one rewrite fails', async () => {
    const { repo, service } = makeService();
    repo.settingRows = { TAGS: 'Punjab | NCR' };
    repo.failRenameOn = 'users';

    await expect(service.renameConfigItem(admin, 'TAGS', 'Punjab', 'PUN')).rejects.toThrow();

    expect(repo.settingRows.TAGS).toBe('Punjab | NCR');
    expect(repo.committed).toBe(false);
  });

  it('refuses a non-admin', async () => {
    const { service } = makeService();

    await expect(service.renameConfigItem(sales, 'TAGS', 'Punjab', 'PUN')).rejects.toThrow();
  });
```

The fake needs a `renames: Array<{table,column,from,to}>` recorder, a `failRenameOn` switch, and a `committed` flag its `withTransaction` sets. Read the existing fake's `withTransaction` before adding these; it currently just calls the callback, so a rollback test needs it to actually model failure.

- [ ] **Step 4: Run to verify they fail**

Run: `npx vitest run src/server/admin/service.test.ts`
Expected: FAIL — `renameConfigItem` does not exist.

- [ ] **Step 5: Implement the repository rewrite**

Add to the Postgres admin repository. **The SQL differs per kind, and the pipe case is the one that goes wrong quietly:**

```ts
  async renameConfigValue(target: RenameTarget, oldValue: string, newValue: string): Promise<void> {
    const table = this.db(target.table);
    const column = this.db(target.column);

    if (target.kind === 'scalar') {
      await this.db`update ${table} set ${column} = ${newValue} where ${column} = ${oldValue}`;
      return;
    }

    if (target.kind === 'array') {
      await this.db`
        update ${table}
        set ${column} = array_replace(${column}, ${oldValue}, ${newValue})
        where ${oldValue} = any(${column})
      `;
      return;
    }

    // pipe: joinPipe writes ' | ' but parsePipe splits on '|' and trims, so stored
    // text is 'VFDs | PLC'. Splitting on '|' alone yields elements with spaces, and
    // an exact-match replace would never fire. Trim per element, match exactly, and
    // re-join in joinPipe's format. A plain string replace would corrupt neighbours:
    // the live list holds both 'Other' and 'Others'.
    await this.db`
      update ${table}
      set ${column} = (
        select coalesce(string_agg(case when btrim(part) = ${oldValue} then ${newValue} else btrim(part) end, ' | '), '')
        from unnest(string_to_array(${column}, '|')) as part
        where btrim(part) <> ''
      )
      where ${oldValue} = any(
        select btrim(part) from unnest(string_to_array(${column}, '|')) as part
      )
    `;
  }
```

**Verify `this.db(identifier)` is how this codebase interpolates identifiers with `postgres.js`** before relying on it — check an existing dynamic-identifier query in `scripts/backup-database.mjs`, which uses `sql(table)`. If the repository has no such precedent, do not build a string by concatenation; use the driver's identifier helper. The table and column names come from a frozen const map, never from user input, but the code must still not be injectable by construction.

`string_agg` over `unnest` does not guarantee element order. **Add `with ordinality` and an `order by` to preserve it**, or a category list silently reorders on every rename.

- [ ] **Step 6: Implement the service method**

`renameConfigItem` validates admin, key, and both values (reusing Task 4's `configKey`/`configValue`), rejects when the old value is absent or the new value already exists (case-insensitive), then in **one transaction**: rewrites each target from `RENAME_TARGETS[key]`, writes the updated settings row, and logs `CONFIG_RENAME` with `${old} -> ${new}` on `entity: key`.

The settings write goes **last**, so a failed data rewrite cannot leave the list claiming a rename that did not happen.

- [ ] **Step 7: Run everything**

```
npm test
npx tsc --noEmit
```
Expected: zero failures.

- [ ] **Step 8: Commit**

```bash
git add src/server/settings/config-targets.ts src/server/settings/config-targets.test.ts src/server/admin/service.ts src/server/admin/rpc.ts src/server/admin/service.test.ts
git commit -m "feat(admin): rename a config item and propagate it everywhere

One transaction per rename over an explicit column map. The client sends
{key, oldValue, newValue} rather than two lists, because a diff cannot tell a
rename from a delete plus an add.

users.allowed_tags is in the map for locations: it gates who can see which
customers, so missing it would silently revoke access rather than mislabel a
field. won_categories is pipe-joined and is rewritten element-wise - a string
replace would corrupt 'Other' inside 'Others'."
```

---

### Task 6: The admin panel

**Files:**
- Modify: `docs/source-appscript/Index.html` (admin cards at 2145-2168; `srcOptions` at 1297)
- Regenerate: `src/app/crm/legacy-full.generated.ts`
- Modify: `tests/e2e/crm-smoke.spec.ts`

**Interfaces:**
- Consumes: `api_admin_addConfigItem`, `api_admin_renameConfigItem`, `api_admin_deleteConfigItem`; `settings.seiNames` from Task 2.

- [ ] **Step 1: Replace the five list cards**

Each list card becomes rows plus an add field. Write one helper rather than five copies:

```js
function configCard(title, key, items, hint){
  var rows = (items||[]).map(function(item){
    return '<div class="qr"><div style="flex:1">'+esc(item)+'</div>'+
      '<button class="btn lk" onclick="cfgRename(\''+esc(key)+'\',\''+jsArg(item)+'\')">edit</button> · '+
      '<button class="btn lk" onclick="cfgDelete(\''+esc(key)+'\',\''+jsArg(item)+'\')">delete</button></div>';
  }).join('') || '<div class="empty">Nothing configured yet.</div>';
  return '<div class="card"><div class="ovl">'+esc(title)+'</div>'+rows+
    (hint?'<p class="hint">'+esc(hint)+'</p>':'')+
    '<div class="frow" style="margin-top:10px"><div style="flex:1"><input id="cfg_'+esc(key)+'"></div>'+
    '<div style="display:flex;align-items:flex-end"><button class="btn sm" onclick="cfgAdd(\''+esc(key)+'\')">Add</button></div></div></div>';
}
```

**`jsArg` is the escaping helper for values interpolated into inline handlers.** Confirm it exists in `Index.html` before using it — `CONTEXT.md` records that the file was missing it at some call sites and still used `esc()` there. If it is absent, add it or use the same approach the file's other `onclick` value interpolations use. A config value goes straight into an `onclick` attribute, so getting this wrong is an injection vector for anyone who can add a config item.

Cards: `TAGS` "Customer locations (geographies)", `TYPES` "Customer types", `PRIORITIES` "Priorities", `CATEGORIES` "Won order categories", `SEI_NAMES` "SEI names". Keep the existing hint text on locations and categories.

**Remove the Case sources card entirely** (line 2160-2162), and delete `srcOptions()` (line 1297), which has no callers.

- [ ] **Step 2: Add the three client handlers**

```js
function cfgAdd(key){
  var val = v('cfg_'+key);
  if(!val){ toast('Enter a value.', true); return; }
  gs('api_admin_addConfigItem', key, val).then(afterConfigChange).catch(oops);
}
function cfgDelete(key, item){
  gs('api_admin_deleteConfigItem', key, item).then(afterConfigChange).catch(oops);
}
function cfgRename(key, item){
  var next = prompt('Rename "'+item+'" to:', item);
  if(next===null) return;
  next = String(next).trim();
  if(!next || next===item) return;
  gs('api_admin_renameConfigItem', key, item, next).then(afterConfigChange).catch(oops);
}
function afterConfigChange(){
  toast('Saved.');
  cacheBust();
  boot().then(function(){ vAdmin(); }).catch(oops);
}
```

`cfgDelete` intentionally does **not** confirm — the owner chose delete-without-asking.

`afterConfigChange` re-boots so the editing admin's own `S.settings` reflects the change immediately; without it the dropdowns they just edited stay stale until a reload. **Check the real names of the boot and admin-render functions** (`boot`, `vAdmin`, `cacheBust`) against the file and use whatever it actually calls — these are the likely names, not confirmed ones.

- [ ] **Step 3: Regenerate and run the guards**

```
node scripts/port-legacy-index.mjs
npx vitest run src/app/crm/legacy-app.test.ts
npm test
```

Expected: the generator guard (`new Function(legacyAppScript)` does not throw) passes; zero failures.

- [ ] **Step 4: Add a Playwright test**

In `tests/e2e/crm-smoke.spec.ts`, reusing the file's existing mocked-session helpers: an admin sees a configured location as a row with edit and delete controls, and the Case sources card is absent. Read the neighbouring admin tests and match their mocking approach rather than building a new one.

Run Playwright with the env vars from Global Constraints. Never pipe it through `tail`.

- [ ] **Step 5: Commit**

```bash
git add docs/source-appscript/Index.html src/app/crm/legacy-full.generated.ts tests/e2e/crm-smoke.spec.ts
git commit -m "feat(admin): item-level config cards, SEI added, Case sources removed

Each list is now rows with edit and delete plus an add field, backed by the
three new RPCs. Delete does not confirm, per the owner's choice.

Case sources is gone: srcOptions() had zero callers, so nothing has ever set
a case source. The cases.source column and its service plumbing stay - that
is a separate, irreversible decision."
```

---

### Task 7: Gate, deploy, verify, and bring CONTEXT.md current

**Files:** `CONTEXT.md`.

- [ ] **Step 1: Run the full gate**

```
npm run typecheck
npm test
npm run build
```
plus Playwright with the env vars from Global Constraints. Expected: zero failures throughout.

- [ ] **Step 2: Back up the database**

```bash
node --env-file=.env.local scripts/backup-database.mjs
node --env-file=.env.local scripts/verify-backup.mjs backups/<the-file-just-written>.json
```

`--env-file` loads `DATABASE_URL` without printing it. **Never echo the file or the URL.** `backups/` is gitignored because it holds the entire customer dataset in plaintext; do not commit it.

This branch has **no migration**, but a rename rewrites customer, case and user rows in bulk with no undo. The backup is the undo.

- [ ] **Step 3: Merge and deploy**

```bash
git checkout main
git merge --no-ff feat/admin-config-module
git push origin main
```

No migration to apply. Vercel deploys `main` automatically.

- [ ] **Step 4: Verify in production**

1. Admin → Settings. Every list shows rows with edit and delete. Case sources is gone. SEI names is present.
2. **Add** a location. It appears immediately in the card, and in the location dropdown when creating a customer.
3. **Rename** a location that is in use — e.g. `Punjab` → `PUN`. Then check: an existing customer on Punjab now shows PUN; **a user whose access was restricted to Punjab can still see that customer**. This is the access-control check and it is the most important one on this list.
4. **Delete** a location that is in use. Existing customers keep showing it. It is no longer offered when creating a customer.
5. Open one of those customers, change an unrelated field such as Area, and save. **The retired location must still be there.**
6. Repeat add/rename/delete once for Types, Priorities, Categories and SEI.
7. Mark a case Won and confirm the category multi-select shows the configured list.
8. Confirm no form field anywhere shows placeholder text (the other plan on this branch).

- [ ] **Step 5: Bring CONTEXT.md current**

It was last updated 2026-08-11 and is now materially wrong. Add this work, and correct:
- The "Known Issue: `public.settings` is write-only" section — now fixed; describe what replaced it.
- Migrations list: `0005`-`0008` are applied (it claims they are not), and `0009`, `0010`, `0011` exist.
- `quotations.upload_data` is no longer how uploads are stored — they go to Google Drive.
- The `listCases` per-case `getCustomer` N+1 is fixed.
- The four features shipped 2026-08-13/14 and the case-priority feature shipped 2026-08-18 have no entry at all.

- [ ] **Step 6: Commit and push**

```bash
git add CONTEXT.md
git commit -m "docs: record the config module and correct five stale CONTEXT claims"
git push origin main
```

- [ ] **Step 7: Rollback if needed**

`git revert` the merge commit and push. There is no schema change, so the revert is complete for code. **A rename that already ran is not undone by a revert** — the data is rewritten. Restoring from the Step 2 backup is the only way back, which is why that step is not optional.

---

## Follow-ups deliberately excluded

1. Dropping the `cases.source` column and its service plumbing.
2. Making stages, outcomes, quote statuses or roles admin-editable — `cases.stage` has a CHECK constraint, so it needs a migration.
3. Usage counts, delete confirmation, or undo.
4. Merging two config values into one.
5. Reordering items within a list.
6. A `config_items` table.
7. Push invalidation so other users' browsers refresh settings without navigating.
