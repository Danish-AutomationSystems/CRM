import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const migrationsDir = path.join(__dirname, '../../../supabase/migrations');
const migrationPath = path.join(migrationsDir, '0013_customerless_cases.sql');

/**
 * Guards migration 0013's blast radius: it must make `cases.customer_id` nullable and
 * nothing else.
 *
 * This used to assert the file's entire text with `toBe`, which did enforce "nothing
 * extra" - but it also rejected the two safety additions every other migration here
 * carries (a `lock_timeout`, and a post-condition block that re-reads the catalog and
 * raises if the change did not land). Byte-equality cannot tell a dangerous addition
 * from a protective one, so it is replaced below by assertions on what the migration
 * actually *does*: the structural statements are enumerated, so a stray `alter table`
 * or a second `drop not null` still fails the test.
 */
function statements(sql: string): string[] {
  return sql
    .replace(/do \$\$[\s\S]*?\$\$;/g, '') // the post-condition block asserts, never mutates
    .replace(/--[^\n]*/g, '')
    .split(';')
    .map((statement) => statement.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
}

describe('customerless cases migration', () => {
  const migration = fs.readFileSync(migrationPath, 'utf8');
  const structural = statements(migration).filter((statement) => statement.startsWith('alter table'));

  it('exists and touches no table other than public.cases', () => {
    expect(fs.existsSync(migrationPath)).toBe(true);
    expect(structural.length).toBeGreaterThan(0);
    for (const statement of structural) {
      expect(statement).toMatch(/^alter table public\.cases /);
    }
  });

  it('drops the NOT NULL on customer_id, and on no other column', () => {
    const dropped = structural.filter((statement) => /drop not null/.test(statement));
    expect(dropped).toEqual(['alter table public.cases alter column customer_id drop not null']);
  });

  it('adds the Quoted/Won customer check with the exact predicate', () => {
    // Quoted or Won always needs a customer; every other stage/outcome may be customerless.
    expect(structural).toContain(
      "alter table public.cases add constraint cases_quoted_customer_check check ((stage <> 'Quoted' and outcome is distinct from 'Won') or customer_id is not null)"
    );
  });

  it('never drops a constraint - in particular it keeps the customer foreign key', () => {
    // Nullable is not the same as unreferenced: a case that HAS a customer must still
    // point at a real one.
    for (const statement of structural) {
      expect(statement).not.toMatch(/drop constraint/);
    }
    const initial = fs.readFileSync(path.join(migrationsDir, '0001_initial_schema.sql'), 'utf8');
    const cases = initial.match(/create table if not exists public\.cases \(([\s\S]*?)\n\);/)![1];
    expect(cases).toMatch(/customer_id text not null references public\.customers\(customer_id\)/);
  });

  it('sets a lock timeout, so it cannot queue every reader behind it indefinitely', () => {
    // public.cases backs the case list, the case page and every dashboard; both statements
    // above take ACCESS EXCLUSIVE on it.
    expect(statements(migration)).toContain("set local lock_timeout = '3s'");
  });

  it('verifies its own post-conditions rather than trusting the statements applied', () => {
    expect(migration).toMatch(/is_nullable/);
    expect(migration).toMatch(/cases_quoted_customer_check.*\n?.*\) into constraint_exists/s);
    expect(migration.match(/raise exception/g)?.length).toBe(2);
  });
});
