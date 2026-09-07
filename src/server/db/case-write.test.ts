import { describe, expect, it } from 'vitest';
import { buildCaseWriteSql, caseWritePatch } from './case-write';

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
