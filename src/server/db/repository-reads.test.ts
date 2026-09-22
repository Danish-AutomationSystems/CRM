import { describe, expect, it } from 'vitest';

import { CASE_READ_METHODS, CUSTOMER_READ_METHODS } from './repository-reads';

const MUST_NEVER_BE_CACHED = [
  'withTransaction',
  'lockCase',
  'lockCustomerName',
  'nextCaseId',
  'nextCustomerId',
  'nextContactId',
  'createCase',
  'updateCase',
  'createCustomer',
  'updateCustomer',
  'deleteCustomer',
  'addHandler',
  'removeHandler',
  'removeDirectHandlers',
  'logActivity',
  'createContact',
  'updateContact',
  'deleteContact',
  'createAttachments',
  'moveCustomerToRecycleBin'
];

describe('repository read allow-lists', () => {
  it('never lists a write, lock or counter method', () => {
    for (const forbidden of MUST_NEVER_BE_CACHED) {
      expect(CASE_READ_METHODS).not.toContain(forbidden);
      expect(CUSTOMER_READ_METHODS).not.toContain(forbidden);
    }
  });

  it('lists the reads that the dashboard path repeats', () => {
    for (const method of ['listUsers', 'listHandlers', 'listSettings', 'listCases', 'getCustomersByIds']) {
      expect(CASE_READ_METHODS).toContain(method);
    }
    for (const method of ['listUsers', 'listHandlers', 'listSettings', 'listCustomers']) {
      expect(CUSTOMER_READ_METHODS).toContain(method);
    }
  });

  it('contains no duplicates', () => {
    expect(new Set(CASE_READ_METHODS).size).toBe(CASE_READ_METHODS.length);
    expect(new Set(CUSTOMER_READ_METHODS).size).toBe(CUSTOMER_READ_METHODS.length);
  });
});
