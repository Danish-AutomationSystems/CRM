import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { legacyDerivedCaseOwners, seededCaseOwners, type SeedCaseRow, type SeedHandlerRow } from './owner-seed';

/**
 * Fixture mirroring the shapes that actually exist in production:
 *  - a customer with several real handlers
 *  - a customer whose only handler is the virtual 'direct'
 *  - a customer with no handler row at all
 *  - closed cases (outcome set) as well as active ones
 *  - cases that already carry extra_owners
 *  - a degenerate case whose derived owner set is empty
 */
const handlers: SeedHandlerRow[] = [
  { customerId: 'CUST-0001', email: 'anita@automationsystems.org' },
  { customerId: 'CUST-0001', email: 'bob@automationsystems.org' },
  { customerId: 'CUST-0002', email: 'direct' },
  // CUST-0003 deliberately has no handler row.
  { customerId: 'CUST-0004', email: 'Carol@AutomationSystems.org' },
  { customerId: 'CUST-0004', email: 'direct' }
];

const cases: SeedCaseRow[] = [
  { id: 'CASE-2026-0001', customerId: 'CUST-0001', outcome: '', owner: 'anita@automationsystems.org', extraOwners: [] },
  { id: 'CASE-2026-0002', customerId: 'CUST-0001', outcome: 'Won', owner: 'bob@automationsystems.org', extraOwners: [] },
  {
    id: 'CASE-2026-0003',
    customerId: 'CUST-0001',
    outcome: 'Lost',
    owner: 'anita@automationsystems.org',
    extraOwners: ['dana@automationsystems.org']
  },
  { id: 'CASE-2026-0004', customerId: 'CUST-0002', outcome: '', owner: 'erin@automationsystems.org', extraOwners: [] },
  {
    id: 'CASE-2026-0005',
    customerId: 'CUST-0002',
    outcome: 'Hold',
    owner: 'erin@automationsystems.org',
    extraOwners: ['frank@automationsystems.org']
  },
  { id: 'CASE-2026-0006', customerId: 'CUST-0003', outcome: '', owner: 'gita@automationsystems.org', extraOwners: [] },
  { id: 'CASE-2026-0007', customerId: 'CUST-0004', outcome: '', owner: 'hari@automationsystems.org', extraOwners: [] },
  // Degenerate: no handlers and no usable stored owner. Derived owner set is empty.
  { id: 'CASE-2026-0008', customerId: 'CUST-0003', outcome: '', owner: 'direct', extraOwners: [] },
  { id: 'CASE-2026-0009', customerId: 'CUST-0003', outcome: 'Won', owner: '', extraOwners: [] },
  // Duplicate handler + extra owner overlap, plus mixed case / whitespace.
  {
    id: 'CASE-2026-0010',
    customerId: 'CUST-0001',
    outcome: '',
    owner: 'anita@automationsystems.org',
    extraOwners: [' Anita@automationsystems.org ', 'bob@automationsystems.org']
  }
];

function sorted(values: readonly string[]): string[] {
  return [...values].sort();
}

describe('P11 case-owner seed migration', () => {
  it('produces, for every single case, an owner set identical to the old read-time derivation', () => {
    expect(cases.length).toBeGreaterThan(0);

    for (const row of cases) {
      const before = legacyDerivedCaseOwners(row, handlers);
      const after = seededCaseOwners(row, handlers);

      expect({ id: row.id, owners: sorted(after) }).toEqual({ id: row.id, owners: sorted(before) });
    }
  });

  it('seeds the exact expected owner sets for each real-world shape', () => {
    const byId = Object.fromEntries(cases.map((row) => [row.id, sorted(seededCaseOwners(row, handlers))]));

    // Multiple real handlers -> both handlers own every case on the account, open or closed.
    expect(byId['CASE-2026-0001']).toEqual(['anita@automationsystems.org', 'bob@automationsystems.org']);
    expect(byId['CASE-2026-0002']).toEqual(['anita@automationsystems.org', 'bob@automationsystems.org']);
    // Existing extra owners are preserved alongside the handlers.
    expect(byId['CASE-2026-0003']).toEqual([
      'anita@automationsystems.org',
      'bob@automationsystems.org',
      'dana@automationsystems.org'
    ]);
    // Direct-only handler -> the creator was the derived owner.
    expect(byId['CASE-2026-0004']).toEqual(['erin@automationsystems.org']);
    expect(byId['CASE-2026-0005']).toEqual(['erin@automationsystems.org', 'frank@automationsystems.org']);
    // No handler row at all -> the creator.
    expect(byId['CASE-2026-0006']).toEqual(['gita@automationsystems.org']);
    // Real handler alongside 'direct' -> only the real handler, normalised to lower case.
    expect(byId['CASE-2026-0007']).toEqual(['carol@automationsystems.org']);
    // Degenerate rows keep an empty set, exactly as the old derivation returned.
    expect(byId['CASE-2026-0008']).toEqual([]);
    expect(byId['CASE-2026-0009']).toEqual([]);
    // Duplicates collapse.
    expect(byId['CASE-2026-0010']).toEqual(['anita@automationsystems.org', 'bob@automationsystems.org']);
  });

  it('never drops an owner that the old derivation produced', () => {
    for (const row of cases) {
      for (const owner of legacyDerivedCaseOwners(row, handlers)) {
        expect(seededCaseOwners(row, handlers)).toContain(owner);
      }
    }
  });

  it('ships as migration 0005 and self-verifies per case before committing', () => {
    const sqlText = readFileSync(
      join(process.cwd(), 'supabase/migrations/0005_materialise_case_owners.sql'),
      'utf8'
    );

    // The migration must recompute the old derivation and abort on any per-case mismatch.
    expect(sqlText).toMatch(/raise exception/i);
    expect(sqlText).toMatch(/extra_owners/);
    expect(sqlText).toMatch(/'direct'/);
  });
});
