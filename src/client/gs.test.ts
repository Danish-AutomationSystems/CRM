import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { gs } from './gs';

describe('gs', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json({
          ok: true,
          data: { booted: true }
        })
      )
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    globalThis.fetch = originalFetch;
  });

  it('posts an Apps Script-style function call envelope and returns data', async () => {
    await expect(gs('api_bootstrap', 'first', 2)).resolves.toEqual({ booted: true });

    expect(fetch).toHaveBeenCalledWith('/api/rpc', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fn: 'api_bootstrap', args: ['first', 2] })
    });
  });

  it('throws the safe server error message on RPC failure responses', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      Response.json({
        ok: false,
        error: 'Sign in to AS CRM.'
      })
    );

    await expect(gs('api_bootstrap')).rejects.toThrow('Sign in to AS CRM.');
  });

  it('marks mutating responses for cache busting without changing returned data', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      Response.json({
        ok: true,
        data: { saved: ['CUST-0001'] },
        metadata: { bustClientCache: true }
      })
    );

    const result = await gs('api_saveCustomerCells', [{ id: 'CUST-0001', fields: { area: 'NCR' } }]);

    expect(result).toEqual({ saved: ['CUST-0001'] });
    expect(gs.lastCallBustsClientCache).toBe(true);
  });
});
