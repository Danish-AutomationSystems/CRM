export const CRM_TABLES = [
  'users',
  'customers',
  'contacts',
  'handlers',
  'cases',
  'actions',
  'quotations',
  'quote_boq',
  'recycle_bin',
  'settings',
  'counters',
  'activity_log',
  'import_customers',
  'import_contacts'
] as const;

export type CrmTable = (typeof CRM_TABLES)[number];

export const CRM_ROLES = ['L1', 'L2', 'L3', 'L4', 'L5', 'L6'] as const;
export type CrmRole = (typeof CRM_ROLES)[number];

export const CASE_STAGES = ['Lead', 'Opportunity', 'Quoted'] as const;
export const CASE_OUTCOMES = ['Won', 'Lost', 'Hold'] as const;
export const QUOTE_STATUSES = ['Draft', 'Sent', 'Superseded'] as const;
export const QUOTE_SOURCES = ['Generated', 'External'] as const;

export const CRM_ID_FORMATS = {
  customers: { key: 'customers', prefix: 'CUST', width: 4, yearly: false },
  contacts: { key: 'contacts', prefix: 'CT', width: 4, yearly: false },
  cases: { key: 'cases', prefix: 'CASE', width: 4, yearly: true },
  actions: { key: 'actions', prefix: 'ACT', width: 5, yearly: false },
  quotations: { key: 'quotations', prefix: 'QTN', width: 4, yearly: true }
} as const;

export type CrmIdKind = keyof typeof CRM_ID_FORMATS;
