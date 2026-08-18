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
const REQUEST_PATH = ['dashboard/service.ts', 'customers/service.ts', 'cases/service.ts'];

/**
 * The keys an admin can edit. STAGES, OUTCOMES, QUOTE_STATUSES and ROLES are
 * deliberately absent: cases.stage carries a database CHECK constraint
 * (0001_initial_schema.sql:70), so those are not admin-editable and reading them
 * from the constant is correct.
 */
const CONFIGURABLE = ['TAGS', 'TYPES', 'PRIORITIES', 'CATEGORIES', 'SEI_NAMES'];

function sourceOf(relative: string): string {
  return fs.readFileSync(path.join(__dirname, '..', relative), 'utf8');
}

describe('configurable settings are never read from the hardcoded constant', () => {
  it.each(REQUEST_PATH)('%s reads no configurable key from DEFAULT_SETTINGS', (relative) => {
    const source = sourceOf(relative);
    const offenders = CONFIGURABLE.filter((key) =>
      new RegExp(`DEFAULT_SETTINGS\\.${key}\\b`).test(source)
    );
    expect(
      offenders,
      `${relative} reads DEFAULT_SETTINGS.${offenders.join(', ')} - use loadSettings() instead, ` +
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
});
