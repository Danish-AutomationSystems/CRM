export type DefaultSettingKey =
  | 'STAGES'
  | 'OUTCOMES'
  | 'QUOTE_STATUSES'
  | 'SOURCES'
  | 'TAGS'
  | 'TYPES'
  | 'PRIORITIES'
  | 'CATEGORIES'
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
  TAGS: ['Punjab', 'Chandigarh', 'NCR', 'Geo', 'Other'],
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
  ROLES: ['L1', 'L2', 'L3', 'L4', 'L5', 'L6'],
  TAX_PCT: 18,
  CURRENCY: 'INR',
  COMPANY: process.env.CRM_COMPANY_NAME ?? 'Automation Systems NG Pvt Ltd'
} as const satisfies DefaultSettings;

const SETTING_KEYS = [
  'STAGES',
  'OUTCOMES',
  'QUOTE_STATUSES',
  'SOURCES',
  'TAGS',
  'TYPES',
  'PRIORITIES',
  'CATEGORIES',
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
