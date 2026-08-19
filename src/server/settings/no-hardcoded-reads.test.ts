import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The regression guard for the settings-drift bug.
 *
 * api_admin_saveSettings always wrote public.settings correctly. The bug was that
 * every consumer imported the hardcoded DEFAULT_SETTINGS instead of reading the
 * table, so an admin's edit saved and was then ignored - in bootstrap(), which
 * builds every dropdown the client renders, and in the validation that runs on
 * save. It was recorded in CONTEXT.md on 2026-08-11 and shipped unfixed.
 *
 * This guard exists because the defect was never one bad line. Reading the
 * constant is the *easy* thing to write, so it kept happening. An assertion that
 * a specific file is currently correct would not stop the next one.
 */

/** Modules on the request path, which must read live settings. */
const REQUEST_PATH = ['dashboard/service.ts', 'customers/service.ts', 'cases/service.ts', 'quotes/service.ts'];

/**
 * The keys an admin can edit. STAGES, OUTCOMES, QUOTE_STATUSES and ROLES are
 * deliberately absent: cases.stage carries a database CHECK constraint
 * (0001_initial_schema.sql:70), so those are not admin-editable and reading them
 * from the constant is correct.
 *
 * COMPANY, TAX_PCT and CURRENCY were added for the same reason as the rest:
 * COMPANY reached a generated quotation document straight from the constant,
 * so a renamed company never showed up on a customer-facing document after the
 * admin saved the rename. TAX_PCT and CURRENCY are lower-risk (the client
 * always sends a live value; the constant is a fallback only) but are guarded
 * here too - see the fallback-vs-output distinction below.
 */
const CONFIGURABLE = ['TAGS', 'TYPES', 'PRIORITIES', 'CATEGORIES', 'SEI_NAMES', 'COMPANY', 'TAX_PCT', 'CURRENCY'];

/**
 * Named exports of settings/defaults.ts that are themselves computed once from
 * DEFAULT_SETTINGS rather than read live per request - structurally "the
 * hardcoded constant", one hop removed. SELECTABLE_TAGS is DEFAULT_SETTINGS.TAGS
 * filtered; the original settings-drift bug reproduced exactly through this
 * binding (customerMeta used to read it instead of the live list), and a guard
 * that only matched `DEFAULT_SETTINGS.TAGS` never saw it.
 *
 * Add an entry here for every derived export that is downstream of a
 * CONFIGURABLE key, or this guard goes back to missing that shape of bug.
 */
const DERIVED_CONSTANT_BINDINGS: Record<string, string> = {
  SELECTABLE_TAGS: 'TAGS'
};

function sourceOf(relative: string): string {
  return fs.readFileSync(path.join(__dirname, '..', relative), 'utf8');
}

/**
 * Whether a `DEFAULT_SETTINGS.KEY` reference at `index` in `source` is a typed
 * default-*parameter* value - `name: Type = DEFAULT_SETTINGS.KEY` inside a
 * function's parameter list - rather than a read that feeds output directly.
 *
 * That shape only supplies a value for when a caller omits the argument; every
 * call site in the request path that matters (the ones that generate a
 * customer-facing document, a dropdown, or validation) passes an explicit live
 * value instead, so the constant is never actually reached from those paths.
 * quotes/service.ts:taxPercent(value, fallback = DEFAULT_SETTINGS.TAX_PCT) is
 * the motivating example: every caller now passes `live.taxPct` explicitly.
 *
 * This is deliberately narrow - a single textual shape, not a file-wide or
 * key-wide exemption - so it cannot be used to wave off a read that actually
 * reaches output. A `DEFAULT_SETTINGS.KEY` read anywhere else, including a
 * *default value for a plain local variable* (not a function parameter), is
 * still caught.
 */
function isDefaultParameterFallback(source: string, index: number): boolean {
  const lineStart = source.lastIndexOf('\n', index) + 1;
  const lineEndRaw = source.indexOf('\n', index);
  const line = source.slice(lineStart, lineEndRaw === -1 ? source.length : lineEndRaw);
  return /\w+\s*:\s*[\w.<>[\] |]+\s*=\s*DEFAULT_SETTINGS\.\w+\s*\)/.test(line);
}

/**
 * Every distinct symbol in `source` that reads a configurable `key` from the
 * hardcoded constant - the dotted literal, a destructured binding, or a known
 * derived re-export. Order is insertion order; duplicates are not repeated.
 */
function offendersFor(source: string, key: string): string[] {
  const found = new Set<string>();

  const directPattern = new RegExp(`DEFAULT_SETTINGS\\.${key}\\b`, 'g');
  for (const match of source.matchAll(directPattern)) {
    if (!isDefaultParameterFallback(source, match.index)) {
      found.add(`DEFAULT_SETTINGS.${key}`);
    }
  }

  // Destructuring: `const { TAGS } = DEFAULT_SETTINGS` (any spacing, any
  // sibling properties, optional renaming via `TAGS: whatever`).
  const destructurings = source.match(/\{([^{}]*)\}\s*=\s*DEFAULT_SETTINGS\b/g) ?? [];
  for (const match of destructurings) {
    const inner = match.slice(match.indexOf('{') + 1, match.lastIndexOf('}'));
    const names = inner
      .split(',')
      .map((entry) => entry.trim().split(':')[0].trim())
      .filter(Boolean);
    if (names.includes(key)) {
      found.add(`{ ${key} } = DEFAULT_SETTINGS`);
    }
  }

  // Known derived re-exports of this key, e.g. SELECTABLE_TAGS for TAGS.
  for (const [binding, boundKey] of Object.entries(DERIVED_CONSTANT_BINDINGS)) {
    if (boundKey === key && new RegExp(`\\b${binding}\\b`).test(source)) {
      found.add(binding);
    }
  }

  return [...found];
}

describe('configurable settings are never read from the hardcoded constant', () => {
  it.each(REQUEST_PATH)('%s reads no configurable key from DEFAULT_SETTINGS, directly or via a derived binding', (relative) => {
    const source = sourceOf(relative);
    const offenders = CONFIGURABLE.flatMap((key) => offendersFor(source, key));
    expect(
      offenders,
      `${relative} reads ${offenders.join(', ')} from the hardcoded constant - use loadSettings() instead, ` +
        'or an admin edit will be silently ignored again'
    ).toEqual([]);
  });

  it('still finds every guarded file, so the guard cannot pass vacuously', () => {
    // A renamed or moved module would otherwise make this suite silently green.
    for (const relative of REQUEST_PATH) {
      expect(sourceOf(relative).length, `${relative} is empty or missing`).toBeGreaterThan(1000);
    }
  });

  it('names keys that actually exist, so a typo cannot make the guard vacuous', async () => {
    const { DEFAULT_SETTINGS } = await import('./defaults');
    for (const key of CONFIGURABLE) {
      expect(DEFAULT_SETTINGS, `CONFIGURABLE names ${key}, which is not a setting`).toHaveProperty(key);
    }
  });

  it('names derived bindings that actually exist and are bound to a configurable key', async () => {
    const defaults = await import('./defaults');
    for (const [binding, boundKey] of Object.entries(DERIVED_CONSTANT_BINDINGS)) {
      expect(defaults, `DERIVED_CONSTANT_BINDINGS names ${binding}, which settings/defaults.ts does not export`).toHaveProperty(
        binding
      );
      expect(CONFIGURABLE, `DERIVED_CONSTANT_BINDINGS binds ${binding} to ${boundKey}, which is not CONFIGURABLE`).toContain(
        boundKey
      );
    }
  });

  it('the widened matcher actually catches the shapes it claims to', () => {
    expect(offendersFor('const tags = DEFAULT_SETTINGS.TAGS;', 'TAGS')).toEqual(['DEFAULT_SETTINGS.TAGS']);
    expect(offendersFor('const { TAGS } = DEFAULT_SETTINGS;', 'TAGS')).toEqual(['{ TAGS } = DEFAULT_SETTINGS']);
    expect(offendersFor('const { TYPES, TAGS } = DEFAULT_SETTINGS;', 'TAGS')).toEqual(['{ TAGS } = DEFAULT_SETTINGS']);
    expect(offendersFor('return [...SELECTABLE_TAGS];', 'TAGS')).toEqual(['SELECTABLE_TAGS']);
    expect(offendersFor('const x = SOMETHING_ELSE;', 'TAGS')).toEqual([]);
  });

  /**
   * The fallback-vs-output distinction, proved against fixtures rather than
   * the real source: a typed default-parameter value does not offend, but the
   * exact same dotted read one line away, feeding a value that is actually
   * returned/rendered, still does.
   */
  it('does not flag a typed default-parameter value, but still flags a direct read one line away', () => {
    const fallbackOnly = `
      function taxPercent(value: unknown, fallback: number = DEFAULT_SETTINGS.TAX_PCT): number {
        return value === '' ? fallback : Number(value);
      }
    `;
    expect(offendersFor(fallbackOnly, 'TAX_PCT')).toEqual([]);

    const feedsOutput = `
      function renderCompany() {
        return { company: DEFAULT_SETTINGS.COMPANY };
      }
    `;
    expect(offendersFor(feedsOutput, 'COMPANY')).toEqual(['DEFAULT_SETTINGS.COMPANY']);

    const both = `
      function taxPercent(value: unknown, fallback: number = DEFAULT_SETTINGS.TAX_PCT): number {
        return value === '' ? fallback : Number(value);
      }
      const alwaysWrong = DEFAULT_SETTINGS.TAX_PCT;
    `;
    expect(offendersFor(both, 'TAX_PCT')).toEqual(['DEFAULT_SETTINGS.TAX_PCT']);
  });

  it('quotes/service.ts no longer reads COMPANY into a generated document from the hardcoded constant', () => {
    // Direct regression check, independent of the general sweep above: the
    // reviewed bug was specifically `{{COMPANY}}` and `company:` in the
    // template-merge and download-artifact paths.
    const source = sourceOf('quotes/service.ts');
    expect(source).not.toMatch(/\{\{COMPANY\}\}['"]?\s*:\s*DEFAULT_SETTINGS\.COMPANY/);
    expect(source).not.toMatch(/company:\s*DEFAULT_SETTINGS\.COMPANY/);
  });
});
