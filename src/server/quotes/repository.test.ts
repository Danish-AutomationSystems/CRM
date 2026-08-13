import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * Static guard against the "createQuote silently drops a column" defect class.
 *
 * Every existing test substitutes an in-memory FakeQuoteRepository, which spreads
 * an object and therefore cannot lose a column. The real insert enumerates its
 * columns by hand, and `drive_file_id`/`drive_view_link` are declared
 * `not null default ''`, so omitting them fails silently in production rather
 * than erroring. This test reads the SQL out of the source text - it never
 * connects to a database - and asserts that everything `getQuote` reads back is
 * something `createQuote` actually writes.
 */

const SOURCE_PATH = join(dirname(fileURLToPath(import.meta.url)), 'repository.ts');
const source = readFileSync(SOURCE_PATH, 'utf8');

/** Columns the select reads under a different name than the table column. */
const SELECT_ALIAS_TO_COLUMN: Record<string, string> = {
  upload_data_b64: 'upload_data'
};

/**
 * Columns that getQuote reads but createQuote is not expected to write, because
 * the database supplies them. Keep this list empty unless there is a real reason.
 */
const WRITE_EXEMPT_COLUMNS: string[] = [];

function methodBody(name: string): string {
  const start = source.indexOf(`async ${name}(`);
  expect(start, `could not find async ${name}( in repository.ts`).toBeGreaterThan(-1);
  const next = source.indexOf('\n  async ', start + 1);
  return source.slice(start, next === -1 ? source.length : next);
}

/** Split on commas that are not nested inside parentheses. */
function splitTopLevel(list: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = '';
  for (const char of list) {
    if (char === '(') depth += 1;
    if (char === ')') depth -= 1;
    if (char === ',' && depth === 0) {
      parts.push(current);
      current = '';
      continue;
    }
    current += char;
  }
  parts.push(current);
  return parts.map((part) => part.trim()).filter(Boolean);
}

function insertColumns(): string[] {
  const body = methodBody('createQuote');
  const match = /insert into public\.quotations\s*\(([\s\S]*?)\)\s*values/i.exec(body);
  expect(match, 'could not parse the createQuote insert column list').not.toBeNull();
  return splitTopLevel(match![1]).map((column) => column.toLowerCase());
}

function insertValueCount(): number {
  const body = methodBody('createQuote');
  const match = /values\s*\(([\s\S]*?)\)\s*`/i.exec(body);
  expect(match, 'could not parse the createQuote values list').not.toBeNull();
  return splitTopLevel(match![1]).length;
}

function selectColumns(methodName: string): string[] {
  const body = methodBody(methodName);
  const match = /select\s+([\s\S]*?)\s+from public\.quotations/i.exec(body);
  expect(match, `could not parse the ${methodName} select list`).not.toBeNull();
  return splitTopLevel(match![1]).map((item) => {
    const aliased = /\bas\s+([a-z_][a-z0-9_]*)\s*$/i.exec(item);
    const name = (aliased ? aliased[1] : item).trim().toLowerCase();
    return SELECT_ALIAS_TO_COLUMN[name] ?? name;
  });
}

describe('PostgresQuoteRepository SQL column coverage', () => {
  it('createQuote inserts every column that getQuote reads back', () => {
    const written = new Set(insertColumns());
    const read = selectColumns('getQuote');

    expect(read.length, 'parsed no columns from the getQuote select').toBeGreaterThan(20);

    const missing = read.filter((column) => !written.has(column) && !WRITE_EXEMPT_COLUMNS.includes(column));

    expect(
      missing,
      missing.length
        ? `createQuote does not insert ${missing.length} column(s) that getQuote reads: ${missing.join(', ')}. ` +
          'A column with a NOT NULL DEFAULT will silently persist the default instead of the value on the row ' +
          'passed to createQuote. Add it to both the column list and the values list of the insert in ' +
          'src/server/quotes/repository.ts.'
        : ''
    ).toEqual([]);
  });

  it('createQuote supplies exactly one value per inserted column', () => {
    expect(insertValueCount()).toBe(insertColumns().length);
  });

  it('createQuote writes the four Drive columns', () => {
    const written = new Set(insertColumns());
    for (const column of ['drive_file_id', 'drive_view_link', 'drive_saved_at', 'drive_saved_by']) {
      expect(written.has(column), `createQuote insert is missing ${column}`).toBe(true);
    }
  });

  it('getQuote and listQuotesByQuoteNo read the same columns', () => {
    expect(selectColumns('listQuotesByQuoteNo')).toEqual(selectColumns('getQuote'));
  });

  it('still reads upload_data so pre-Drive uploads remain downloadable', () => {
    expect(methodBody('getQuote')).toMatch(/encode\(upload_data, 'base64'\)/);
  });
});
