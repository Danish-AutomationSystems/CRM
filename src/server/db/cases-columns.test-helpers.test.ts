import { describe, expect, it } from 'vitest';

import { applyCasesColumnMigration } from './cases-columns.test-helpers';

describe('applyCasesColumnMigration', () => {
  it('adds columns from add column', () => {
    const names = new Set(['case_id']);
    applyCasesColumnMigration(names, 'alter table public.cases add column if not exists priority text;');
    expect([...names].sort()).toEqual(['case_id', 'priority']);
  });

  it('removes columns from drop column, with and without if exists', () => {
    const names = new Set(['case_id', 'owner', 'extra_owners']);
    applyCasesColumnMigration(
      names,
      'alter table public.cases drop column if exists owner;\nalter table public.cases drop column extra_owners;'
    );
    expect([...names]).toEqual(['case_id']);
  });

  it('ignores drop column on other tables', () => {
    const names = new Set(['case_id', 'owner']);
    applyCasesColumnMigration(names, 'alter table public.quotations drop column owner;');
    expect([...names].sort()).toEqual(['case_id', 'owner']);
  });

  it('does not treat drop constraint or drop not null as a column drop', () => {
    const names = new Set(['case_id', 'customer_id']);
    applyCasesColumnMigration(
      names,
      'alter table public.cases alter column customer_id drop not null;\nalter table public.cases drop constraint if exists cases_stage_check;'
    );
    expect([...names].sort()).toEqual(['case_id', 'customer_id']);
  });
});
