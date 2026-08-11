/**
 * P8: `customers.sei` migrates from free text to `text[]`.
 *
 * `parseSeiText` is the single definition of how a legacy free-text SEI value is split, and
 * `supabase/migrations/0008_customer_sei_multi_select.sql` mirrors it exactly
 * (`regexp_split_to_array(sei, '\s*[|,]\s*')` plus blank removal). It also parses whatever a
 * client sends, which may still be a string from an older build.
 */
export function parseSeiText(value: unknown): string[] {
  const parts = Array.isArray(value) ? value.map((item) => String(item ?? '')) : String(value ?? '').split(/[|,]/);

  return parts.map((part) => part.trim()).filter(Boolean);
}

/**
 * Validates SEI values against the admin-managed list read LIVE from `public.settings`.
 * Zero values is valid - SEI stays optional. An unrecognised name is rejected rather than
 * silently dropped, so a typo cannot quietly lose data.
 */
export function validSei(value: unknown, allowedNames: readonly string[]): string[] {
  const names = parseSeiText(value);
  const allowed = new Set(allowedNames.map((name) => name.trim()).filter(Boolean));

  for (const name of names) {
    if (!allowed.has(name)) {
      throw new Error(
        `"${name}" is not in the SEI list. An L6 admin can add it under Admin > Settings > SEI names.`
      );
    }
  }

  return Array.from(new Set(names));
}
