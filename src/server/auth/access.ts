import type { CrmUser } from './context';
import { normalizeEmail, parseList, parsePipe, uniqueEmails } from '../domain/lists';
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

export function caseHandlerOwners(caseRecord: CaseRecord, ownership: AccessOwnership = EMPTY_OWNERSHIP): string[] {
  const handlers = customerHandlers(caseRecord.customerId, ownership).filter((email) => email !== 'direct');
  if (handlers.length > 0) return handlers;

  const fallbackOwner = normalizeEmail(caseRecord.owner);
  return fallbackOwner && fallbackOwner !== 'direct' ? [fallbackOwner] : [];
}

export function caseExtraOwners(caseRecord: CaseRecord): string[] {
  return uniqueEmails(parsePipe(caseRecord.extraOwners));
}

export function caseOwners(caseRecord: CaseRecord, ownership: AccessOwnership = EMPTY_OWNERSHIP): string[] {
  return uniqueEmails([...caseHandlerOwners(caseRecord, ownership), ...caseExtraOwners(caseRecord)]);
}

export function caseVisible(
  user: CrmUser,
  customerAccess: CustomerAccessLevel,
  caseRecord: CaseRecord,
  ownership: AccessOwnership = EMPTY_OWNERSHIP
): boolean {
  if (seesAll(user)) return true;

  const email = normalizeEmail(user.email);
  if (caseOwners(caseRecord, ownership).includes(email)) return true;
  if (normalizeEmail(caseRecord.assignee) === email) return true;

  return customerAccess === 'FULL';
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
  ownership: AccessOwnership = EMPTY_OWNERSHIP
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
