'use client';

import React, { useEffect, useRef } from 'react';

import { legacyAppScript, legacyBodyHtml } from './legacy-full.generated';
import { isLegacyRoute, pathFromRouteState, routeStateFromPathname, type LegacyRoute, type RouteState } from './route-map';

declare global {
  interface Window {
    BOOT?: { ok: boolean; reason?: string; email?: string };
    __AS_CRM_FETCH__?: typeof fetch;
    // Globals the eval'd legacy script declares at top level. Indirect eval
    // (window.eval) runs in non-strict global scope, so `var S` and
    // `function nav` become own properties of `window`.
    S?: { route?: unknown; routeArg?: unknown };
    nav?: (name: string, arg?: string | null) => void;
  }
}

interface LegacyFullCrmAppProps {
  initialRoute?: LegacyRoute;
  initialArg?: string | null;
}

// Nav button id gating each tab, mirroring docs/source-appscript/Index.html's
// role-based display:none toggles (navCust/navCases hidden for L1, navAdmin
// hidden below L6). Dash has no gate - it's always reachable.
const NAV_BUTTON_ID: Partial<Record<LegacyRoute, string>> = {
  customers: 'navCust',
  customer: 'navCust',
  cases: 'navCases',
  case: 'navCases',
  admin: 'navAdmin'
};

function isTabVisible(host: HTMLElement, route: LegacyRoute): boolean {
  const buttonId = NAV_BUTTON_ID[route];
  if (!buttonId) return true;
  const button = host.querySelector<HTMLElement>(`#${buttonId}`);
  if (!button) return false;
  return button.style.display !== 'none';
}

// Reads the current legacy route/arg off the DOM + the window.S global.
//
// Ordering invariant: the generated script always executes
// `S.route='X'; setRouteAttr('X'); S.routeArg=id; setTab(...);` in that
// exact order (setRouteAttr fires the data-route mutation BEFORE
// S.routeArg is assigned). This function must only ever be called from a
// MutationObserver callback, which is delivered as a microtask strictly
// after that whole synchronous statement list finishes - so by the time we
// read window.S.routeArg here, it already holds the new id, not the
// previous one. A synchronous read immediately after setAttribute would be
// wrong.
function readLegacyRouteState(main: HTMLElement): RouteState {
  const attrRoute = main.getAttribute('data-route') ?? 'dash';
  let route: LegacyRoute = isLegacyRoute(attrRoute) ? attrRoute : 'dash';
  let arg: string | null = null;

  try {
    const s = window.S;
    if (s && typeof s === 'object') {
      if (typeof s.route === 'string' && isLegacyRoute(s.route)) route = s.route;
      const raw = s.routeArg;
      arg = raw === null || raw === undefined || raw === '' ? null : String(raw);
    }
  } catch {
    // window.S not defined yet, or a hostile getter - fall back to the
    // data-route attribute alone.
  }

  return { route, arg };
}

function callLegacyNav(route: string, arg: string | null) {
  window.nav?.(route, arg ?? null);
}

export const LegacyFullCrmApp: React.FC<LegacyFullCrmAppProps> = ({ initialRoute = 'dash', initialArg = null } = {}) => {
  const hostRef = useRef<HTMLDivElement>(null);
  // Captured once per mount. A fresh URL means a fresh mount (the catch-all
  // route only remounts on a hard navigation/refresh), so this deliberately
  // never updates after first render.
  const targetRef = useRef<RouteState>({ route: initialRoute, arg: initialArg });

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return undefined;

    host.innerHTML = legacyBodyHtml;
    const previousBoot = window.BOOT;
    const fetchImpl = globalThis.fetch
      ? globalThis.fetch.bind(globalThis)
      : window.fetch.bind(window);
    window.BOOT = previousBoot ?? { ok: true };
    window.__AS_CRM_FETCH__ = fetchImpl;

    const main = host.querySelector<HTMLElement>('#main');

    // One-shot flag: armed only when the URL asked for something other than
    // dash. Consumed on the FIRST data-route mutation after mount, whichever
    // comes first - boot's always-dash landing, or (if boot never reaches
    // vDash) a user click.
    let pendingRestore = targetRef.current.route !== 'dash';
    let restoreTimer: ReturnType<typeof setTimeout> | undefined;

    const observer = main
      ? new MutationObserver(() => {
          if (pendingRestore) {
            pendingRestore = false;
            const { route: bootRoute } = readLegacyRouteState(main);
            if (bootRoute === 'dash') {
              // Boot always lands on dash first; vDash's own render .then
              // has no route guard, so restoring synchronously here would
              // be clobbered. Defer to a macrotask so vDash's render lands
              // first, then let the target view's own guarded .then win.
              restoreTimer = setTimeout(() => {
                const target = targetRef.current;
                if (!isTabVisible(host, target.route)) {
                  // Role can't see this tab (e.g. L1 deep-linking /crm/cases).
                  // Leave them on dash and clean up the URL - replaceState so
                  // Back still exits the CRM instead of bouncing here again.
                  window.history.replaceState(null, '', '/crm');
                  return;
                }
                callLegacyNav(target.route, target.arg);
              }, 0);
              return;
            }
            // Boot's vDash never ran (a failed-boot path resolved before any
            // mutation, and the user already clicked somewhere) - don't
            // override their gesture, just fall through to normal sync below.
          }

          const nextPath = pathFromRouteState(readLegacyRouteState(main));
          if (nextPath === window.location.pathname) return;
          window.history.pushState(null, '', nextPath);
        })
      : null;

    observer?.observe(main as HTMLElement, { attributes: true, attributeFilter: ['data-route'] });

    window.eval(`var BOOT = window.BOOT || { ok: true };\n${legacyAppScript}`);

    if (window.BOOT?.ok === false) {
      // Synchronous lock card: no view was ever rendered, no mutation will
      // ever fire. Disarm immediately rather than leaving a stale flag.
      pendingRestore = false;
    }

    const handlePopState = () => {
      const { route, arg } = routeStateFromPathname(window.location.pathname);
      callLegacyNav(route, arg);
    };
    window.addEventListener('popstate', handlePopState);

    return () => {
      window.removeEventListener('popstate', handlePopState);
      if (restoreTimer !== undefined) clearTimeout(restoreTimer);
      observer?.disconnect();
      host.innerHTML = '';
      window.BOOT = previousBoot;
    };
  }, []);

  return <div ref={hostRef} />;
};
