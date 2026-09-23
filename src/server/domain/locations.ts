/**
 * A customer holds exactly one location. public.customers enforces the same rule with
 * customers_single_location_check (migration 0016); every path that creates or edits a
 * customer calls this first, so users get a legible message instead of a constraint error.
 */
export function requireSingleLocation(tags: readonly string[]): string[] {
  if (!tags.length) {
    throw new Error('Pick at least one location for this customer.');
  }
  if (tags.length > 1) {
    throw new Error('A customer can have only one location.');
  }
  return [...tags];
}
