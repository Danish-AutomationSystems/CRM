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
  const match = body.match(/values \(([\s\S]*?)\)\s*`/);
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
