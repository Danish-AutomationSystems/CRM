import { describe, expect, it } from 'vitest';

import type { CrmUser } from './context';
import {
  accessLevel,
  caseOwnerEntries,
  caseOwners,
  caseVisible,
  customerRealHandlers,
  ensureAdmin,
  ensureCanSeeCase,
  ensureFull
} from './access';
import type { AccessOwnership, CaseRecord, CustomerRecord } from '../domain/types';

const customer: CustomerRecord = {
  id: 'CUST-0001',
  name: 'Punjab Factory',
  tags: ['Punjab'],
  type: 'OEM'
};

const caseRecord: CaseRecord = {
  id: 'CASE-2026-0001',
  customerId: customer.id,
  title: 'Panel enquiry',
  owner: 'creator@automationsystems.org',
  extraOwners: [],
  assignee: ''
};

function user(role: CrmUser['role'], allowedTags: string[] = ['Punjab']): CrmUser {
  const email = `${role.toLowerCase()}@automationsystems.org`;

  return {
    email,
    name: role,
    role,
    allowedTags,
    active: true
  };
}

function ownership(overrides: Partial<AccessOwnership> = {}): AccessOwnership {
  return {
    handlerEmailsByCustomerId: {},
    ...overrides
  };
}

describe('accessLevel', () => {
  it.each([
    ['L1', 'NONE'],
    ['L2', 'NAME'],
    ['L3', 'FULL'],
    ['L4', 'FULL'],
    ['L5', 'FULL'],
    ['L6', 'FULL']
  ] as const)('returns %s customer access on a matching tag', (role, expected) => {
    expect(accessLevel(user(role), customer)).toBe(expected);
  });

  it.each([
    ['L1', 'NONE'],
    ['L2', 'NONE'],
    ['L3', 'NAME'],
    ['L4', 'FULL'],
    ['L5', 'FULL'],
    ['L6', 'FULL']
  ] as const)('returns %s customer access outside matching tags', (role, expected) => {
    expect(accessLevel(user(role, ['NCR']), customer)).toBe(expected);
  });

  it('grants full customer access to account handlers at every level', () => {
    const l1 = user('L1', []);

    expect(
      accessLevel(
        l1,
        customer,
        ownership({ handlerEmailsByCustomerId: { [customer.id]: [l1.email] } })
      )
    ).toBe('FULL');
  });

  it('does not grant customer access to a ticket assignee or extra owner', () => {
    const assignee = user('L2', ['NCR']);

    expect(
      accessLevel(
        assignee,
        customer,
        ownership({
          assigneeEmailsByCustomerId: { [customer.id]: [assignee.email] },
          extraOwnerEmailsByCustomerId: { [customer.id]: [assignee.email] }
        })
      )
    ).toBe('NONE');
  });

  it('treats wildcard tags as matching customer tags', () => {
    expect(accessLevel(user('L2', ['*']), customer)).toBe('NAME');
    expect(accessLevel(user('L3', ['*']), customer)).toBe('FULL');
  });
});

describe('caseOwners (materialised, P11)', () => {
  it('reads the stored owner set and never consults the handlers table', () => {
    const stored = { ...caseRecord, extraOwners: ['a@automationsystems.org', 'b@automationsystems.org'] };

    // caseOwners takes no ownership argument at all - it structurally cannot read handlers.
    expect(caseOwners).toHaveLength(1);
    expect(caseOwners(stored)).toEqual(['a@automationsystems.org', 'b@automationsystems.org']);
    expect(caseOwners({ ...stored, owner: 'someone-else@automationsystems.org' })).toEqual([
      'a@automationsystems.org',
      'b@automationsystems.org'
    ]);
  });

  it('falls back to the creator so every case keeps at least one owner', () => {
    expect(caseOwners({ ...caseRecord, extraOwners: [] })).toEqual(['creator@automationsystems.org']);
    expect(caseOwners({ ...caseRecord, extraOwners: [], owner: 'direct' })).toEqual([]);
    expect(caseOwners({ ...caseRecord, extraOwners: [], owner: '' })).toEqual([]);
  });
});

describe('caseOwnerEntries (P10 owner sources)', () => {
  const handlerOwn = ownership({
    handlerEmailsByCustomerId: { [customer.id]: ['handler@automationsystems.org', 'direct'] }
  });

  it('labels a current account handler as source handler and refuses removal', () => {
    const row = {
      ...caseRecord,
      extraOwners: ['handler@automationsystems.org', 'manual@automationsystems.org']
    };

    expect(caseOwnerEntries(row, handlerOwn)).toEqual([
      { email: 'handler@automationsystems.org', source: 'handler', removable: false },
      { email: 'manual@automationsystems.org', source: 'manual', removable: true }
    ]);
  });

  it('labels the stored creator as source creator, not handler, and allows removal when others remain', () => {
    const directOnly = ownership({ handlerEmailsByCustomerId: { [customer.id]: ['direct'] } });
    const soleCreator = { ...caseRecord, extraOwners: ['creator@automationsystems.org'] };
    const withPeer = {
      ...caseRecord,
      extraOwners: ['creator@automationsystems.org', 'peer@automationsystems.org']
    };

    expect(caseOwnerEntries(soleCreator, directOnly)).toEqual([
      { email: 'creator@automationsystems.org', source: 'creator', removable: false }
    ]);
    expect(caseOwnerEntries(withPeer, directOnly)).toEqual([
      { email: 'creator@automationsystems.org', source: 'creator', removable: true },
      { email: 'peer@automationsystems.org', source: 'manual', removable: true }
    ]);
  });

  it('treats a former handler as manual once the handler row is gone', () => {
    const row = { ...caseRecord, extraOwners: ['handler@automationsystems.org', 'peer@automationsystems.org'] };

    expect(caseOwnerEntries(row, ownership())).toEqual([
      { email: 'handler@automationsystems.org', source: 'manual', removable: true },
      { email: 'peer@automationsystems.org', source: 'manual', removable: true }
    ]);
  });
});

describe('customerRealHandlers', () => {
  it('excludes the virtual Direct handler', () => {
    expect(
      customerRealHandlers(customer.id, ownership({ handlerEmailsByCustomerId: { [customer.id]: ['direct', 'a@automationsystems.org'] } }))
    ).toEqual(['a@automationsystems.org']);
    expect(customerRealHandlers(customer.id, ownership())).toEqual([]);
  });
});

describe('caseVisible', () => {
  it('lets account handlers, assignees, extra owners, full customer users, and L4+ see cases', () => {
    const handler = user('L1', []);
    const assignee = user('L2', ['NCR']);
    const extraOwner = user('L2', ['NCR']);
    const supervisor = user('L3', ['Punjab']);
    const manager = user('L4', ['NCR']);
    const own = ownership({ handlerEmailsByCustomerId: { [customer.id]: [handler.email] } });

    expect(caseVisible(handler, 'FULL', caseRecord)).toBe(true);
    expect(caseVisible(assignee, 'NONE', { ...caseRecord, assignee: assignee.email })).toBe(true);
    expect(caseVisible(extraOwner, 'NONE', { ...caseRecord, extraOwners: [extraOwner.email] })).toBe(
      true
    );
    expect(caseVisible(supervisor, 'FULL', caseRecord)).toBe(true);
    expect(caseVisible(manager, 'FULL', caseRecord)).toBe(true);
  });

  it('hides cases from name-only customer users who are not owners or assignees', () => {
    const sales = user('L2', ['Punjab']);

    expect(caseVisible(sales, 'NAME', caseRecord)).toBe(false);
  });

  it('uses the stored owner set, so adding a handler row alone no longer grants case ownership', () => {
    const creator = user('L2', ['NCR']);
    const other = user('L2', ['NCR']);
    const otherIsHandler = ownership({
      handlerEmailsByCustomerId: { [customer.id]: ['other@automationsystems.org'] }
    });

    // `otherIsHandler` is deliberately unused by caseVisible: handler rows no longer feed
    // case ownership at all.
    expect(otherIsHandler.handlerEmailsByCustomerId[customer.id]).toEqual(['other@automationsystems.org']);
    // Creator fallback still applies while nothing is stored.
    expect(caseVisible(creator, 'NONE', { ...caseRecord, owner: creator.email })).toBe(true);
    // A handler row that was never materialised onto the case does not make the case visible.
    expect(
      caseVisible({ ...other, email: 'other@automationsystems.org' }, 'NONE', { ...caseRecord, owner: creator.email })
    ).toBe(false);
    // Materialised ownership does.
    expect(
      caseVisible({ ...other, email: 'other@automationsystems.org' }, 'NONE', {
        ...caseRecord,
        owner: creator.email,
        extraOwners: ['other@automationsystems.org']
      })
    ).toBe(true);
  });
});

describe('authorization guards', () => {
  it('returns the customer or case when access is allowed', () => {
    const admin = user('L6', []);

    expect(ensureFull(admin, customer)).toBe(customer);
    expect(ensureCanSeeCase(admin, 'FULL', caseRecord)).toBe(caseRecord);
    expect(ensureAdmin(admin)).toBe(admin);
  });

  it('throws stable authorization errors when access is denied', () => {
    const sales = user('L2', ['Punjab']);

    expect(() => ensureFull(sales, customer, ownership())).toThrow('not an account handler');
    expect(() => ensureCanSeeCase(sales, 'NAME', caseRecord)).toThrow('access to this case');
    expect(() => ensureAdmin(user('L5'))).toThrow('Admin access requires L6');
  });
});
