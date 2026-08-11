import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { caseOwners } from '../auth/access';

const MIGRATIONS_DIR = join(process.cwd(), 'supabase/migrations');
const SEED_MIGRATION = '0005_materialise_case_owners.sql';
const CLEANUP_MIGRATION = '0006_remove_l5_l6_handlers.sql';

type Handler = { customerId: string; email: string };
type Case = { id: string; customerId: string; title: string; assignee: string; owner: string; extraOwners: string[] };

/** Mirrors the DELETE the migration performs. */
function applyCleanup(handlers: readonly Handler[], roles: Record<string, string>): Handler[] {
  return handlers.filter((row) => !['L5', 'L6'].includes(roles[row.email] ?? ''));
}

describe('P1 L5/L6 handler-removal migration', () => {
  const roles: Record<string, string> = {
    'anita@automationsystems.org': 'L2',
    'bob@automationsystems.org': 'L3',
    'boss@automationsystems.org': 'L5',
    'admin@automationsystems.org': 'L6'
  };

  const handlers: Handler[] = [
    { customerId: 'CUST-0001', email: 'anita@automationsystems.org' },
    { customerId: 'CUST-0001', email: 'boss@automationsystems.org' },
    { customerId: 'CUST-0002', email: 'admin@automationsystems.org' },
    { customerId: 'CUST-0003', email: 'direct' },
    { customerId: 'CUST-0004', email: 'bob@automationsystems.org' }
  ];

  // Post-P11 state: every case carries its own materialised owner set.
  const cases: Case[] = [
    {
      id: 'CASE-2026-0001',
      customerId: 'CUST-0001',
      title: 'Case CASE-2026-0001',
      assignee: '',
      owner: 'anita@automationsystems.org',
      extraOwners: ['anita@automationsystems.org', 'boss@automationsystems.org']
    },
    {
      id: 'CASE-2026-0002',
      customerId: 'CUST-0002',
      title: 'Case CASE-2026-0002',
      assignee: '',
      owner: 'admin@automationsystems.org',
      extraOwners: ['admin@automationsystems.org']
    },
    {
      id: 'CASE-2026-0003',
      customerId: 'CUST-0003',
      title: 'Case CASE-2026-0003',
      assignee: '',
      owner: 'anita@automationsystems.org',
      extraOwners: ['anita@automationsystems.org']
    },
    {
      id: 'CASE-2026-0004',
      customerId: 'CUST-0004',
      title: 'Case CASE-2026-0004',
      assignee: '',
      owner: 'bob@automationsystems.org',
      extraOwners: ['bob@automationsystems.org']
    }
  ];

  it('deletes every L5/L6 handler row: count is > 0 before and exactly 0 after', () => {
    const before = handlers.filter((row) => ['L5', 'L6'].includes(roles[row.email] ?? ''));
    const after = applyCleanup(handlers, roles);

    expect(before.length).toBeGreaterThan(0);
    expect(after.filter((row) => ['L5', 'L6'].includes(roles[row.email] ?? ''))).toHaveLength(0);
    // 'direct' and all L1-L4 handler rows survive.
    expect(after.map((row) => row.email)).toEqual([
      'anita@automationsystems.org',
      'direct',
      'bob@automationsystems.org'
    ]);
  });

  it('no case loses an owner across the migration, because ownership is materialised', () => {
    const ownersBefore = Object.fromEntries(cases.map((row) => [row.id, caseOwners(row)]));

    applyCleanup(handlers, roles); // handler rows change; case rows are not touched at all.

    for (const row of cases) {
      expect({ id: row.id, owners: caseOwners(row) }).toEqual({ id: row.id, owners: ownersBefore[row.id] });
      expect(caseOwners(row).length).toBeGreaterThan(0);
    }
    // Specifically: the L5 and the L6 stay owners of the cases they already owned.
    expect(caseOwners(cases[0])).toContain('boss@automationsystems.org');
    expect(caseOwners(cases[1])).toContain('admin@automationsystems.org');
  });

  it('is ordered strictly after the P11 seed migration and only touches public.handlers', () => {
    const files = readdirSync(MIGRATIONS_DIR).filter((name) => name.endsWith('.sql')).sort();

    expect(files).toContain(SEED_MIGRATION);
    expect(files).toContain(CLEANUP_MIGRATION);
    expect(files.indexOf(CLEANUP_MIGRATION)).toBeGreaterThan(files.indexOf(SEED_MIGRATION));

    const sqlText = readFileSync(join(MIGRATIONS_DIR, CLEANUP_MIGRATION), 'utf8');
    expect(sqlText).toMatch(/delete\s+from\s+public\.handlers/i);
    // It must never write to public.cases - that is exactly the damage P11 was landed to prevent.
    expect(sqlText).not.toMatch(/update\s+public\.cases/i);
    expect(sqlText).not.toMatch(/delete\s+from\s+public\.cases/i);
  });
});
