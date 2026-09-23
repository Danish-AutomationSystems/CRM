import { describe, expect, it } from 'vitest';

import type { CrmUser } from './context';
import {
  accessLevel,
  caseHandlers,
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
  createdBy: 'creator@automationsystems.org',
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

  it('gives an L2 user who is not a handler and has no matching tag no customer access', () => {
    const assignee = user('L2', ['NCR']);

    expect(accessLevel(assignee, customer, ownership())).toBe('NONE');
  });

  it('no longer treats wildcard tags as matching customer tags', () => {
    expect(accessLevel(user('L2', ['*']), customer)).toBe('NONE');
    expect(accessLevel(user('L3', ['*']), customer)).toBe('NAME');
  });
});

describe('the * wildcard no longer grants access', () => {
  const wildcardCustomer: CustomerRecord = { id: 'CUST-1', name: 'Wildcard Co', tags: ['Punjab'], type: 'OEM' };

  it('grants an L2 holding "*" nothing, because * is just an unmatched string now', () => {
    const l2 = user('L2', ['*']);

    expect(accessLevel(l2, wildcardCustomer, ownership())).toBe('NONE');
  });

  it('grants an L2 the customers in their listed locations', () => {
    const l2 = user('L2', ['Punjab']);

    expect(accessLevel(l2, wildcardCustomer, ownership())).toBe('NAME');
  });

  it('grants an L2 nothing outside their listed locations', () => {
    const l2 = user('L2', ['NCR']);

    expect(accessLevel(l2, wildcardCustomer, ownership())).toBe('NONE');
  });

  it('still grants L4 full access with no tags at all', () => {
    const l4 = user('L4', []);

    expect(accessLevel(l4, wildcardCustomer, ownership())).toBe('FULL');
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

describe('caseHandlers', () => {
  const handlers = ownership({
    handlerEmailsByCustomerId: { [customer.id]: ['anita@automationsystems.org', 'ravi@automationsystems.org'] }
  });
  const directOnly = ownership({ handlerEmailsByCustomerId: { [customer.id]: ['direct'] } });

  it('returns the account real handlers and ignores the creator entirely', () => {
    expect(caseHandlers(caseRecord, handlers)).toEqual(['anita@automationsystems.org', 'ravi@automationsystems.org']);
  });
  it('falls back to Direct on a customerless case', () => {
    expect(caseHandlers({ ...caseRecord, customerId: '' }, handlers)).toEqual(['direct']);
  });
  it('returns Direct when the only handler is the virtual Direct account', () => {
    expect(caseHandlers(caseRecord, directOnly)).toEqual(['direct']);
  });
  it('falls back to Direct when the account has no handler rows at all', () => {
    expect(caseHandlers(caseRecord, ownership())).toEqual(['direct']);
  });
});

describe('caseVisible', () => {
  const creator = user('L2');
  const other = user('L1');
  const handler = { ...user('L2'), email: 'anita@automationsystems.org' };
  const created = { ...caseRecord, createdBy: creator.email };
  const handled = ownership({ handlerEmailsByCustomerId: { [customer.id]: [handler.email] } });

  it('L4+ sees every case, even with no customer access and no relationship', () => {
    expect(caseVisible(user('L4'), 'NONE', created, handled)).toBe(true);
  });
  it('a real handler sees the case through FULL customer access', () => {
    expect(caseVisible(handler, accessLevel(handler, customer, handled), created, handled)).toBe(true);
  });
  it('an unrelated L1 or tag-mismatched L3 user is denied', () => {
    expect(caseVisible(other, 'NONE', created, handled)).toBe(false);
    const l3 = user('L3', ['Gujarat']);
    expect(caseVisible(l3, accessLevel(l3, customer, handled), created, handled)).toBe(false);
  });
  it('the assignee sees the case whatever the handler state', () => {
    expect(caseVisible(other, 'NONE', { ...created, assignee: other.email }, handled)).toBe(true);
  });
  it('denies the creator a case whose account has no real handler (Direct owns it instead)', () => {
    expect(caseVisible(creator, 'NONE', created, ownership())).toBe(false);
  });
  it('denies the creator a customerless case (Direct owns it instead)', () => {
    expect(caseVisible(creator, 'NONE', { ...created, customerId: '' }, handled)).toBe(false);
  });
  it('the creator loses the case the moment the account gains a real handler', () => {
    expect(caseVisible(creator, 'NONE', created, handled)).toBe(false);
  });
  it('the creator keeps the case after a handler exists only by being the assignee', () => {
    expect(caseVisible(creator, 'NONE', { ...created, assignee: creator.email }, handled)).toBe(true);
  });
});

describe('authorization guards', () => {
  it('returns the customer or case when access is allowed', () => {
    const admin = user('L6', []);

    expect(ensureFull(admin, customer)).toBe(customer);
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

describe('caseHandlers — Direct replaces the creator fallback', () => {
  it('returns Direct, not the creator, when the account has no real handler', () => {
    const ownershipRecord: AccessOwnership = { handlerEmailsByCustomerId: { 'CUST-1': ['direct'] } };
    const caseRec: CaseRecord = {
      id: 'CASE-1',
      customerId: 'CUST-1',
      title: 'Panel enquiry',
      createdBy: 'l2@automationsystems.org',
      assignee: ''
    };

    expect(caseHandlers(caseRec, ownershipRecord)).toEqual(['direct']);
  });

  it('returns Direct even when the account has no handler row at all', () => {
    const ownershipRecord: AccessOwnership = { handlerEmailsByCustomerId: {} };
    const caseRec: CaseRecord = {
      id: 'CASE-1',
      customerId: 'CUST-1',
      title: 'Panel enquiry',
      createdBy: 'l2@automationsystems.org',
      assignee: ''
    };

    expect(caseHandlers(caseRec, ownershipRecord)).toEqual(['direct']);
  });

  it('returns the real handlers when they exist, never the creator', () => {
    const ownershipRecord: AccessOwnership = {
      handlerEmailsByCustomerId: { 'CUST-1': ['handler@automationsystems.org'] }
    };
    const caseRec: CaseRecord = {
      id: 'CASE-1',
      customerId: 'CUST-1',
      title: 'Panel enquiry',
      createdBy: 'creator@automationsystems.org',
      assignee: ''
    };

    expect(caseHandlers(caseRec, ownershipRecord)).toEqual(['handler@automationsystems.org']);
  });
});

describe('caseVisible — the ghost-visibility fix', () => {
  const l2: CrmUser = { email: 'creator@automationsystems.org', name: 'L2', role: 'L2', allowedTags: [], active: true };

  it('denies the creator a Direct-held case they are not assigned', () => {
    const ownershipRecord: AccessOwnership = { handlerEmailsByCustomerId: { 'CUST-1': ['direct'] } };
    const caseRec: CaseRecord = {
      id: 'CASE-1',
      customerId: 'CUST-1',
      title: 'Panel enquiry',
      createdBy: 'creator@automationsystems.org',
      assignee: ''
    };

    expect(caseVisible(l2, 'NONE', caseRec, ownershipRecord)).toBe(false);
  });

  it('still allows the creator when they are the assignee', () => {
    const ownershipRecord: AccessOwnership = { handlerEmailsByCustomerId: { 'CUST-1': ['direct'] } };
    const caseRec: CaseRecord = {
      id: 'CASE-1',
      customerId: 'CUST-1',
      title: 'Panel enquiry',
      createdBy: 'creator@automationsystems.org',
      assignee: 'creator@automationsystems.org'
    };

    expect(caseVisible(l2, 'NONE', caseRec, ownershipRecord)).toBe(true);
  });

  it('grants nobody access merely because Direct holds the account', () => {
    const ownershipRecord: AccessOwnership = { handlerEmailsByCustomerId: { 'CUST-1': ['direct'] } };
    const caseRec: CaseRecord = {
      id: 'CASE-1',
      customerId: 'CUST-1',
      title: 'Panel enquiry',
      createdBy: 'someone@automationsystems.org',
      assignee: ''
    };
    const unrelated: CrmUser = {
      email: 'other@automationsystems.org',
      name: 'L3',
      role: 'L3',
      allowedTags: [],
      active: true
    };

    expect(caseVisible(unrelated, 'NONE', caseRec, ownershipRecord)).toBe(false);
  });

  it('still lets L4+ see everything', () => {
    const ownershipRecord: AccessOwnership = { handlerEmailsByCustomerId: { 'CUST-1': ['direct'] } };
    const caseRec: CaseRecord = {
      id: 'CASE-1',
      customerId: 'CUST-1',
      title: 'Panel enquiry',
      createdBy: 'someone@automationsystems.org',
      assignee: ''
    };
    const l4: CrmUser = { email: 'boss@automationsystems.org', name: 'L4', role: 'L4', allowedTags: [], active: true };

    expect(caseVisible(l4, 'FULL', caseRec, ownershipRecord)).toBe(true);
  });
});
