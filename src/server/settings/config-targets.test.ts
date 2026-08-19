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

/**
 * The `text` vs `text[]` shape of each column, as the migrations actually leave
 * it - so a RENAME_TARGETS entry can be checked against the real column type,
 * not just its existence.
 *
 * customers.sei and recycle_bin.sei are `text` in the initial CREATE TABLE and
 * become `text[]` only via 0008_customer_sei_multi_select.sql's `alter column
 * ... type text[]`; reading only the CREATE TABLE would report them as scalar
 * and miss exactly the kind of drift this derivation exists to catch.
 */
function derivedColumnTypes(): Map<string, 'array' | 'text' | 'other'> {
  const files = fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((name) => name.endsWith('.sql'))
    .sort();
  const sql = files.map((name) => fs.readFileSync(path.join(MIGRATIONS_DIR, name), 'utf8')).join('\n');

  const types = new Map<string, 'array' | 'text' | 'other'>();
  const typeOf = (raw: string): 'array' | 'text' | 'other' =>
    raw === 'text[]' ? 'array' : raw === 'text' ? 'text' : 'other';

  const NOT_A_COLUMN = /^(constraint|primary|unique|check|foreign|exclude|like)$/;

  const createTable = /create\s+table\s+(?:if\s+not\s+exists\s+)?public\.(\w+)\s*\(([\s\S]*?)\n\);/g;
  for (const match of sql.matchAll(createTable)) {
    const table = match[1];
    for (const line of match[2].split('\n')) {
      const column = /^ {2}(\w+)\s+(text\[\]|text|\S+)/.exec(line);
      if (column && !NOT_A_COLUMN.test(column[1])) {
        types.set(`${table}.${column[1]}`, typeOf(column[2]));
      }
    }
  }

  const addColumn =
    /alter\s+table\s+(?:only\s+)?public\.(\w+)\s+add\s+column\s+(?:if\s+not\s+exists\s+)?(\w+)\s+(text\[\]|text|\S+)/gi;
  for (const match of sql.matchAll(addColumn)) {
    types.set(`${match[1]}.${match[2]}`, typeOf(match[3]));
  }

  // A later `alter column ... type` overrides whatever CREATE TABLE or a
  // previous ADD COLUMN said, exactly as it does in Postgres.
  const alterType =
    /alter\s+table\s+(?:only\s+)?public\.(\w+)\s+alter\s+column\s+(\w+)\s+type\s+(text\[\]|text|\S+)/gi;
  for (const match of sql.matchAll(alterType)) {
    types.set(`${match[1]}.${match[2]}`, typeOf(match[3]));
  }

  return types;
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

  it('derives sei as text[] only after the 0008 multi-select migration, not from the initial schema alone', () => {
    // Guards derivedColumnTypes itself: customers.sei is `text` in
    // 0001_initial_schema.sql and only becomes `text[]` via 0008's
    // `alter column sei type text[]`. Stopping at CREATE TABLE would call it
    // scalar and defeat the type check below.
    const types = derivedColumnTypes();

    expect(types.get('customers.sei')).toBe('array');
    expect(types.get('recycle_bin.sei')).toBe('array');
  });

  it('maps every kind: array target to an actual text[] column', () => {
    // An `array` target on a plain `text` column passes the map test (the
    // column exists) and then fails at runtime with
    // "function array_replace(text, text, text) does not exist" mid-transaction,
    // during a rename. The rollback makes it loud rather than silent, but it is
    // avoidable: the derivation already parses each column's declared type.
    const types = derivedColumnTypes();

    for (const targets of Object.values(RENAME_TARGETS)) {
      for (const target of targets) {
        if (target.kind !== 'array') continue;
        expect(
          types.get(`${target.table}.${target.column}`),
          `${target.table}.${target.column} is kind: 'array' but is not a text[] column`
        ).toBe('array');
      }
    }
  });

  it('maps every kind: scalar or pipe target to a plain text column, not text[]', () => {
    // The inverse mistake: a scalar/pipe target on a text[] column would fail
    // string_to_array/string_agg (pipe) or the plain `=` comparison (scalar) at
    // runtime instead of at CREATE-TABLE-derivation time.
    const types = derivedColumnTypes();

    for (const targets of Object.values(RENAME_TARGETS)) {
      for (const target of targets) {
        if (target.kind === 'array') continue;
        expect(
          types.get(`${target.table}.${target.column}`),
          `${target.table}.${target.column} is kind: '${target.kind}' but is a text[] column`
        ).toBe('text');
      }
    }
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

  it('matches a pipe element with a tab beside the separator, not just a space', () => {
    // Only reachable from data not written by joinPipe (which always writes
    // ' | ') - a hand-edited row or a legacy import. parsePipe's JS .trim()
    // strips tabs; the SQL btrim must strip the same characters or it silently
    // disagrees with this reference function about whether anything changed.
    expect(renamePipe('VFDs\t|\tPLC', 'PLC', 'PLCs')).toBe('VFDs | PLCs');
    expect(renamePipe('VFDs |\nPLC', 'PLC', 'PLCs')).toBe('VFDs | PLCs');
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
    expect(body).toContain('btrim(part, E\' \\t\\r\\n\') = ${oldValue}');
  });

  it('btrim strips tabs, carriage returns and newlines, not just ASCII spaces', () => {
    // One-argument btrim(part) strips ASCII spaces only. parsePipe's JS .trim()
    // (domain/lists.ts:16) also strips tabs, CRs and newlines, so a hand-edited
    // or legacy-imported row with a tab beside a separator would let the SQL and
    // the JS reference function (renamePipe, used by the fake repo in the
    // service tests) disagree about whether a rewrite happened at all.
    // Scoped to the SQL template literals only, so the word "btrim(part)" inside
    // the surrounding explanatory comment does not get mistaken for SQL.
    const sqlBlocks = [...body.matchAll(/this\.db`([\s\S]*?)`/g)].map((match) => match[1]);
    expect(sqlBlocks.length).toBeGreaterThan(0);
    const btrimCalls = sqlBlocks
      .join('\n')
      .matchAll(/btrim\(([^)]*)\)/g);
    const calls = [...btrimCalls].map((match) => match[1]);
    expect(calls.length).toBeGreaterThan(0);
    for (const args of calls) {
      expect(args, `btrim(${args}) does not strip tabs/CR/LF`).toContain("E' \\t\\r\\n'");
    }
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

/**
 * PostgresAdminRepository.lockSetting cannot be run against a real Postgres from
 * this suite either, so its one load-bearing property - that it actually takes a
 * row lock rather than a plain SELECT - is checked against the source. A `for
 * update` typo or an accidental revert to a bare `select` would compile and pass
 * every in-memory fake test, since the fakes cannot distinguish a locking read
 * from a non-locking one; only this guards it.
 */
describe('the SQL that implements lockSetting', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'admin', 'service.ts'), 'utf8');
  // Bound by the NEXT method, not a named one: see the renameConfigValue block
  // above for why a name that also occurs earlier (e.g. in the AdminRepository
  // interface) makes the slice run backwards and every assertion pass vacuously.
  const start = source.indexOf('  async lockSetting(');
  const next = source.indexOf('\n  async ', start + 1);
  const body = start === -1 ? '' : source.slice(start, next === -1 ? source.length : next);

  it('was found in the repository', () => {
    expect(body.length).toBeGreaterThan(0);
    expect(body).toContain('select value from public.settings');
  });

  it('takes a row lock rather than a plain read', () => {
    expect(body).toMatch(/for update/i);
  });
});
