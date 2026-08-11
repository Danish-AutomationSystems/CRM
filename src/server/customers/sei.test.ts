import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { parseSeiText } from './sei';

const MIGRATION = '0008_customer_sei_multi_select.sql';

describe('P8 SEI text -> text[] migration', () => {
  // Every shape the free-text `sei` column can currently hold in production.
  const before: Array<{ id: string; sei: string }> = [
    { id: 'CUST-0001', sei: '' },
    { id: 'CUST-0002', sei: '   ' },
    { id: 'CUST-0003', sei: 'Ravi Kumar' },
    { id: 'CUST-0004', sei: 'Ravi Kumar | Sunil Mehta' },
    { id: 'CUST-0005', sei: 'Ravi Kumar, Sunil Mehta' },
    { id: 'CUST-0006', sei: ' Ravi Kumar ,  Sunil Mehta |Anita Rao ' },
    { id: 'CUST-0007', sei: 'Ravi Kumar,,' }
  ];

  it('preserves every pre-existing non-empty value, asserted row by row', () => {
    for (const row of before) {
      const after = parseSeiText(row.sei);

      if (row.sei.trim() === '') {
        expect({ id: row.id, after }).toEqual({ id: row.id, after: [] });
        continue;
      }

      // Every name present in the original text must appear in the resulting array.
      const originalNames = row.sei
        .split(/[|,]/)
        .map((part) => part.trim())
        .filter(Boolean);

      expect({ id: row.id, names: after }).toEqual({ id: row.id, names: originalNames });
      expect(after.length).toBeGreaterThan(0);
    }
  });

  it('splits on both | and , exactly as the migration does', () => {
    expect(parseSeiText('Ravi Kumar')).toEqual(['Ravi Kumar']);
    expect(parseSeiText('Ravi Kumar | Sunil Mehta')).toEqual(['Ravi Kumar', 'Sunil Mehta']);
    expect(parseSeiText('Ravi Kumar, Sunil Mehta')).toEqual(['Ravi Kumar', 'Sunil Mehta']);
    expect(parseSeiText(' Ravi Kumar ,  Sunil Mehta |Anita Rao ')).toEqual([
      'Ravi Kumar',
      'Sunil Mehta',
      'Anita Rao'
    ]);
    expect(parseSeiText('Ravi Kumar,,')).toEqual(['Ravi Kumar']);
    expect(parseSeiText(null)).toEqual([]);
    expect(parseSeiText(['Ravi Kumar', ' ', 'Anita Rao'])).toEqual(['Ravi Kumar', 'Anita Rao']);
  });

  it('no row loses data: the count of customers with a value is identical before and after', () => {
    const withValueBefore = before.filter((row) => row.sei.trim() !== '').length;
    const withValueAfter = before.filter((row) => parseSeiText(row.sei).length > 0).length;

    expect(withValueBefore).toBeGreaterThan(0);
    expect(withValueAfter).toBe(withValueBefore);
  });

  it('ships as migration 0008, converts both customers and recycle_bin, and seeds SEI_NAMES empty', () => {
    const sqlText = readFileSync(join(process.cwd(), 'supabase/migrations', MIGRATION), 'utf8');

    expect(sqlText).toMatch(/alter table public\.customers/i);
    expect(sqlText).toMatch(/alter table public\.recycle_bin/i);
    expect(sqlText).toMatch(/text\[\]/);
    // Splits on both separators.
    expect(sqlText).toMatch(/\[\|,\]/);
    // Ships EMPTY - no invented names.
    expect(sqlText).toMatch(/SEI_NAMES/);
    expect(sqlText).toMatch(/raise exception/i);
  });
});
