export type LegacyRoute = 'dash' | 'customers' | 'customer' | 'cases' | 'case' | 'admin';

export interface RouteState {
  route: LegacyRoute;
  arg: string | null;
}

const LEGACY_ROUTES: ReadonlySet<string> = new Set<LegacyRoute>([
  'dash',
  'customers',
  'customer',
  'cases',
  'case',
  'admin'
]);

export function isLegacyRoute(value: string): value is LegacyRoute {
  return LEGACY_ROUTES.has(value);
}

const DASH: RouteState = { route: 'dash', arg: null };

export function routeStateFromSlug(slug: string[] | undefined): RouteState {
  const [first, second] = slug ?? [];

  switch (first) {
    case 'customers':
      return { route: 'customers', arg: null };
    case 'customer':
      return second ? { route: 'customer', arg: second } : DASH;
    case 'cases':
      return { route: 'cases', arg: null };
    case 'case':
      return second ? { route: 'case', arg: second } : DASH;
    case 'admin':
      return { route: 'admin', arg: null };
    case undefined:
      return DASH;
    default:
      return DASH;
  }
}

export function pathFromRouteState({ route, arg }: RouteState): string {
  switch (route) {
    case 'customers':
      return '/crm/customers';
    case 'customer':
      return arg ? `/crm/customer/${encodeURIComponent(arg)}` : '/crm/customers';
    case 'cases':
      return '/crm/cases';
    case 'case':
      return arg ? `/crm/case/${encodeURIComponent(arg)}` : '/crm/cases';
    case 'admin':
      return '/crm/admin';
    case 'dash':
    default:
      return '/crm';
  }
}

export function routeStateFromPathname(pathname: string): RouteState {
  const withoutPrefix = pathname.replace(/^\/crm\/?/, '');
  const slug = withoutPrefix ? withoutPrefix.split('/').filter(Boolean).map(decodeURIComponent) : [];
  return routeStateFromSlug(slug);
}
