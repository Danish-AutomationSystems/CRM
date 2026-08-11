import { isDirect } from '../domain/direct';
import { normalizeEmail, parsePipe, uniqueEmails } from '../domain/lists';

/**
 * P11 seed migration reference implementation.
 *
 * `supabase/migrations/0005_materialise_case_owners.sql` writes exactly what
 * `seededCaseOwners()` returns here, and re-checks it per case before committing.
 * `legacyDerivedCaseOwners()` preserves the read-time derivation that
 * `auth/access.ts::caseHandlerOwners()` performed BEFORE P11, verbatim, so the seed can be
 * proven equivalent case by case rather than in aggregate.
 *
 * Do not "simplify" `legacyDerivedCaseOwners` - it is a frozen record of old behaviour.
 */

export type SeedCaseRow = {
  id: string;
  customerId: string;
  outcome: string;
  owner: string;
  extraOwners: readonly string[] | string;
};

export type SeedHandlerRow = {
  customerId: string;
  email: string;
};

function handlersFor(customerId: string, handlers: readonly SeedHandlerRow[]): string[] {
  return uniqueEmails(handlers.filter((row) => row.customerId === customerId).map((row) => row.email));
}

/** Frozen copy of the pre-P11 `caseHandlerOwners()`. */
function legacyHandlerOwners(row: SeedCaseRow, handlers: readonly SeedHandlerRow[]): string[] {
  const real = handlersFor(row.customerId, handlers).filter((email) => !isDirect(email));
  if (real.length > 0) return real;

  const fallbackOwner = normalizeEmail(row.owner);
  return fallbackOwner && !isDirect(fallbackOwner) ? [fallbackOwner] : [];
}

/** Frozen copy of the pre-P11 `caseOwners()`. */
export function legacyDerivedCaseOwners(row: SeedCaseRow, handlers: readonly SeedHandlerRow[]): string[] {
  return uniqueEmails([...legacyHandlerOwners(row, handlers), ...uniqueEmails(parsePipe(row.extraOwners))]);
}

/**
 * The value migration 0005 stores in `cases.extra_owners`. Deliberately identical to the old
 * derivation so behaviour is unchanged on the day it ships - including for cases whose derived
 * set was empty, which stay empty rather than gaining an invented owner.
 */
export function seededCaseOwners(row: SeedCaseRow, handlers: readonly SeedHandlerRow[]): string[] {
  return legacyDerivedCaseOwners(row, handlers);
}
