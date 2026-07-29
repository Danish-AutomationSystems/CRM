import { describe, expect, it } from 'vitest';

import {
  assertAllowedDomain,
  getRequestContext,
  normalizeCrmRole,
  requireActiveCrmUser,
  type CrmUserRow,
  type UserProvisioner,
  type UserLookup
} from './context';

function userLookup(rows: CrmUserRow[]): UserLookup {
  return async (email: string) => rows.find((row) => row.email === email) ?? null;
}

function userProvisioner(rows: CrmUserRow[]): UserProvisioner {
  return async (email: string) => {
    const user: CrmUserRow = {
      email,
      name: email,
      role: 'L1',
      allowed_tags: [],
      active: true
    };
    rows.push(user);
    return user;
  };
}

describe('assertAllowedDomain', () => {
  it('allows automationsystems.org email addresses', () => {
    expect(() => assertAllowedDomain('User@AutomationSystems.Org')).not.toThrow();
  });

  it('rejects email addresses outside automationsystems.org', () => {
    expect(() => assertAllowedDomain('user@gmail.com')).toThrow('Automation Systems Google account');
  });
});

describe('requireActiveCrmUser', () => {
  it('returns authoritative CRM user fields for active users', async () => {
    await expect(
      requireActiveCrmUser(
        'USER@AUTOMATIONSYSTEMS.ORG',
        userLookup([
          {
            email: 'user@automationsystems.org',
            name: 'A. User',
            role: 'L3',
            allowed_tags: ['Punjab', 'NCR'],
            active: true
          }
        ])
      )
    ).resolves.toEqual({
      email: 'user@automationsystems.org',
      name: 'A. User',
      role: 'L3',
      allowedTags: ['Punjab', 'NCR'],
      active: true
    });
  });

  it('rejects inactive CRM users', async () => {
    await expect(
      requireActiveCrmUser(
        'inactive@automationsystems.org',
        userLookup([
          {
            email: 'inactive@automationsystems.org',
            name: 'Inactive User',
            role: 'L2',
            allowed_tags: ['Punjab'],
            active: false
          }
        ])
      )
    ).rejects.toThrow('not active');
  });

  it('auto-provisions missing company users as active L1 users', async () => {
    const rows: CrmUserRow[] = [];

    await expect(
      requireActiveCrmUser(
        'missing@automationsystems.org',
        userLookup(rows),
        userProvisioner(rows)
      )
    ).resolves.toEqual({
      email: 'missing@automationsystems.org',
      name: 'missing@automationsystems.org',
      role: 'L1',
      allowedTags: [],
      active: true
    });

    expect(rows).toEqual([
      {
        email: 'missing@automationsystems.org',
        name: 'missing@automationsystems.org',
        role: 'L1',
        allowed_tags: [],
        active: true
      }
    ]);
  });

  it('rejects missing CRM users when auto-provisioning is unavailable', async () => {
    await expect(
      requireActiveCrmUser('missing@automationsystems.org', userLookup([]), null)
    ).rejects.toThrow('not registered');
  });

  it('rejects legacy roles during normal CRM user resolution', async () => {
    await expect(
      requireActiveCrmUser(
        'legacy@automationsystems.org',
        userLookup([
          {
            email: 'legacy@automationsystems.org',
            name: 'Legacy User',
            role: 'Sales',
            allowed_tags: ['Punjab'],
            active: true
          }
        ])
      )
    ).rejects.toThrow('invalid CRM role');
  });
});

describe('normalizeCrmRole', () => {
  it('normalizes legacy roles only when source import explicitly allows it', () => {
    expect(() => normalizeCrmRole('Sales')).toThrow('invalid CRM role');
    expect(normalizeCrmRole('Sales', { allowLegacyImportRoles: true })).toBe('L2');
    expect(normalizeCrmRole('Manager', { allowLegacyImportRoles: true })).toBe('L4');
    expect(normalizeCrmRole('Admin', { allowLegacyImportRoles: true })).toBe('L6');
  });
});

describe('getRequestContext', () => {
  it('uses Supabase identity and CRM users table context', async () => {
    const context = await getRequestContext(new Request('https://crm.example.test'), {
      getAuthenticatedEmail: async () => 'session@automationsystems.org',
      lookupUser: userLookup([
        {
          email: 'session@automationsystems.org',
          name: 'Session User',
          role: 'L6',
          allowed_tags: ['*'],
          active: true
        }
      ])
    });

    expect(context).toEqual({
      email: 'session@automationsystems.org',
      name: 'Session User',
      role: 'L6',
      allowedTags: ['*'],
      active: true
    });
  });

  it('rejects requests without a Supabase email', async () => {
    await expect(
      getRequestContext(new Request('https://crm.example.test'), {
        getAuthenticatedEmail: async () => null,
        lookupUser: userLookup([])
      })
    ).rejects.toThrow('Sign in');
  });
});
