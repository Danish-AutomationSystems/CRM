/**
 * The workflow layer passes only changed case fields to repositories. This
 * small guard makes the boundary explicit and gives SQL implementations one
 * place to reject accidental whole-row writes.
 */
export const CASE_WRITE_FIELDS = [
  'customerId', 'title', 'details', 'source', 'priority', 'stage', 'outcome', 'orderValue',
  'wonCategories', 'outcomeNote', 'owner', 'extraOwners', 'assignee', 'closedOn', 'updatedAt'
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
  owner: 'owner',
  extraOwners: 'extra_owners',
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
