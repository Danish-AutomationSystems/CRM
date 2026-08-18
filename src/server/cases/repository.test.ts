import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  allCasesColumns as sharedAllCasesColumns,
  casesInsertColumns as sharedCasesInsertColumns,
  casesUpdateSetColumns as sharedCasesUpdateSetColumns,
  insertValueCount as sharedInsertValueCount,
  methodBody as sharedMethodBody,
  migrationAddedCasesColumns as sharedMigrationAddedCasesColumns,
  missingFrom as sharedMissingFrom,
  selectColumns as sharedSelectColumns
} from '../db/cases-columns.test-helpers';

const source = fs.readFileSync(path.join(__dirname, 'repository.ts'), 'utf8');
const migrationsDir = path.join(__dirname, '..', '..', '..', 'supabase', 'migrations');

function methodBody(name: string): string {
  return sharedMethodBody(source, name);
}

function insertColumns(): string[] {
  const body = methodBody('logActivity');
  const match = body.match(/insert into public\.activity_log \(([^)]*)\)/);
  if (!match) throw new Error('logActivity insert column list not found');
  return match[1].split(',').map((c) => c.trim()).filter(Boolean);
}

function selectColumns(method: string, table: string): string[] {
  return sharedSelectColumns(source, method, table);
}

/**
 * Columns added to activity_log by a migration *after* the initial schema.
 *
 * Derived rather than hardcoded on purpose: the defect this guard exists to
 * catch is "a migration adds a column to activity_log and logActivity never
 * writes it". Pinning the literal 'note' would only ever catch that defect for
 * this one column, and the next one would ship unnoticed - which is exactly
 * what happened before.
 *
 * Columns of the base CREATE TABLE (id, created_at, ...) are deliberately out
 * of scope: they are generated defaults that the INSERT should not name.
 */
function migrationAddedActivityLogColumns(): string[] {
  const dir = path.join(__dirname, '..', '..', '..', 'supabase', 'migrations');
  const names = new Set<string>();

  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
    const sql = fs.readFileSync(path.join(dir, file), 'utf8');
    // `alter table public.activity_log <...> add column [if not exists] <name>`,
    // up to the statement terminator, so a later ALTER on another table cannot
    // leak in.
    const statements = sql.matchAll(/alter\s+table\s+(?:only\s+)?public\.activity_log\b([\s\S]*?);/gi);
    for (const statement of statements) {
      const adds = statement[1].matchAll(/add\s+column\s+(?:if\s+not\s+exists\s+)?"?([a-z_][a-z0-9_]*)"?/gi);
      for (const add of adds) names.add(add[1].toLowerCase());
    }
  }

  return [...names].sort();
}

function insertValueCount(): number {
  const body = methodBody('logActivity');
  // Non-greedy up to the closing paren of the VALUES tuple, then anything up to the
  // closing backtick (e.g. a trailing `returning id`) - the widened logActivity adds one.
  const match = body.match(/values \(([\s\S]*?)\)[\s\S]*?`/);
  if (!match) throw new Error('logActivity values list not found');
  let depth = 0;
  let count = 1;
  for (const ch of match[1]) {
    if (ch === '(') depth += 1;
    else if (ch === ')') depth -= 1;
    else if (ch === ',' && depth === 0) count += 1;
  }
  return count;
}

/**
 * Columns of public.case_attachments, as declared by the migration that creates it.
 *
 * Derived rather than hardcoded, for the same reason as migrationAddedActivityLogColumns
 * above: the defect this guards against is an INSERT/SELECT drifting from the table shape,
 * and a hardcoded list would only ever catch that drift for columns known in advance.
 *
 * `id` and `created_at` are excluded from the "insertable" set below - they are
 * generated defaults (uuid default gen_random_uuid(), timestamptz default now()) that an
 * INSERT should not name - but are kept in the "selectable" set since listAttachmentsByCase
 * returns them as part of CaseAttachmentRow.
 */
function caseAttachmentsColumns(): { all: string[]; insertable: string[] } {
  const dir = path.join(__dirname, '..', '..', '..', 'supabase', 'migrations');
  const file = fs.readdirSync(dir).find((f) => f.endsWith('.sql') && f.includes('case_attachments'));
  if (!file) throw new Error('case_attachments migration file not found');
  const migrationSql = fs.readFileSync(path.join(dir, file), 'utf8');
  const match = migrationSql.match(/create table if not exists public\.case_attachments \(([\s\S]*?)\n\);/);
  if (!match) throw new Error('case_attachments CREATE TABLE not found');

  const all = match[1]
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.split(/\s+/)[0].replace(/,$/, ''))
    .filter(Boolean);

  const generated = new Set(['id', 'created_at']);
  return { all, insertable: all.filter((c) => !generated.has(c)) };
}

function dbHelperColumns(method: string): string[] {
  const body = methodBody(method);
  // Matches the postgres.js multi-row insert helper: this.db(rows, 'col_a', 'col_b', ...)
  const match = body.match(/this\.db\(\s*\w+,\s*([\s\S]*?)\)/);
  if (!match) throw new Error(`${method} multi-row insert helper call not found`);
  return match[1]
    .split(',')
    .map((c) => c.trim().replace(/^['"]|['"]$/g, ''))
    .filter(Boolean);
}

/**
 * EVERY column of public.cases: the initial CREATE TABLE plus every later ALTER.
 *
 * Deliberately not limited to migration-added columns. A guard over only the new
 * ones would protect `priority` and leave the original seventeen unguarded - drop
 * `outcome_note` from updateCase's set clause and nothing would object. The defect
 * class is "a statement stops carrying a column", and it does not care when the
 * column was born.
 */
function allCasesColumns(): string[] {
  return sharedAllCasesColumns(migrationsDir);
}

function missingFrom(statement: string, carried: string[]): string[] {
  return sharedMissingFrom(migrationsDir, `cases.${statement}`, carried);
}

/**
 * Columns added to public.cases by a migration after the initial schema.
 * Kept as a separate, narrower derivation purely to prove the guard above is
 * live: if this ever returns nothing, the migration parsing has broken.
 */
function migrationAddedCasesColumns(): string[] {
  return sharedMigrationAddedCasesColumns(migrationsDir);
}

function casesInsertColumns(): string[] {
  return sharedCasesInsertColumns(source, 'createCase');
}

function casesInsertValueCount(): number {
  return sharedInsertValueCount(source, 'createCase', 'cases');
}

/**
 * The left-hand side of every assignment in updateCase's `set` clause.
 *
 * updateCase is not an INSERT and not a SELECT: it merges `fields` over the
 * existing row and rewrites the full column list. A column missing here is
 * never written, and nothing errors - which is why it gets its own parser
 * rather than being folded into one of the others.
 */
function casesUpdateSetColumns(): string[] {
  return sharedCasesUpdateSetColumns(source, 'updateCase');
}

describe('cases repository public.cases statements', () => {
  it('finds the migration-added columns, so the derivation cannot pass vacuously', () => {
    // If this ever legitimately drops to zero, every guard below stops guarding.
    expect(migrationAddedCasesColumns()).toContain('priority');
  });

  it('parses a plausible createCase insert list, so a failed regex cannot pass vacuously', () => {
    expect(casesInsertColumns().length).toBeGreaterThan(10);
    expect(casesInsertColumns()).toContain('case_id');
  });

  it('parses a plausible updateCase set list, so a failed regex cannot pass vacuously', () => {
    expect(casesUpdateSetColumns().length).toBeGreaterThan(10);
    expect(casesUpdateSetColumns()).toContain('title');
  });

  it('derives the full public.cases column set, so no guard below can pass vacuously', () => {
    const all = allCasesColumns();
    expect(all.length).toBeGreaterThan(15);
    expect(all).toContain('case_id');
    expect(all).toContain('outcome_note');
    expect(all).toContain('priority');
  });

  it('createCase writes every public.cases column', () => {
    const missing = missingFrom('createCase', casesInsertColumns());
    expect(missing, `createCase does not write public.cases column(s): ${missing.join(', ')}`).toEqual([]);
  });

  // This only proves the column list and the VALUES tuple are the same length,
  // not that they are in the same order. Two entries transposed in one list but
  // not the other (e.g. `source` and `priority` swapped in the column list)
  // keeps the counts equal, keeps every guard above green, and writes every
  // value into the wrong column - both are `text`, so Postgres raises nothing.
  // That transposition risk is not covered by this test.
  it('createCase supplies exactly one value per inserted column', () => {
    expect(casesInsertValueCount()).toBe(casesInsertColumns().length);
  });

  it('updateCase writes every public.cases column', () => {
    const missing = missingFrom('updateCase', casesUpdateSetColumns());
    expect(missing, `updateCase does not write public.cases column(s): ${missing.join(', ')}`).toEqual([]);
  });

  it('getCase selects every public.cases column', () => {
    const missing = missingFrom('getCase', selectColumns('getCase', 'cases'));
    expect(missing, `getCase does not select public.cases column(s): ${missing.join(', ')}`).toEqual([]);
  });

  it('listCases selects every public.cases column', () => {
    const missing = missingFrom('listCases', selectColumns('listCases', 'cases'));
    expect(missing, `listCases does not select public.cases column(s): ${missing.join(', ')}`).toEqual([]);
  });

  it('writes no column outside the table (typo guard)', () => {
    const all = allCasesColumns();
    for (const [name, carried] of [
      ['createCase', casesInsertColumns()],
      ['updateCase', casesUpdateSetColumns()]
    ] as const) {
      const unknown = carried.filter((c) => !all.includes(c));
      expect(unknown, `${name} names column(s) that do not exist: ${unknown.join(', ')}`).toEqual([]);
    }
  });
});

describe('cases repository case_attachments statements', () => {
  it('parses a plausible column list from the migration, so a failed regex cannot pass vacuously', () => {
    const { all } = caseAttachmentsColumns();
    expect(all.length).toBeGreaterThan(3);
    expect(all).toContain('activity_id');
  });

  it('parses a plausible column list from createAttachments, so a failed regex cannot pass vacuously', () => {
    expect(dbHelperColumns('createAttachments').length).toBeGreaterThan(3);
  });

  it('createAttachments writes every insertable case_attachments column', () => {
    const written = dbHelperColumns('createAttachments');
    const { insertable } = caseAttachmentsColumns();
    const missing = insertable.filter((c) => !written.includes(c));
    expect(missing, `createAttachments does not write case_attachments column(s): ${missing.join(', ')}`).toEqual([]);
  });

  it('createAttachments writes no column outside the table (typo guard)', () => {
    const written = dbHelperColumns('createAttachments');
    const { insertable } = caseAttachmentsColumns();
    const unknown = written.filter((c) => !insertable.includes(c));
    expect(unknown, `createAttachments writes unknown column(s): ${unknown.join(', ')}`).toEqual([]);
  });

  it('listAttachmentsByCase selects every case_attachments column', () => {
    const selected = selectColumns('listAttachmentsByCase', 'case_attachments');
    const { all } = caseAttachmentsColumns();
    const missing = all.filter((c) => !selected.includes(c));
    expect(missing, `listAttachmentsByCase does not select case_attachments column(s): ${missing.join(', ')}`).toEqual([]);
  });
});

describe('cases repository activity_log statements', () => {
  it('parses a plausible column list, so a failed regex cannot pass vacuously', () => {
    expect(insertColumns().length).toBeGreaterThan(3);
  });

  it('finds the migration-added columns, so the derivation cannot pass vacuously', () => {
    // If this ever legitimately drops to zero, the guard below stops guarding.
    expect(migrationAddedActivityLogColumns()).toContain('note');
  });

  it('logActivity writes every column a migration added to activity_log', () => {
    const written = insertColumns();
    const missing = migrationAddedActivityLogColumns().filter((c) => !written.includes(c));
    expect(
      missing,
      `logActivity does not write activity_log column(s) added by a migration: ${missing.join(', ')}`
    ).toEqual([]);
  });

  it('logActivity supplies exactly one value per inserted column', () => {
    expect(insertValueCount()).toBe(insertColumns().length);
  });

  it('listActivityByEntity selects every column a migration added to activity_log', () => {
    // Assert against the SELECT list only. Matching the whole method body is
    // vacuous: the row type and the `note: row.note ?? ''` mapper both mention
    // the column, so dropping it from the SELECT would still have passed while
    // silently returning undefined at runtime.
    const selected = selectColumns('listActivityByEntity', 'activity_log');
    const missing = migrationAddedActivityLogColumns().filter((c) => !selected.includes(c));
    expect(
      missing,
      `listActivityByEntity does not select activity_log column(s) added by a migration: ${missing.join(', ')}`
    ).toEqual([]);
  });
});
