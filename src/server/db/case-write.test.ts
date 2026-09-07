import { describe, expect, it } from 'vitest';
import { caseWritePatch } from './case-write';

describe('caseWritePatch', () => {
  it('retains only supplied mutable fields so unrelated workflow state is never reconstructed', () => {
    expect(caseWritePatch({ title: 'New title', assignee: undefined, version: 1 } as never)).toEqual({ title: 'New title' });
  });
});
