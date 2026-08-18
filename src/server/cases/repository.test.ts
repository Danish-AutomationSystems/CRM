import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const source = fs.readFileSync(path.join(__dirname, 'repository.ts'), 'utf8');

function methodBody(name: string): string {
  const start = source.indexOf(`async ${name}(`);
  if (start === -1) throw new Error(`method ${name} not found in repository.ts`);
  const next = source.indexOf('\n  async ', start + 1);
  return source.slice(start, next === -1 ? source.length : next);
}

function insertColumns(): string[] {
  const body = methodBody('logActivity');
  const match = body.match(/insert into public\.activity_log \(([^)]*)\)/);
  if (!match) throw new Error('logActivity insert column list not found');
  return match[1].split(',').map((c) => c.trim()).filter(Boolean);
}

function selectColumns(method: string, table: string): string[] {
  const body = methodBody(method);
  const match = body.match(new RegExp(`select ([\\s\\S]*?)\\s+from public\\.${table}\\b`));
  if (!match) throw new Error(`${method} select list not found`);
  return match[1].split(',').map((c) => c.trim()).filter(Boolean);
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
  const dir = path.join(__dirname, '..', '..', '..', 'supabase', 'migrations');
  const names = new Set<string>();

  const initial = fs.readFileSync(path.join(dir, '0001_initial_schema.sql'), 'utf8');
  const created = initial.match(/create table if not exists public\.cases \(([\s\S]*?)\n\);/);
  if (!created) throw new Error('public.cases CREATE TABLE not found');
  // Table-level constraints can span multiple lines (e.g. a multi-line `check (...)`),
  // and a continuation line - "or (order_value is not null ...)" - starts with a bare
  // word that would otherwise look exactly like a column definition. Once a
  // constraint/primary key/unique/check/foreign key clause opens, every line is
  // skipped by tracking paren depth until it closes back to zero, not just the
  // clause's first line.
  let depth = 0;
  let inConstraint = false;
  for (const line of created[1].split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (!inConstraint) {
      if (/^(constraint|primary key|unique|check|foreign key)\b/i.test(trimmed)) {
        inConstraint = true;
      } else {
        const name = trimmed.split(/\s+/)[0].replace(/,$/, '');
        if (/^[a-z_][a-z0-9_]*$/.test(name)) names.add(name);
      }
    }
    if (inConstraint) {
      for (const ch of trimmed) {
        if (ch === '(') depth += 1;
        else if (ch === ')') depth -= 1;
      }
      if (depth <= 0) {
        inConstraint = false;
        depth = 0;
      }
    }
  }

  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
    const migrationSql = fs.readFileSync(path.join(dir, file), 'utf8');
    const statements = migrationSql.matchAll(/alter\s+table\s+(?:only\s+)?public\.cases\b([\s\S]*?);/gi);
    for (const statement of statements) {
      const adds = statement[1].matchAll(/add\s+column\s+(?:if\s+not\s+exists\s+)?"?([a-z_][a-z0-9_]*)"?/gi);
      for (const add of adds) names.add(add[1].toLowerCase());
    }
  }

  return [...names].sort();
}

/**
 * Columns a given statement is allowed NOT to carry, each with a reason.
 *
 * Every entry here is a deliberate, reviewed exemption. Adding to this list is
 * how the guard gets weakened, so an entry without a reason is a defect.
 */
const CASES_EXEMPT: Record<string, Record<string, string>> = {
  // createCase does not name `version`: the column defaults to 1.
  createCase: { version: 'defaults to 1 on insert' },
  // updateCase identifies the row by case_id and must never rewrite creation facts.
  updateCase: {
    case_id: 'the WHERE key, never in the SET clause',
    customer_id: 'creation fact, immutable - no service path reassigns a case to another customer',
    created_by: 'creation fact, immutable',
    created_at: 'creation fact, immutable'
  },
  // version is an internal optimistic-lock counter (bumped by updateCase) that is
  // never surfaced on CaseRow - CaseDbRow has no `version` field and nothing reads
  // it back. Pre-existing gap, unrelated to priority; discovered while wiring this
  // guard because the column parser correctly includes `version` as a real column.
  getCase: { version: 'internal optimistic-lock counter, not exposed on CaseRow' },
  listCases: { version: 'internal optimistic-lock counter, not exposed on CaseRow' }
};

function missingFrom(statement: string, carried: string[]): string[] {
  const exempt = CASES_EXEMPT[statement];
  return allCasesColumns().filter((c) => !carried.includes(c) && !(c in exempt));
}

/**
 * Columns added to public.cases by a migration after the initial schema.
 * Kept as a separate, narrower derivation purely to prove the guard above is
 * live: if this ever returns nothing, the migration parsing has broken.
 */
function migrationAddedCasesColumns(): string[] {
  const dir = path.join(__dirname, '..', '..', '..', 'supabase', 'migrations');
  const names = new Set<string>();

  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
    const migrationSql = fs.readFileSync(path.join(dir, file), 'utf8');
    const statements = migrationSql.matchAll(/alter\s+table\s+(?:only\s+)?public\.cases\b([\s\S]*?);/gi);
    for (const statement of statements) {
      const adds = statement[1].matchAll(/add\s+column\s+(?:if\s+not\s+exists\s+)?"?([a-z_][a-z0-9_]*)"?/gi);
      for (const add of adds) names.add(add[1].toLowerCase());
    }
  }

  return [...names].sort();
}

function casesInsertColumns(): string[] {
  const body = methodBody('createCase');
  const match = body.match(/insert into public\.cases \(([^)]*)\)/);
  if (!match) throw new Error('createCase insert column list not found');
  return match[1].split(',').map((c) => c.trim()).filter(Boolean);
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
  const body = methodBody('updateCase');
  const match = body.match(/update public\.cases\s*\n\s*set\b([\s\S]*?)\bwhere\b/);
  if (!match) throw new Error('updateCase set clause not found');
  return [...match[1].matchAll(/(?:^|,)\s*([a-z_][a-z0-9_]*)\s*=/gi)].map((m) => m[1].toLowerCase());
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
