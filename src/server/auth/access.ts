import type { CrmUser } from './context';
import { isDirect } from '../domain/direct';
import { normalizeEmail, parseList, uniqueEmails } from '../domain/lists';
import type {
  AccessOwnership,
  CaseRecord,
  CustomerAccessLevel,
  CustomerRecord
} from '../domain/types';

const EMPTY_OWNERSHIP: AccessOwnership = {
  handlerEmailsByCustomerId: {}
};

function roleLevel(user: Pick<CrmUser, 'role'>): number {
  return Number(user.role.slice(1));
}

function seesAll(user: Pick<CrmUser, 'role'>): boolean {
  return roleLevel(user) >= 4;
}

function customerHandlers(customerId: string, ownership: AccessOwnership = EMPTY_OWNERSHIP): string[] {
  return uniqueEmails(ownership.handlerEmailsByCustomerId[customerId] ?? []);
}

function tagMatches(user: Pick<CrmUser, 'allowedTags'>, customer: CustomerRecord): boolean {
  if (user.allowedTags.includes('*')) return true;

  const allowed = new Set(user.allowedTags);
  return parseList(customer.tags).some((tag) => allowed.has(tag));
}

export function accessLevel(
  user: CrmUser,
  customer: CustomerRecord,
  ownership: AccessOwnership = EMPTY_OWNERSHIP
): CustomerAccessLevel {
  if (seesAll(user)) return 'FULL';

  const email = normalizeEmail(user.email);
  if (customerHandlers(customer.id, ownership).includes(email)) return 'FULL';

  const matchesTag = tagMatches(user, customer);
  const level = roleLevel(user);

  if (level >= 3) return matchesTag ? 'FULL' : 'NAME';
  if (level === 2) return matchesTag ? 'NAME' : 'NONE';
  return 'NONE';
}

/**
 * The customer's real account handlers, i.e. excluding the virtual `direct` placeholder.
 * This answers "is this person an account handler" and never includes the case creator.
 * `caseHandlers` builds case ownership on top of it and adds the creator fallback itself when
 * this returns nothing. Keeping the fallback out of this function is what fixes P10: the
 * creator fallback used to be returned from the same function.
 */
export function customerRealHandlers(customerId: string, ownership: AccessOwnership = EMPTY_OWNERSHIP): string[] {
  return customerHandlers(customerId, ownership).filter((email) => !isDirect(email));
}

/**
 * Who owns a case: its account's real handlers, derived live - ownership is never stored on
 * the case. When the account has no real handler (a customerless case, or one handled only by
 * the virtual Direct account) the case's creator stands in so the case is never orphaned. The
 * moment the account gains a real handler, the creator's claim ends.
 *
 * `ownership` has no default on purpose: "no handlers" would trigger the creator fallback on
 * accounts that do have handlers.
 */
export function caseHandlers(caseRecord: CaseRecord, ownership: AccessOwnership): string[] {
  const handlers = customerRealHandlers(caseRecord.customerId, ownership);
  if (handlers.length > 0) return handlers;
  const creator = normalizeEmail(caseRecord.createdBy);
  return creator && !isDirect(creator) ? [creator] : [];
}

export function caseVisible(
  user: CrmUser,
  customerAccess: CustomerAccessLevel,
  caseRecord: CaseRecord,
  ownership: AccessOwnership
): boolean {
  if (seesAll(user)) return true;
  if (customerAccess === 'FULL') return true;

  const email = normalizeEmail(user.email);
  if (normalizeEmail(caseRecord.assignee) === email) return true;
  return caseHandlers(caseRecord, ownership).includes(email);
}

export function ensureFull(
  user: CrmUser,
  customer: CustomerRecord,
  ownership: AccessOwnership = EMPTY_OWNERSHIP
): CustomerRecord {
  if (accessLevel(user, customer, ownership) !== 'FULL') {
    throw new Error(
      'You are not an account handler for this customer, so you cannot open its details. Ask one of its handlers (or an L3+ user) to add you as a handler.'
    );
  }

  return customer;
}

export function ensureCanSeeCase(
  user: CrmUser,
  customerAccess: CustomerAccessLevel,
  caseRecord: CaseRecord,
  ownership: AccessOwnership
): CaseRecord {
  if (!caseVisible(user, customerAccess, caseRecord, ownership)) {
    throw new Error('You do not have access to this case.');
  }

  return caseRecord;
}

export function ensureAdmin<TUser extends CrmUser>(user: TUser): TUser {
  if (user.role !== 'L6') {
    throw new Error('Admin access requires L6.');
  }

  return user;
}
