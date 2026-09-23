import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const migrationPath = path.join(__dirname, '../../../supabase/migrations/0018_require_case_customer.sql');

function statements(sql: string): string[] {
  return sql
    .replace(/do \$\$[\s\S]*?\$\$;/g, '')
    .replace(/--[^\n]*/g, '')
    .split(';')
    .map((statement) => statement.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
}

describe('require a customer on every case migration', () => {
  const read = () => fs.readFileSync(migrationPath, 'utf8');

  it('deletes only customerless cases, and touches no other table', () => {
    const deletes = statements(read()).filter((statement) => statement.startsWith('delete'));
    expect(deletes).toEqual(['delete from public.cases where customer_id is null']);
  });

  it('restores NOT NULL on cases.customer_id and changes no other column', () => {
    const alters = statements(read()).filter((statement) => statement.startsWith('alter table'));
    expect(alters).toEqual(['alter table public.cases alter column customer_id set not null']);
  });

  it('sets a lock timeout before taking ACCESS EXCLUSIVE on public.cases', () => {
    const all = statements(read());
    expect(all[0]).toBe("set local lock_timeout = '3s'");
  });

  it('verifies its own post-condition', () => {
    const migration = read();
    expect(migration).toMatch(/is_nullable/);
    expect(migration).toMatch(/raise exception/);
  });
});
