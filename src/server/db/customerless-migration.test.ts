import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const migrationPath = path.join(__dirname, '../../../supabase/migrations/0013_customerless_cases.sql');

describe('customerless cases migration', () => {
  it('removes only the customer NOT NULL requirement, retains the FK and checks Quoted/Won', () => {
    expect(fs.existsSync(migrationPath)).toBe(true);
    const migration = fs.readFileSync(migrationPath, 'utf8').replace(/--[^\n]*/g, '').replace(/\s+/g, ' ').trim();
    expect(migration).toBe("alter table public.cases alter column customer_id drop not null; alter table public.cases add constraint cases_quoted_customer_check check ((stage <> 'Quoted' and outcome is distinct from 'Won') or customer_id is not null);");
    const initial = fs.readFileSync(path.join(path.dirname(migrationPath), '0001_initial_schema.sql'), 'utf8');
    const cases = initial.match(/create table if not exists public\.cases \(([\s\S]*?)\n\);/)![1];
    expect(cases).toMatch(/customer_id text not null references public\.customers\(customer_id\)/);
  });
});
