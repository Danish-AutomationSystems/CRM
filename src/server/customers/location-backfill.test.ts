import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { DEFAULT_SETTINGS, TAG_TO_BE_FILLED } from '../settings/defaults';

const MIGRATION = '0007_backfill_customer_locations.sql';

type Row = { id: string; tags: string[] };

/** Mirrors the UPDATE the migration performs. */
function applyBackfill(rows: readonly Row[]): Row[] {
  return rows.map((row) => (row.tags.length === 0 ? { ...row, tags: [TAG_TO_BE_FILLED] } : { ...row }));
}

describe('P7 location backfill migration', () => {
  const before: Row[] = [
    { id: 'CUST-0001', tags: [] },
    { id: 'CUST-0002', tags: ['Punjab'] },
    { id: 'CUST-0003', tags: [] },
    { id: 'CUST-0004', tags: ['NCR', 'Geo'] },
    { id: 'CUST-0005', tags: [] }
  ];

  it('leaves no customer with an empty location, and changes nothing else', () => {
    const emptyBefore = before.filter((row) => row.tags.length === 0);
    const after = applyBackfill(before);
    const emptyAfter = after.filter((row) => row.tags.length === 0);

    expect(emptyBefore.length).toBeGreaterThan(0);
    expect(emptyAfter).toHaveLength(0);
    // Total customer count is unchanged.
    expect(after).toHaveLength(before.length);
    // Rows that already had a location are untouched.
    expect(after.find((row) => row.id === 'CUST-0002')?.tags).toEqual(['Punjab']);
    expect(after.find((row) => row.id === 'CUST-0004')?.tags).toEqual(['NCR', 'Geo']);
    // Backfilled rows carry exactly one value.
    expect(after.find((row) => row.id === 'CUST-0001')?.tags).toEqual([TAG_TO_BE_FILLED]);
    expect(after.find((row) => row.id === 'CUST-0003')?.tags).toEqual([TAG_TO_BE_FILLED]);
  });

  it('backfills a value the app still recognises, so a later save cannot re-empty the row', () => {
    // This is the trap: validTags() strips anything not in DEFAULT_SETTINGS.TAGS.
    expect(DEFAULT_SETTINGS.TAGS).toContain(TAG_TO_BE_FILLED);
  });

  it('ships as migration 0007 with before/after assertions', () => {
    const sqlText = readFileSync(join(process.cwd(), 'supabase/migrations', MIGRATION), 'utf8');

    expect(sqlText).toMatch(/update\s+public\.customers/i);
    expect(sqlText).toContain('TO BE FILLED');
    expect(sqlText).toMatch(/raise exception/i);
    // Must assert the total customer count did not change.
    expect(sqlText).toMatch(/total_before/);
    expect(sqlText).toMatch(/total_after/);
  });
});
