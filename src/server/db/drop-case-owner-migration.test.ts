import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { allCasesColumns } from './cases-columns.test-helpers';

const migrationsDir = path.join(__dirname, '../../../supabase/migrations');
const migrationPath = path.join(migrationsDir, '0014_drop_case_owner_columns.sql');

function statements(sql: string): string[] {
  return sql
    .replace(/do \$\$[\s\S]*?\$\$;/g, '')
    .replace(/--[^\n]*/g, '')
    .split(';')
    .map((s) => s.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
}

describe('drop case owner columns migration', () => {
  const sql = fs.existsSync(migrationPath) ? fs.readFileSync(migrationPath, 'utf8') : '';
  const structural = statements(sql).filter((s) => /^(alter table|drop index)/.test(s));

  it('exists', () => {
    expect(fs.existsSync(migrationPath)).toBe(true);
  });

  it('drops exactly owner and extra_owners from public.cases, and nothing else', () => {
    const dropped = structural.filter((s) => s.startsWith('alter table')).map((s) => s.match(/drop column (?:if exists )?(\w+)/)?.[1]);
    expect(dropped.sort()).toEqual(['extra_owners', 'owner']);
    for (const s of structural.filter((x) => x.startsWith('alter table'))) {
      expect(s).toMatch(/^alter table public\.cases drop column /);
    }
  });

  it('drops the owner index', () => {
    expect(structural).toContain('drop index if exists public.cases_owner_outcome_idx');
  });

  it('sets a lock timeout and verifies its own post-conditions', () => {
    expect(statements(sql)).toContain("set local lock_timeout = '3s'");
    expect(sql.match(/raise exception/g)?.length).toBe(2);
  });

  it('leaves the column-parity parser with neither column', () => {
    const columns = allCasesColumns(migrationsDir);
    expect(columns).not.toContain('owner');
    expect(columns).not.toContain('extra_owners');
    expect(columns).toContain('created_by');
  });
});
