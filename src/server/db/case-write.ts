import type { Sql, TransactionSql } from 'postgres';

import { joinPipe, normalizeEmail, parsePipe } from '../domain/lists';

type DbExecutor = Sql | TransactionSql;

/**
 * The workflow layer passes only changed case fields to repositories. This
 * small guard makes the boundary explicit and gives SQL implementations one
 * place to reject accidental whole-row writes.
 */
export const CASE_WRITE_FIELDS = [
  'customerId', 'title', 'details', 'source', 'priority', 'stage', 'outcome', 'orderValue',
  'wonCategories', 'outcomeNote', 'assignee', 'closedOn', 'updatedAt'
] as const;

export type CaseWriteField = (typeof CASE_WRITE_FIELDS)[number];

const CASE_WRITE_COLUMNS: Record<CaseWriteField, string> = {
  customerId: 'customer_id',
  title: 'title',
  details: 'details',
  source: 'source',
  priority: 'priority',
  stage: 'stage',
  outcome: 'outcome',
  orderValue: 'order_value',
  wonCategories: 'won_categories',
  outcomeNote: 'outcome_note',
  assignee: 'assignee',
  closedOn: 'closed_on',
  updatedAt: 'updated_at'
};

export function caseWritePatch<T extends object>(fields: Partial<T>): Partial<T> {
  return Object.fromEntries(
    Object.entries(fields).filter(([key, value]) => CASE_WRITE_FIELDS.includes(key as CaseWriteField) && value !== undefined)
  ) as Partial<T>;
}

/** Build a value-parameterized UPDATE from a fixed whitelist of case columns. */
export function buildCaseWriteSql<T extends object>(id: string, fields: Partial<T>): { query: string; values: unknown[] } {
  const patch = caseWritePatch(fields) as Record<string, unknown>;
  const entries = Object.entries(patch);
  if (!entries.length) throw new Error('No mutable case fields were supplied.');
  const values = entries.map(([, value]) => value);
  const assignments = entries.map(([field], index) => `${CASE_WRITE_COLUMNS[field as CaseWriteField]} = $${index + 1}`);
  values.push(id);
  return {
    query: `update public.cases set ${assignments.join(', ')}, version = version + 1 where case_id = $${values.length}`,
    values
  };
}

/**
 * `cases.repository.ts` and `quotes.repository.ts` each keep a distinct row
 * type (`CaseRow` / `QuoteCaseRow`) for their own public contract, but the two
 * types are structurally identical and every case read/write below is byte-
 * identical between the two repositories. This module is the single place
 * that talks to `public.cases` so that identity never drifts apart again.
 */
export type CaseWriteRow = {
  id: string;
  customerId: string;
  title: string;
  details: string;
  source: string;
  priority: string;
  stage: string;
  outcome: '' | 'Won' | 'Lost' | 'Hold';
  orderValue: number | '';
  wonCategories: string[];
  outcomeNote: string;
  assignee: string;
  closedOn: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
};

export type CaseWriteDbRow = {
  case_id: string;
  customer_id: string | null;
  title: string;
  details: string | null;
  source: string | null;
  priority: string | null;
  stage: string;
  outcome: 'Won' | 'Lost' | 'Hold' | null;
  order_value: string | number | null;
  won_categories: string | null;
  outcome_note: string | null;
  assignee: string | null;
  closed_on: string | Date | null;
  created_by: string | null;
  created_at: string | Date;
  updated_at: string | Date;
};

function dateString(value: string | Date | null | undefined): string {
  if (!value) return '';
  return value instanceof Date ? value.toISOString() : String(value);
}

function numberOrBlank(value: string | number | null | undefined): number | '' {
  if (value === null || value === undefined || value === '') return '';
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : '';
}

function dbOutcome(value: CaseWriteRow['outcome']): 'Won' | 'Lost' | 'Hold' | null {
  return value || null;
}

function dbNumber(value: number | ''): number | null {
  return value === '' ? null : value;
}

function dbDate(value: string): string | null {
  return value || null;
}

function dbEmail(value: string): string | null {
  return normalizeEmail(value) || null;
}

/** Map a `public.cases` row into the shared case shape both repositories return. */
export function toCaseWriteRow<T extends CaseWriteRow = CaseWriteRow>(row: CaseWriteDbRow): T {
  return {
    id: row.case_id,
    customerId: row.customer_id ?? '',
    title: row.title,
    details: row.details ?? '',
    source: row.source ?? '',
    priority: row.priority ?? '',
    stage: row.stage,
    outcome: row.outcome ?? '',
    orderValue: numberOrBlank(row.order_value),
    wonCategories: parsePipe(row.won_categories),
    outcomeNote: row.outcome_note ?? '',
    assignee: normalizeEmail(row.assignee),
    closedOn: dateString(row.closed_on),
    createdBy: normalizeEmail(row.created_by),
    createdAt: dateString(row.created_at),
    updatedAt: dateString(row.updated_at)
  } as T;
}

/** Apply the same DB-column coercions `updateCase` needs on top of the field whitelist. */
export function toCaseWriteValues<T extends object>(fields: Partial<T>): Partial<T> {
  const patch = caseWritePatch(fields) as Record<string, unknown>;
  if ('customerId' in patch) patch.customerId = patch.customerId || null;
  if ('outcome' in patch) patch.outcome = dbOutcome((patch.outcome as CaseWriteRow['outcome']) ?? '');
  if ('orderValue' in patch) patch.orderValue = dbNumber((patch.orderValue as number | '') ?? '');
  if ('wonCategories' in patch) patch.wonCategories = joinPipe((patch.wonCategories as string[]) ?? []);
  if ('assignee' in patch) patch.assignee = dbEmail((patch.assignee as string) ?? '');
  if ('closedOn' in patch) patch.closedOn = dbDate((patch.closedOn as string) ?? '');
  return patch as Partial<T>;
}

export async function selectCaseRow(db: DbExecutor, id: string): Promise<CaseWriteDbRow | undefined> {
  const rows = (await db`
    select case_id, customer_id, title, details, source, priority, stage, outcome, order_value,
           won_categories, outcome_note, assignee, closed_on,
           created_by, created_at, updated_at
    from public.cases
    where case_id = ${id}
    limit 1
  `) as CaseWriteDbRow[];
  return rows[0];
}

export async function selectCaseRowForUpdate(db: DbExecutor, id: string): Promise<CaseWriteDbRow | undefined> {
  const rows = (await db`
    select case_id, customer_id, title, details, source, priority, stage, outcome, order_value,
           won_categories, outcome_note, assignee, closed_on,
           created_by, created_at, updated_at
    from public.cases where case_id = ${id} for update
  `) as CaseWriteDbRow[];
  return rows[0];
}

export async function insertCaseRow(db: DbExecutor, row: CaseWriteRow): Promise<void> {
  await db`
    insert into public.cases (
      case_id, customer_id, title, details, source, priority, stage, outcome, order_value,
      won_categories, outcome_note, assignee, closed_on,
      created_by, created_at, updated_at
    )
    values (
      ${row.id}, ${row.customerId || null}, ${row.title}, ${row.details}, ${row.source}, ${row.priority}, ${row.stage},
      ${dbOutcome(row.outcome)}, ${dbNumber(row.orderValue)}, ${joinPipe(row.wonCategories)},
      ${row.outcomeNote}, ${dbEmail(row.assignee)},
      ${dbDate(row.closedOn)}, ${dbEmail(row.createdBy)}, ${row.createdAt}, ${row.updatedAt}
    )
  `;
}

export async function updateCaseRow<T extends object>(db: DbExecutor, id: string, fields: Partial<T>): Promise<void> {
  const statement = buildCaseWriteSql(id, toCaseWriteValues(fields));
  await db.unsafe(statement.query, statement.values as never);
}
