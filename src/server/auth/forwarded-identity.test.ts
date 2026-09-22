import { describe, expect, it } from 'vitest';

import { getRequestContext } from './context';

const USER_ROW = {
  email: 'danish@automationsystems.org',
  name: 'Danish',
  role: 'L4',
  allowed_tags: ['*'],
  active: true
};

describe('forwarded identity', () => {
  it('uses the forwarded header without a network auth call', async () => {
    let networkCalls = 0;
    const request = new Request('https://crm.test/api/rpc', {
      headers: { 'x-crm-user-email': 'danish@automationsystems.org' }
    });

    const context = await getRequestContext(request, {
      getAuthenticatedEmail: async () => {
        networkCalls += 1;
        return 'danish@automationsystems.org';
      },
      lookupUser: async () => USER_ROW
    });

    expect(context.email).toBe('danish@automationsystems.org');
    expect(networkCalls).toBe(0);
  });

  it('falls back to the network call when the header is absent', async () => {
    let networkCalls = 0;
    const request = new Request('https://crm.test/api/rpc');

    const context = await getRequestContext(request, {
      getAuthenticatedEmail: async () => {
        networkCalls += 1;
        return 'danish@automationsystems.org';
      },
      lookupUser: async () => USER_ROW
    });

    expect(context.email).toBe('danish@automationsystems.org');
    expect(networkCalls).toBe(1);
  });

  it('rejects a blank forwarded header rather than trusting it', async () => {
    const request = new Request('https://crm.test/api/rpc', {
      headers: { 'x-crm-user-email': '   ' }
    });

    await expect(
      getRequestContext(request, {
        getAuthenticatedEmail: async () => null,
        lookupUser: async () => USER_ROW
      })
    ).rejects.toThrow('Sign in to AS CRM.');
  });
});
