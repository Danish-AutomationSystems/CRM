import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { buildCaseWriteSql, caseWritePatch } from './case-write';
import { allCasesColumns, missingFrom } from './cases-columns.test-helpers';

describe('caseWritePatch', () => {
  it('retains only supplied mutable fields so unrelated workflow state is never reconstructed', () => {
    expect(caseWritePatch({ title: 'New title', assignee: undefined, version: 1 } as never)).toEqual({ title: 'New title' });
  });

  it('builds a parameterized update for only supplied fields plus version', () => {
    expect(buildCaseWriteSql('CASE-1', { title: 'Renamed', priority: 'High' })).toEqual({
      query: 'update public.cases set title = $1, priority = $2, version = version + 1 where case_id = $3',
      values: ['Renamed', 'High', 'CASE-1']
    });
  });
});

/**
 * cases/repository.ts and quotes/repository.ts both delegate their getCase,
 * lockCase, createCase and updateCase to the single implementation here -
 * these guards replace the equivalent, now-removed per-repository checks that
 * used to read the SQL text out of each repository file directly.
 */
const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'case-write.ts'), 'utf8');
const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'supabase', 'migrations');

function functionBody(name: string): string {
  const start = source.indexOf(`export async function ${name}(`);
  if (start === -1) throw new Error(`function ${name} not found in case-write.ts`);
  const next = source.indexOf('\nexport ', start + 1);
  return source.slice(start, next === -1 ? source.length : next);
}

function insertCaseColumns(): string[] {
  const body = functionBody('insertCaseRow');
  const match = body.match(/insert into public\.cases \(([^)]*)\)/);
  if (!match) throw new Error('insertCaseRow insert column list not found');
  return match[1].split(',').map((c) => c.trim()).filter(Boolean);
}

function selectCaseColumns(name: 'selectCaseRow' | 'selectCaseRowForUpdate'): string[] {
  const body = functionBody(name);
  const match = body.match(/select ([\s\S]*?)\s+from public\.cases\b/);
  if (!match) throw new Error(`${name} select list not found`);
  return match[1].split(',').map((c) => c.trim()).filter(Boolean);
}

describe('case-write public.cases statements', () => {
  it('parses a plausible column list from each statement, so a failed regex cannot pass vacuously', () => {
    expect(insertCaseColumns().length).toBeGreaterThan(10);
    expect(selectCaseColumns('selectCaseRow').length).toBeGreaterThan(10);
  });

  it('insertCaseRow writes every public.cases column', () => {
    const missing = missingFrom(migrationsDir, 'case-write.insertCaseRow', insertCaseColumns());
    expect(missing, `insertCaseRow does not write public.cases column(s): ${missing.join(', ')}`).toEqual([]);
  });

  it('selectCaseRow selects every public.cases column', () => {
    const missing = missingFrom(migrationsDir, 'case-write.selectCaseRow', selectCaseColumns('selectCaseRow'));
    expect(missing, `selectCaseRow does not select public.cases column(s): ${missing.join(', ')}`).toEqual([]);
  });

  it('selectCaseRowForUpdate reads the same columns as selectCaseRow', () => {
    expect(selectCaseColumns('selectCaseRowForUpdate')).toEqual(selectCaseColumns('selectCaseRow'));
  });

  it('writes no column outside the table (typo guard)', () => {
    const all = allCasesColumns(migrationsDir);
    const unknown = insertCaseColumns().filter((c) => !all.includes(c));
    expect(unknown, `insertCaseRow names column(s) that do not exist: ${unknown.join(', ')}`).toEqual([]);
  });
});
