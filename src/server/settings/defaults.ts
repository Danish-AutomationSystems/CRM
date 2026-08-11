export type DefaultSettingKey =
  | 'STAGES'
  | 'OUTCOMES'
  | 'QUOTE_STATUSES'
  | 'SOURCES'
  | 'TAGS'
  | 'TYPES'
  | 'PRIORITIES'
  | 'CATEGORIES'
  | 'SEI_NAMES'
  | 'ROLES'
  | 'TAX_PCT'
  | 'CURRENCY'
  | 'COMPANY';

export type DefaultSettings = {
  STAGES: readonly string[];
  OUTCOMES: readonly string[];
  QUOTE_STATUSES: readonly string[];
  SOURCES: readonly string[];
  TAGS: readonly string[];
  TYPES: readonly string[];
  PRIORITIES: readonly string[];
  CATEGORIES: readonly string[];
  SEI_NAMES: readonly string[];
  ROLES: readonly string[];
  TAX_PCT: number;
  CURRENCY: string;
  COMPANY: string;
};

export type DefaultSettingRow = {
  key: DefaultSettingKey;
  value: string;
};

export const DEFAULT_SETTINGS = {
  STAGES: ['Lead', 'Opportunity', 'Quoted'],
  OUTCOMES: ['Won', 'Lost', 'Hold'],
  QUOTE_STATUSES: ['Draft', 'Sent', 'Superseded'],
  SOURCES: ['Direct Enquiry', 'Sales Team', 'Reference', 'Exhibition', 'Tender', 'Existing Customer', 'Other'],
  // 'TO BE FILLED' is the P7 backfill placeholder. It MUST stay in this list: validTags()
  // strips any value not present here, so leaving it out would silently re-empty every
  // backfilled customer on its next save. It is deliberately excluded from SELECTABLE_TAGS
  // below so it is never offered as a choice.
  TAGS: ['Punjab', 'Chandigarh', 'NCR', 'Geo', 'Other', 'TO BE FILLED'],
  TYPES: ['OEM', 'End User', 'EPC', 'Other'],
  PRIORITIES: ['High', 'Medium', 'Low'],
  CATEGORIES: [
    'VFDs',
    'PLC',
    'HMI',
    'Panels',
    'AVEVA',
    'iMCC',
    'Soft Starters',
    'Motion Control & Robotics',
    'Switchgear',
    'Metering',
    'EMS',
    'BMS',
    'Lighting, Switches, Wires',
    'Pneumatics',
    'Service',
    'Others'
  ],
  // P8: ships EMPTY on purpose - no invented Schneider names. This constant only exists so
  // the key is a known setting and gets seeded; the app reads the LIVE public.settings row
  // (see SEI_NAMES_SETTING_KEY), never this value.
  SEI_NAMES: [],
  ROLES: ['L1', 'L2', 'L3', 'L4', 'L5', 'L6'],
  TAX_PCT: 18,
  CURRENCY: 'INR',
  COMPANY: process.env.CRM_COMPANY_NAME ?? 'Automation Systems NG Pvt Ltd'
} as const satisfies DefaultSettings;

/**
 * P8: the settings key holding the admin-managed SEI name list. It MUST be read live from
 * public.settings - reading DEFAULT_SETTINGS.SEI_NAMES instead would reproduce the known
 * write-only-settings drift bug by construction.
 */
export const SEI_NAMES_SETTING_KEY = 'SEI_NAMES';

/** P7: the placeholder written by the location backfill migration. Recognised, never offered. */
export const TAG_TO_BE_FILLED = 'TO BE FILLED';

/** The locations a client may actually pick. Never includes the backfill placeholder. */
export const SELECTABLE_TAGS: readonly string[] = DEFAULT_SETTINGS.TAGS.filter(
  (tag) => tag !== TAG_TO_BE_FILLED
);

const SETTING_KEYS = [
  'STAGES',
  'OUTCOMES',
  'QUOTE_STATUSES',
  'SOURCES',
  'TAGS',
  'TYPES',
  'PRIORITIES',
  'CATEGORIES',
  'SEI_NAMES',
  'ROLES',
  'TAX_PCT',
  'CURRENCY',
  'COMPANY'
] as const satisfies readonly DefaultSettingKey[];

export function defaultSettingRows(): DefaultSettingRow[] {
  return SETTING_KEYS.map((key) => {
    const value = DEFAULT_SETTINGS[key];

    return {
      key,
      value: Array.isArray(value) ? value.join(' | ') : String(value)
    };
  });
}
