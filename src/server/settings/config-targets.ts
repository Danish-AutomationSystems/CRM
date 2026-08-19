import { joinPipe, parsePipe } from '../domain/lists';
import type { ConfigListKey } from './live';

export type RenameTarget = {
  table: string;
  column: string;
  /** scalar: a plain text column. array: text[]. pipe: ' | '-joined text. */
  kind: 'scalar' | 'array' | 'pipe';
};

/**
 * Every column that stores a copy of a config value, per config key.
 *
 * A missing entry here means a rename silently leaves stale values behind.
 * users.allowed_tags is the one that matters most: locations gate who can see
 * which customers, so missing it would silently revoke access rather than merely
 * mislabel something.
 *
 * Deliberately excluded: public.import_customers (tag/type/priority) is an
 * unprocessed staging table whose rows are validated against the live list at
 * import time, not business data; and recycle_bin.snapshot is a jsonb copy of a
 * row as it was when deleted, which is a historical record, not a live value.
 */
export const RENAME_TARGETS = {
  TAGS: [
    { table: 'customers', column: 'tags', kind: 'array' },
    { table: 'users', column: 'allowed_tags', kind: 'array' },
    { table: 'recycle_bin', column: 'tags', kind: 'array' }
  ],
  TYPES: [
    { table: 'customers', column: 'type', kind: 'scalar' },
    { table: 'recycle_bin', column: 'type', kind: 'scalar' }
  ],
  PRIORITIES: [
    { table: 'customers', column: 'priority', kind: 'scalar' },
    { table: 'cases', column: 'priority', kind: 'scalar' },
    { table: 'recycle_bin', column: 'priority', kind: 'scalar' }
  ],
  CATEGORIES: [{ table: 'cases', column: 'won_categories', kind: 'pipe' }],
  SEI_NAMES: [
    { table: 'customers', column: 'sei', kind: 'array' },
    { table: 'recycle_bin', column: 'sei', kind: 'array' }
  ]
} as const satisfies Record<ConfigListKey, readonly RenameTarget[]>;

/**
 * The reference semantics of a rename, one function per RenameTarget kind.
 *
 * PostgresAdminRepository.renameConfigValue does this in SQL, in bulk, inside the
 * rename transaction; these are the same rules expressed where they can be tested
 * without a database, and they are what the in-memory repository in the service
 * tests applies. Changing one without the other is a defect: keep them in step.
 */

/** Exact, case-sensitive. `= ${oldValue}` in SQL. */
export function renameScalar(stored: string, oldValue: string, newValue: string): string {
  return stored === oldValue ? newValue : stored;
}

/**
 * Exact element match only. `array_replace` in SQL.
 *
 * The '*' wildcard in users.allowed_tags survives by construction: it is never
 * equal to a config value, and it can never be the renamed-from value either,
 * because reservedConfigValue (admin/service.ts) refuses it on both sides.
 * users_star_tag_check (0001_initial_schema.sql:15) forbids '*' beside another
 * tag, so an element count that never changes is what keeps the row writable.
 */
export function renameArray(stored: readonly string[], oldValue: string, newValue: string): string[] {
  return stored.map((element) => (element === oldValue ? newValue : element));
}

/**
 * Element-wise over a pipe-joined column.
 *
 * joinPipe writes ' | ' with spaces (domain/lists.ts:27) while parsePipe splits on
 * '|' and trims (:16), so the stored text is 'VFDs | PLC' and a match against the
 * raw split element ('VFDs ', ' PLC') would never fire - a silent no-op. Trim
 * first, match exactly, then re-join in joinPipe's format.
 *
 * A plain string replace is the other wrong answer: the live CATEGORIES list holds
 * both 'Other' and 'Others', so a substring rewrite corrupts the neighbour.
 */
export function renamePipe(stored: string, oldValue: string, newValue: string): string {
  return joinPipe(parsePipe(stored).map((element) => (element === oldValue ? newValue : element)));
}
