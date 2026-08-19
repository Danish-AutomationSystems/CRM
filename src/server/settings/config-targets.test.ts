import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { RENAME_TARGETS, renameArray, renamePipe, renameScalar } from './config-targets';

const MIGRATIONS_DIR = path.join(__dirname, '..', '..', '..', 'supabase', 'migrations');

/**
 * The schema as the migrations actually leave it, not as 0001 first wrote it.
 *
 * Reading only 0001 is the trap: cases.priority is added by 0011_case_priority.sql,
 * so a derivation that stops at the initial schema reports a real column as missing
 * and invites someone to delete the map entry that keeps case priorities in sync.
 * Every migration is read, and `alter table ... add column` counts as much as the
 * original CREATE TABLE.
 */
function derivedSchema(): Map<string, Set<string>> {
  const files = fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((name) => name.endsWith('.sql'))
    .sort();
  const sql = files.map((name) => fs.readFileSync(path.join(MIGRATIONS_DIR, name), 'utf8')).join('\n');

  const tables = new Map<string, Set<string>>();
  const columnsOf = (table: string): Set<string> => {
    const existing = tables.get(table);
    if (existing) return existing;
    const created = new Set<string>();
    tables.set(table, created);
    return created;
  };

  // Reserved words that open a table-level constraint rather than a column.
  const NOT_A_COLUMN = /^(constraint|primary|unique|check|foreign|exclude|like)$/;

  const createTable = /create\s+table\s+(?:if\s+not\s+exists\s+)?public\.(\w+)\s*\(([\s\S]*?)\n\);/g;
  for (const match of sql.matchAll(createTable)) {
    const columns = columnsOf(match[1]);
    for (const line of match[2].split('\n')) {
      // Exactly two spaces of indent: deeper lines are continuations inside a
      // multi-line check constraint, and their first word is not a column.
      const column = /^ {2}(\w+)\s/.exec(line);
      if (column && !NOT_A_COLUMN.test(column[1])) columns.add(column[1]);
    }
  }

  const addColumn = /alter\s+table\s+(?:only\s+)?public\.(\w+)\s+add\s+column\s+(?:if\s+not\s+exists\s+)?(\w+)/gi;
  for (const match of sql.matchAll(addColumn)) {
    columnsOf(match[1]).add(match[2]);
  }

  return tables;
}

describe('rename targets', () => {
  it('names only tables and columns that exist', () => {
    const schema = derivedSchema();

    for (const targets of Object.values(RENAME_TARGETS)) {
      for (const target of targets) {
        const columns = schema.get(target.table);
        expect(columns, `table public.${target.table} not found`).toBeTruthy();
        expect(columns?.has(target.column), `column ${target.table}.${target.column} not found`).toBe(true);
      }
    }
  });

  it('derives columns added by later migrations, not just the initial schema', () => {
    const schema = derivedSchema();

    // 0011_case_priority.sql, via `alter table ... add column`.
    expect(schema.get('cases')?.has('priority')).toBe(true);
    // 0001_initial_schema.sql, via CREATE TABLE.
    expect(schema.get('cases')?.has('won_categories')).toBe(true);
    // A table-level constraint is not a column.
    expect(schema.get('cases')?.has('constraint')).toBe(false);
  });

  it('covers users.allowed_tags for locations, which is access control', () => {
    expect(RENAME_TARGETS.TAGS).toContainEqual({ table: 'users', column: 'allowed_tags', kind: 'array' });
  });

  it('covers every column that stores a copy of a location', () => {
    expect([...RENAME_TARGETS.TAGS]).toEqual([
      { table: 'customers', column: 'tags', kind: 'array' },
      { table: 'users', column: 'allowed_tags', kind: 'array' },
      { table: 'recycle_bin', column: 'tags', kind: 'array' }
    ]);
  });

  it('treats won_categories as pipe-joined, not scalar', () => {
    // A scalar rewrite would replace substrings: the live list has both
    // 'Other' and 'Others', and 'Panels' alongside 'Switchgear'.
    expect(RENAME_TARGETS.CATEGORIES[0].kind).toBe('pipe');
  });
});

describe('rename semantics', () => {
  it('rewrites a scalar only on an exact, case-sensitive match', () => {
    expect(renameScalar('Punjab', 'Punjab', 'PUN')).toBe('PUN');
    expect(renameScalar('punjab', 'Punjab', 'PUN')).toBe('punjab');
    expect(renameScalar('Punjab East', 'Punjab', 'PUN')).toBe('Punjab East');
    expect(renameScalar('', 'Punjab', 'PUN')).toBe('');
  });

  it('rewrites only exact array elements and leaves the rest in place', () => {
    expect(renameArray(['Punjab', 'NCR'], 'Punjab', 'PUN')).toEqual(['PUN', 'NCR']);
    expect(renameArray(['Punjab East'], 'Punjab', 'PUN')).toEqual(['Punjab East']);
  });

  it('never rewrites the "*" wildcard in users.allowed_tags', () => {
    // users_star_tag_check (0001_initial_schema.sql:15) forbids '*' beside any
    // other tag, so a rewrite that touched '*' could not only revoke access, it
    // could make the row unwritable.
    expect(renameArray(['*'], 'Punjab', 'PUN')).toEqual(['*']);
    // '*' can never be the renamed-from value either - renameConfigItem rejects it
    // as reserved before any rewrite runs. That guard is tested in
    // src/server/admin/service.test.ts, since it lives in the service.
    expect(renameArray(['Punjab'], 'Punjab', 'PUN')).toEqual(['PUN']);
  });

  it('rewrites a pipe list element-wise, so neighbouring names survive', () => {
    // The live CATEGORIES list holds both 'Other' and 'Others', and 'Panels'
    // beside 'Switchgear'. A string replace would corrupt the neighbours.
    expect(renamePipe('VFDs | Other | Others', 'Other', 'Misc')).toBe('VFDs | Misc | Others');
    expect(renamePipe('Panels | Switchgear', 'Panels', 'Boards')).toBe('Boards | Switchgear');
  });

  it('matches pipe elements after trimming, because the write format has spaces', () => {
    // joinPipe writes ' | ' (domain/lists.ts:27) but parsePipe splits on '|' and
    // trims (:16). An untrimmed exact match would find nothing at all.
    expect(renamePipe('VFDs | PLC', 'PLC', 'PLCs')).toBe('VFDs | PLCs');
    expect(renamePipe('VFDs|PLC', 'PLC', 'PLCs')).toBe('VFDs | PLCs');
  });

  it('preserves element order in a pipe list', () => {
    expect(renamePipe('A | B | C | D | E', 'C', 'Z')).toBe('A | B | Z | D | E');
    expect(renamePipe('E | D | C | B | A', 'C', 'Z')).toBe('E | D | Z | B | A');
  });

  it('drops empty pipe elements rather than emitting a stray separator', () => {
    expect(renamePipe('VFDs |  | PLC', 'PLC', 'PLCs')).toBe('VFDs | PLCs');
    expect(renamePipe('', 'PLC', 'PLCs')).toBe('');
  });
});

/**
 * The SQL in PostgresAdminRepository.renameConfigValue cannot be executed here -
 * these tests never touch a database - so the properties that would only show up
 * against live data are asserted against the source instead. Each one stands for a
 * failure that is silent rather than loud: a substring rewrite that corrupts a
 * neighbouring category, an aggregate that reshuffles a list, an identifier pasted
 * into SQL text.
 */
describe('the SQL that implements a rename', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'admin', 'service.ts'),
    'utf8'
  );
  // Bound the slice by the NEXT method after this one, not by a named method:
  // `indexOf('async listUsers(')` matched that name's first occurrence in the
  // AdminRepository interface near the top of the file - before renameConfigValue -
  // so the slice ran backwards and yielded an empty string, making every assertion
  // below pass vacuously against ''. Same technique as methodBody() in
  // src/server/db/cases-columns.test-helpers.ts.
  const start = source.indexOf('  async renameConfigValue(');
  const next = source.indexOf('\n  async ', start + 1);
  const body = start === -1 ? '' : source.slice(start, next === -1 ? source.length : next);

  it('was found in the repository', () => {
    expect(body.length).toBeGreaterThan(0);
    expect(body).toContain('update ${table}');
  });

  it('replaces whole array elements rather than editing text', () => {
    expect(body).toContain('array_replace(');
  });

  it('compares pipe elements after btrim, since the stored format has spaces', () => {
    expect(body).toContain('btrim(part) = ${oldValue}');
  });

  it('keeps pipe elements in order when it re-joins them', () => {
    // string_agg over an unnest has no guaranteed input order without these.
    expect(body).toContain('with ordinality');
    expect(body).toMatch(/order by position/);
  });

  it('re-joins pipe elements in joinPipe\'s format', () => {
    expect(body).toContain("' | '");
  });

  it('interpolates the table and column only through the driver identifier helper', () => {
    // postgres.js turns a bare string argument into an escaped, quoted Identifier
    // (postgres/src/types.js escapeIdentifier); everything else in a tagged
    // template is a bound parameter. Reaching for either name any other way would
    // mean building SQL text, which is how injection gets in - the frozen map is a
    // convention, and conventions are not a defence.
    const references = [...body.matchAll(/target\.(table|column)/g)];
    expect(references.length).toBeGreaterThan(0);

    for (const reference of references) {
      const line = body.slice(0, reference.index).split('\n').pop() ?? '';
      expect(line, `target.${reference[1]} used outside this.db(...)`).toContain('this.db(');
    }

    expect(body).not.toContain('unsafe(');
  });
});
