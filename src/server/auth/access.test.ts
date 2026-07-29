import { describe, expect, it } from 'vitest';

import type { CrmUser } from './context';
import {
  accessLevel,
  caseVisible,
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
    expect(accessLevel(user(role), customer, ownership())).toBe(expected);
  });

  it.each([
    ['L1', 'NONE'],
    ['L2', 'NONE'],
    ['L3', 'NAME'],
    ['L4', 'FULL'],
    ['L5', 'FULL'],
    ['L6', 'FULL']
  ] as const)('returns %s customer access outside matching tags', (role, expected) => {
    expect(accessLevel(user(role, ['NCR']), customer, ownership())).toBe(expected);
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
    expect(accessLevel(user('L2', ['*']), customer, ownership())).toBe('NAME');
    expect(accessLevel(user('L3', ['*']), customer, ownership())).toBe('FULL');
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

    expect(caseVisible(handler, 'FULL', caseRecord, own)).toBe(true);
    expect(caseVisible(assignee, 'NONE', { ...caseRecord, assignee: assignee.email }, ownership())).toBe(true);
    expect(caseVisible(extraOwner, 'NONE', { ...caseRecord, extraOwners: [extraOwner.email] }, ownership())).toBe(
      true
    );
    expect(caseVisible(supervisor, 'FULL', caseRecord, ownership())).toBe(true);
    expect(caseVisible(manager, 'FULL', caseRecord, ownership())).toBe(true);
  });

  it('hides cases from name-only customer users who are not owners or assignees', () => {
    const sales = user('L2', ['Punjab']);

    expect(caseVisible(sales, 'NAME', caseRecord, ownership())).toBe(false);
  });

  it('falls back to the stored owner only when the customer has no real handlers', () => {
    const creator = user('L2', ['NCR']);

    expect(
      caseVisible(
        creator,
        'NONE',
        { ...caseRecord, owner: creator.email },
        ownership({ handlerEmailsByCustomerId: { [customer.id]: ['direct'] } })
      )
    ).toBe(true);

    expect(
      caseVisible(
        creator,
        'NONE',
        { ...caseRecord, owner: creator.email },
        ownership({ handlerEmailsByCustomerId: { [customer.id]: ['other@automationsystems.org'] } })
      )
    ).toBe(false);
  });
});

describe('authorization guards', () => {
  it('returns the customer or case when access is allowed', () => {
    const admin = user('L6', []);

    expect(ensureFull(admin, customer, ownership())).toBe(customer);
    expect(ensureCanSeeCase(admin, 'FULL', caseRecord, ownership())).toBe(caseRecord);
    expect(ensureAdmin(admin)).toBe(admin);
  });

  it('throws stable authorization errors when access is denied', () => {
    const sales = user('L2', ['Punjab']);

    expect(() => ensureFull(sales, customer, ownership())).toThrow('not an account handler');
    expect(() => ensureCanSeeCase(sales, 'NAME', caseRecord, ownership())).toThrow('access to this case');
    expect(() => ensureAdmin(user('L5'))).toThrow('Admin access requires L6');
  });
});
