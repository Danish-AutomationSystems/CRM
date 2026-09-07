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

export function caseWritePatch<T extends object>(fields: Partial<T>): Partial<T> {
  return Object.fromEntries(
    Object.entries(fields).filter(([key, value]) => CASE_WRITE_FIELDS.includes(key as CaseWriteField) && value !== undefined)
  ) as Partial<T>;
}
