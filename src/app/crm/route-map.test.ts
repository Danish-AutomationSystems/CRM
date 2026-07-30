import { describe, expect, test } from 'vitest';

import { isLegacyRoute, pathFromRouteState, routeStateFromPathname, routeStateFromSlug } from './route-map';

describe('route-map', () => {
  test('maps slugs to legacy route state', () => {
    expect(routeStateFromSlug(undefined)).toEqual({ route: 'dash', arg: null });
    expect(routeStateFromSlug([])).toEqual({ route: 'dash', arg: null });
    expect(routeStateFromSlug(['customers'])).toEqual({ route: 'customers', arg: null });
    expect(routeStateFromSlug(['customer', 'CUST-1'])).toEqual({ route: 'customer', arg: 'CUST-1' });
    expect(routeStateFromSlug(['cases'])).toEqual({ route: 'cases', arg: null });
    expect(routeStateFromSlug(['case', 'CASE-1'])).toEqual({ route: 'case', arg: 'CASE-1' });
    expect(routeStateFromSlug(['admin'])).toEqual({ route: 'admin', arg: null });
  });

  test('falls back to dash for unknown or incomplete slugs', () => {
    expect(routeStateFromSlug(['bogus'])).toEqual({ route: 'dash', arg: null });
    expect(routeStateFromSlug(['customer'])).toEqual({ route: 'dash', arg: null });
    expect(routeStateFromSlug(['case'])).toEqual({ route: 'dash', arg: null });
  });

  test('maps legacy route state back to a URL path', () => {
    expect(pathFromRouteState({ route: 'dash', arg: null })).toBe('/crm');
    expect(pathFromRouteState({ route: 'customers', arg: null })).toBe('/crm/customers');
    expect(pathFromRouteState({ route: 'customer', arg: 'CUST-1' })).toBe('/crm/customer/CUST-1');
    expect(pathFromRouteState({ route: 'cases', arg: null })).toBe('/crm/cases');
    expect(pathFromRouteState({ route: 'case', arg: 'CASE-1' })).toBe('/crm/case/CASE-1');
    expect(pathFromRouteState({ route: 'admin', arg: null })).toBe('/crm/admin');
  });

  test('parses a pathname back into route state', () => {
    expect(routeStateFromPathname('/crm')).toEqual({ route: 'dash', arg: null });
    expect(routeStateFromPathname('/crm/')).toEqual({ route: 'dash', arg: null });
    expect(routeStateFromPathname('/crm/customers')).toEqual({ route: 'customers', arg: null });
    expect(routeStateFromPathname('/crm/case/CASE-1')).toEqual({ route: 'case', arg: 'CASE-1' });
    expect(routeStateFromPathname('/crm/nonsense')).toEqual({ route: 'dash', arg: null });
  });

  test('round-trips route state through a path and back', () => {
    const states = [
      { route: 'dash', arg: null },
      { route: 'customers', arg: null },
      { route: 'customer', arg: 'CUST-9' },
      { route: 'cases', arg: null },
      { route: 'case', arg: 'CASE-9' },
      { route: 'admin', arg: null }
    ] as const;

    for (const state of states) {
      expect(routeStateFromPathname(pathFromRouteState(state))).toEqual(state);
    }
  });

  test('recognizes only the known legacy route names', () => {
    expect(isLegacyRoute('dash')).toBe(true);
    expect(isLegacyRoute('customers')).toBe(true);
    expect(isLegacyRoute('customer')).toBe(true);
    expect(isLegacyRoute('cases')).toBe(true);
    expect(isLegacyRoute('case')).toBe(true);
    expect(isLegacyRoute('admin')).toBe(true);
    expect(isLegacyRoute('bogus')).toBe(false);
    expect(isLegacyRoute('')).toBe(false);
  });
});
