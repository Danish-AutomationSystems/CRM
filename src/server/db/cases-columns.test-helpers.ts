import fs from 'node:fs';
import path from 'node:path';

/**
 * Shared parsing helpers for the `public.cases` column-parity guards.
 *
 * Extracted from src/server/cases/repository.test.ts so that
 * src/server/quotes/repository.test.ts - which carries its own independent
 * getCase/createCase/updateCase trio against the same table - can reuse the
 * exact same parsers and exemption list rather than maintaining a second,
 * divergent copy. Every function here takes the repository source text (and,
 * where relevant, the migrations directory) as a parameter instead of reading
 * one hardcoded file, so it works unmodified against either repository.
 */

export function methodBody(source: string, name: string): string {
  const start = source.indexOf(`async ${name}(`);
  if (start === -1) throw new Error(`method ${name} not found in source`);
  const next = source.indexOf('\n  async ', start + 1);
  return source.slice(start, next === -1 ? source.length : next);
}

export function selectColumns(source: string, method: string, table: string): string[] {
  const body = methodBody(source, method);
  const match = body.match(new RegExp(`select ([\\s\\S]*?)\\s+from public\\.${table}\\b`));
  if (!match) throw new Error(`${method} select list not found`);
  return match[1].split(',').map((c) => c.trim()).filter(Boolean);
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
export function allCasesColumns(migrationsDir: string): string[] {
  const dir = migrationsDir;
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
export const CASES_EXEMPT: Record<string, Record<string, string>> = {
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

export function missingFrom(migrationsDir: string, statement: string, carried: string[]): string[] {
  const exempt = CASES_EXEMPT[statement];
  return allCasesColumns(migrationsDir).filter((c) => !carried.includes(c) && !(c in exempt));
}

/**
 * Columns added to public.cases by a migration after the initial schema.
 * Kept as a separate, narrower derivation purely to prove the guard above is
 * live: if this ever returns nothing, the migration parsing has broken.
 */
export function migrationAddedCasesColumns(migrationsDir: string): string[] {
  const dir = migrationsDir;
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

export function casesInsertColumns(source: string, methodName: string): string[] {
  const body = methodBody(source, methodName);
  const match = body.match(/insert into public\.cases \(([^)]*)\)/);
  if (!match) throw new Error(`${methodName} insert column list not found`);
  return match[1].split(',').map((c) => c.trim()).filter(Boolean);
}

/**
 * The left-hand side of every assignment in an updateCase-shaped `set` clause.
 *
 * updateCase is not an INSERT and not a SELECT: it merges `fields` over the
 * existing row and rewrites the full column list. A column missing here is
 * never written, and nothing errors - which is why it gets its own parser
 * rather than being folded into one of the others.
 */
export function casesUpdateSetColumns(source: string, methodName: string): string[] {
  const body = methodBody(source, methodName);
  const match = body.match(/update public\.cases\s*\n\s*set\b([\s\S]*?)\bwhere\b/);
  if (!match) throw new Error(`${methodName} set clause not found`);
  return [...match[1].matchAll(/(?:^|,)\s*([a-z_][a-z0-9_]*)\s*=/gi)].map((m) => m[1].toLowerCase());
}
