import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  casesInsertColumns as sharedCasesInsertColumns,
  casesUpdateSetColumns as sharedCasesUpdateSetColumns,
  insertValueCount as sharedInsertValueCount,
  missingFrom as sharedMissingFrom,
  selectColumns as sharedSelectColumns,
  splitTopLevel
} from '../db/cases-columns.test-helpers';

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

function insertColumns(): string[] {
  const body = methodBody('createQuote');
  const match = /insert into public\.quotations\s*\(([\s\S]*?)\)\s*values/i.exec(body);
  expect(match, 'could not parse the createQuote insert column list').not.toBeNull();
  return splitTopLevel(match![1]).map((column) => column.toLowerCase());
}

function insertValueCount(): number {
  return sharedInsertValueCount(source, 'createQuote', 'quotations');
}

function selectColumns(methodName: string): string[];
function selectColumns(methodName: string, table: string): string[];
function selectColumns(methodName: string, table?: string): string[] {
  if (table) return sharedSelectColumns(source, methodName, table);

  const body = methodBody(methodName);
  const match = /select\s+([\s\S]*?)\s+from public\.quotations/i.exec(body);
  expect(match, `could not parse the ${methodName} select list`).not.toBeNull();
  return splitTopLevel(match![1]).map((item) => {
    const aliased = /\bas\s+([a-z_][a-z0-9_]*)\s*$/i.exec(item);
    const name = (aliased ? aliased[1] : item).trim().toLowerCase();
    return SELECT_ALIAS_TO_COLUMN[name] ?? name;
  });
}

/**
 * public.cases column-parity helpers, reused (not copied) from
 * src/server/cases/repository.test.ts via src/server/db/cases-columns.test-helpers.ts.
 *
 * This repository carries its own independent getCase/createCase/updateCase
 * trio against public.cases, structurally identical to the ones guarded there
 * and otherwise invisible to that guard.
 */
const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'supabase', 'migrations');

function quotesInsertColumns(): string[] {
  return sharedCasesInsertColumns(source, 'createCase');
}

function quotesUpdateSetColumns(): string[] {
  return sharedCasesUpdateSetColumns(source, 'updateCase');
}

function quotesCasesInsertValueCount(): number {
  return sharedInsertValueCount(source, 'createCase', 'cases');
}

function missingFrom(statement: string, carried: string[]): string[] {
  return sharedMissingFrom(migrationsDir, `quotes.${statement}`, carried);
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

describe('quotes repository public.cases statements', () => {
  it('parses a plausible column list from each statement, so a failed regex cannot pass vacuously', () => {
    expect(quotesInsertColumns().length).toBeGreaterThan(10);
    expect(quotesUpdateSetColumns().length).toBeGreaterThan(10);
    expect(selectColumns('getCase', 'cases').length).toBeGreaterThan(10);
  });

  it('createCase writes every public.cases column', () => {
    const missing = missingFrom('createCase', quotesInsertColumns());
    expect(missing, `quotes createCase does not write public.cases column(s): ${missing.join(', ')}`).toEqual([]);
  });

  // This only proves the column list and the VALUES tuple are the same length,
  // not that they are in the same order. Two entries transposed in one list but
  // not the other (e.g. `source` and `priority` swapped in the column list)
  // keeps the counts equal, keeps every guard above green, and writes every
  // value into the wrong column - both are `text`, so Postgres raises nothing.
  // That transposition risk is not covered by this test.
  it('createCase supplies exactly one value per inserted column', () => {
    expect(quotesCasesInsertValueCount()).toBe(quotesInsertColumns().length);
  });

  it('updateCase writes every public.cases column', () => {
    const missing = missingFrom('updateCase', quotesUpdateSetColumns());
    expect(missing, `quotes updateCase does not write public.cases column(s): ${missing.join(', ')}`).toEqual([]);
  });

  it('getCase selects every public.cases column', () => {
    const missing = missingFrom('getCase', selectColumns('getCase', 'cases'));
    expect(missing, `quotes getCase does not select public.cases column(s): ${missing.join(', ')}`).toEqual([]);
  });
});
