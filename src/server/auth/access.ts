import type { CrmUser } from './context';
import { isDirect } from '../domain/direct';
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

/**
 * The customer's real account handlers, i.e. excluding the virtual `direct` placeholder.
 * This answers "is this person an account handler", and NOTHING else - in particular it is
 * no longer the source of case ownership (see `caseOwners`). Keeping the two separate is
 * what fixes P10: the creator fallback used to be returned from the same function.
 */
export function customerRealHandlers(customerId: string, ownership: AccessOwnership = EMPTY_OWNERSHIP): string[] {
  return customerHandlers(customerId, ownership).filter((email) => !isDirect(email));
}

/**
 * P11: case ownership is materialised on the case (`cases.extra_owners`), not derived from
 * the handlers table at read time. The stored set is authoritative. The creator fallback
 * only applies when nothing is stored at all, which guarantees the "every case has at least
 * one owner" rule without ever consulting `handlers`.
 */
export function caseOwners(caseRecord: CaseRecord): string[] {
  const stored = uniqueEmails(parsePipe(caseRecord.extraOwners));
  if (stored.length > 0) return stored;

  const creator = normalizeEmail(caseRecord.owner);
  return creator && !isDirect(creator) ? [creator] : [];
}

export type CaseOwnerSource = 'handler' | 'creator' | 'manual';

export type CaseOwnerEntry = {
  email: string;
  source: CaseOwnerSource;
  removable: boolean;
};

export function caseOwnerSource(
  caseRecord: CaseRecord,
  email: string,
  ownership: AccessOwnership = EMPTY_OWNERSHIP
): CaseOwnerSource {
  const normalized = normalizeEmail(email);
  if (customerRealHandlers(caseRecord.customerId, ownership).includes(normalized)) return 'handler';
  if (normalized === normalizeEmail(caseRecord.owner)) return 'creator';
  return 'manual';
}

/**
 * P10: every owner entry carries an explicit source. Account handlers stay non-removable
 * here (they are removed on the customer instead). Creator- and manually-added owners are
 * removable, unless removing them would leave the case with zero owners.
 */
export function caseOwnerEntries(
  caseRecord: CaseRecord,
  ownership: AccessOwnership = EMPTY_OWNERSHIP
): CaseOwnerEntry[] {
  const owners = caseOwners(caseRecord);
  return owners.map((email) => {
    const source = caseOwnerSource(caseRecord, email, ownership);
    return {
      email,
      source,
      removable: source !== 'handler' && owners.length > 1
    };
  });
}

export function caseVisible(
  user: CrmUser,
  customerAccess: CustomerAccessLevel,
  caseRecord: CaseRecord
): boolean {
  if (seesAll(user)) return true;

  const email = normalizeEmail(user.email);
  if (caseOwners(caseRecord).includes(email)) return true;
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
  caseRecord: CaseRecord
): CaseRecord {
  if (!caseVisible(user, customerAccess, caseRecord)) {
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
