import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const MIGRATIONS_DIR = join(process.cwd(), 'supabase/migrations');
const SEED_MIGRATION = '0005_materialise_case_owners.sql';
const CLEANUP_MIGRATION = '0006_remove_l5_l6_handlers.sql';

type Handler = { customerId: string; email: string };

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
