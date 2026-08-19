import { parsePipe } from '../domain/lists';
import { DEFAULT_SETTINGS, TAG_TO_BE_FILLED } from './defaults';

export type ConfigListKey = 'TAGS' | 'TYPES' | 'PRIORITIES' | 'CATEGORIES' | 'SEI_NAMES';

export type LiveSettings = {
  tags: string[];
  types: string[];
  priorities: string[];
  categories: string[];
  seiNames: string[];
  taxPct: number;
  currency: string;
  company: string;
};

export type SettingsReader = {
  listSettings(): Promise<Array<{ key: string; value: string }>>;
};

/**
 * The one place the request path learns what the configurable lists contain.
 *
 * Before this existed, api_admin_saveSettings wrote public.settings and every
 * consumer read the hardcoded DEFAULT_SETTINGS instead, so an admin's edit saved
 * and was then ignored. DEFAULT_SETTINGS is now seed-and-fallback only.
 *
 * Cached per request by the caller, never process-wide: on serverless, a
 * process-wide cache means one warm instance serves stale config while another
 * serves fresh, which is worse than no cache because it is intermittent.
 */
export async function loadSettings(repo: SettingsReader): Promise<LiveSettings> {
  const rows = await repo.listSettings();
  const byKey = new Map(rows.map((row) => [row.key, row.value]));

  const list = (key: ConfigListKey, fallback: readonly string[]): string[] => {
    const parsed = parsePipe(byKey.get(key) ?? '');
    return parsed.length ? parsed : [...fallback];
  };

  // A blank string is indistinguishable from "never set" and must not be read
  // as a deliberate value. Number('') is 0, which is finite, so coercion alone
  // cannot tell "admin left this blank" apart from "admin typed 0". Treat a
  // blank/whitespace-only row as absent explicitly, before coercion, so a
  // deliberate 0 (a real, non-blank "0") still comes through as 0.
  const rawTax = (byKey.get('TAX_PCT') ?? '').trim();
  const storedTax = rawTax === '' ? NaN : Number(rawTax);

  return {
    tags: list('TAGS', DEFAULT_SETTINGS.TAGS),
    types: list('TYPES', DEFAULT_SETTINGS.TYPES),
    priorities: list('PRIORITIES', DEFAULT_SETTINGS.PRIORITIES),
    categories: list('CATEGORIES', DEFAULT_SETTINGS.CATEGORIES),
    // No fallback: an admin may legitimately empty this list, and defaulting it
    // would resurrect names they deleted.
    seiNames: parsePipe(byKey.get('SEI_NAMES') ?? ''),
    taxPct: Number.isFinite(storedTax) ? storedTax : DEFAULT_SETTINGS.TAX_PCT,
    currency: (byKey.get('CURRENCY') ?? '').trim() || DEFAULT_SETTINGS.CURRENCY,
    company: (byKey.get('COMPANY') ?? '').trim() || DEFAULT_SETTINGS.COMPANY
  };
}

/** What a client may pick. Never includes the location-backfill placeholder. */
export function selectableTags(settings: LiveSettings): string[] {
  return settings.tags.filter((tag) => tag !== TAG_TO_BE_FILLED);
}
