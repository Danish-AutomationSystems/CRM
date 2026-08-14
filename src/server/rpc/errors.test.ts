import { describe, expect, it } from 'vitest';

import { normalizeRpcError } from './errors';

describe('normalizeRpcError', () => {
  it('surfaces the handover-note-too-long message to the user with a 400-class status', () => {
    const error = new Error('That handover note is too long - please keep it under 2000 characters.');

    const normalized = normalizeRpcError(error);

    expect(normalized.message).toBe('That handover note is too long - please keep it under 2000 characters.');
    expect(normalized.status).toBe(400);
    expect(normalized.status).toBeLessThan(500);
  });

  it('does not leak unrelated internal error text', () => {
    const error = new Error('connection terminated unexpectedly at db pool');

    const normalized = normalizeRpcError(error);

    expect(normalized.message).toBe('Something went wrong.');
    expect(normalized.status).toBe(500);
  });
});
