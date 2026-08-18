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

  it('falls back to the default tax when the stored value is blank', async () => {
    // A blank row is indistinguishable from "never set" and must not be read as 0%.
    // An admin who wants 0% tax types 0, which is finite and stored/read as such.
    const settings = await loadSettings(reader([{ key: 'TAX_PCT', value: '   ' }]));
    expect(settings.taxPct).toBe(DEFAULT_SETTINGS.TAX_PCT);
  });

  it('honours a deliberate 0% tax', async () => {
    const settings = await loadSettings(reader([{ key: 'TAX_PCT', value: '0' }]));
    expect(settings.taxPct).toBe(0);
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
