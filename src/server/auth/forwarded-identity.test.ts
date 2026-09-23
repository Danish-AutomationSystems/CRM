import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { getRequestContext } from './context';
import { signIdentity } from './identity-signature';

const USER_ROW = {
  email: 'danish@automationsystems.org',
  name: 'Danish',
  role: 'L4',
  allowed_tags: ['*'],
  active: true
};

const SECRET = 'test-identity-secret';

describe('forwarded identity', () => {
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

  describe('with a signing secret configured', () => {
    const ORIGINAL_SECRET = process.env.CRM_IDENTITY_SECRET;

    beforeEach(() => {
      process.env.CRM_IDENTITY_SECRET = SECRET;
    });

    afterEach(() => {
      if (ORIGINAL_SECRET === undefined) {
        delete process.env.CRM_IDENTITY_SECRET;
      } else {
        process.env.CRM_IDENTITY_SECRET = ORIGINAL_SECRET;
      }
    });

    it('accepts a correctly signed header without any network call', async () => {
      let networkCalls = 0;
      const signedHeader = await signIdentity('danish@automationsystems.org', SECRET);
      const request = new Request('https://crm.test/api/rpc', {
        headers: { 'x-crm-user-email': signedHeader }
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

    it('ignores an unsigned plain-email header and falls back to the network call (impersonation attempt)', async () => {
      let networkCalls = 0;
      let networkReturnedEmail: string | null = null;
      const request = new Request('https://crm.test/api/rpc', {
        // An attacker forges the header with a colleague's email but no valid signature.
        headers: { 'x-crm-user-email': 'attacker@automationsystems.org' }
      });

      const context = await getRequestContext(request, {
        getAuthenticatedEmail: async () => {
          networkCalls += 1;
          networkReturnedEmail = 'danish@automationsystems.org';
          return networkReturnedEmail;
        },
        lookupUser: async () => USER_ROW
      });

      expect(networkCalls).toBe(1);
      expect(context.email).toBe('danish@automationsystems.org');
      expect(context.email).not.toBe('attacker@automationsystems.org');
    });
  });

  describe('without a signing secret configured', () => {
    const ORIGINAL_SECRET = process.env.CRM_IDENTITY_SECRET;

    beforeEach(() => {
      delete process.env.CRM_IDENTITY_SECRET;
    });

    afterEach(() => {
      if (ORIGINAL_SECRET === undefined) {
        delete process.env.CRM_IDENTITY_SECRET;
      } else {
        process.env.CRM_IDENTITY_SECRET = ORIGINAL_SECRET;
      }
    });

    it('falls back to the network call even if the header looks signed', async () => {
      let networkCalls = 0;
      const signedHeader = await signIdentity('danish@automationsystems.org', SECRET);
      const request = new Request('https://crm.test/api/rpc', {
        headers: { 'x-crm-user-email': signedHeader }
      });

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
  });
});
