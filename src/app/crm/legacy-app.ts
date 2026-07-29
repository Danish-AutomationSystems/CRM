export type CrmRoute = 'dash' | 'customers' | 'customer' | 'cases' | 'case' | 'admin';

export type CrmUser = {
  email: string;
  name: string;
  role: string;
  level: number;
};

export type CrmSettings = {
  stages: string[];
  outcomes: string[];
  tags: string[];
  types: string[];
  priorities: string[];
  categories: string[];
  sources: string[];
  taxPct: number;
  currency: string;
  company: string;
};

export type DashboardStats = {
  myCustomers: number;
  openOpps: number;
  wonMonthValue: number;
  wonMonthCount: number;
  won2wValue: number;
  won2wCount: number;
};

export type DashboardCase = {
  id: string;
  title: string;
  customerId: string;
  customerName: string;
  stage: string;
};

export type DashboardData = {
  stats: DashboardStats;
  cases: DashboardCase[];
  tickets: DashboardCase[];
};

export type BootstrapData = {
  user: CrmUser;
  settings: CrmSettings;
  nav: {
    admin: boolean;
  };
  isL1: boolean;
  isBackend: boolean;
  peers: Array<{ email: string; name: string; role: string }>;
  self: DashboardData | null;
  recent: Array<{ when: string; who: string; action: string; entity: string; details: string }>;
};

export type QuoteDownloadPayload = {
  source?: string;
  doc?: string;
  pdf?: string;
  downloadUrl?: string;
  docUrl?: string;
  pdfUrl?: string;
};

export type QuoteDownloadAction = {
  label: string;
  href: string;
};

export const readRpcNames = new Set([
  'api_bootstrap',
  'api_workspace',
  'api_dashboard',
  'api_getCase',
  'api_getCustomer',
  'api_searchCustomers',
  'api_myCustomers',
  'api_listCases',
  'api_getQuotation',
  'api_listTemplates',
  'api_listAssignableUsers',
  'api_admin_listUsers',
  'api_admin_links'
]);

export const routeLabels: Record<CrmRoute, string> = {
  dash: 'Dashboard',
  customers: 'Customers',
  customer: 'Customer',
  cases: 'Cases',
  case: 'Case',
  admin: 'Admin'
};

export const levelDescriptions: Record<string, string> = {
  L1: 'Assignments only - sees only cases assigned to them.',
  L2: 'Sales - own dashboard + assignments. Can create customers, cases, quotes, set priority, and assign to others.',
  L3: 'L2 + can view shared-tag L2 dashboards, and edit customer tags and type.',
  L4: 'L3 + full access to all customers and cases across all tags.',
  L5: 'L4 without a sales performance dashboard - back-office, full data access, no Admin.',
  L6: 'L5 + Admin for users, lists, import, and database links. No performance dashboard.'
};

export function roleLevel(user: Pick<CrmUser, 'role' | 'level'> | null): number {
  if (!user) return 1;
  if (Number.isFinite(user.level)) return user.level;
  return Number(String(user.role).slice(1)) || 1;
}

export function canUseQuickLog(user: Pick<CrmUser, 'role' | 'level'> | null): boolean {
  return roleLevel(user) >= 2;
}

export function isAuthFailure(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? '');
  return /auth|unauthori[sz]ed|login|sign in|session/i.test(message);
}

function directDownloadUrl(value: unknown): string {
  const href = String(value ?? '').trim();
  return href.startsWith('/api/download/') ? href : '';
}

export function quoteDownloadActions(quote: QuoteDownloadPayload): QuoteDownloadAction[] {
  const actions: QuoteDownloadAction[] = [];
  const docHref = directDownloadUrl(quote.docUrl ?? quote.doc);
  const pdfHref = directDownloadUrl(quote.pdfUrl ?? quote.pdf ?? quote.downloadUrl);

  if (docHref) {
    actions.push({ label: 'Download document', href: docHref });
  }

  if (pdfHref && pdfHref !== docHref) {
    actions.push({
      label: quote.source === 'External' ? 'Download uploaded file' : 'Download PDF',
      href: pdfHref
    });
  } else if (pdfHref && docHref) {
    actions.push({
      label: quote.source === 'External' ? 'Download uploaded file' : 'Download PDF',
      href: pdfHref
    });
  }

  return actions;
}

export function formatInr(value: number): string {
  return value.toLocaleString('en-IN', {
    maximumFractionDigits: 0
  });
}
