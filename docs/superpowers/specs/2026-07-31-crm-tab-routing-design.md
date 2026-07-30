# CRM Tab Routing — Design Spec (2026-07-31)

## Problem

The CRM app renders behind a single Next.js route, `/crm`. Inside it, a ported
legacy Apps Script client (`legacy-full.generated.ts`, eval'd into `#main` by
`LegacyFullCrmApp.tsx`) switches views (Dashboard, Customers, Cases, Admin,
and Customer/Case detail) by mutating an in-memory `S.route`/`S.routeArg`
variable and replacing `#main`'s `innerHTML`. Nothing ever touches
`window.location`. Refreshing the page always restarts at Dashboard,
regardless of which tab the user was on. There is also no working browser
back/forward between tabs, and no way to bookmark/share a link to a
specific tab.

## Goal

Reflect the active tab (and, for detail views, the selected record id) in the
URL, so that:

- Refreshing the page keeps the user on the same tab/detail view.
- Browser back/forward moves between previously visited tabs.
- Existing `/crm` bookmarks/links keep working (default to Dashboard).
- No business logic, RPC behavior, or auth behavior changes.

## Non-goals

- No change to legacy view rendering, RPC calls, or business logic.
- No change to `legacy-full-ui.css` or visual design (already revamped).
- No server-rendering of legacy view content — views remain client-eval'd.
- No new state library; `S.route`/`S.routeArg` remains the source of truth
  at runtime, URL is a mirror of it.

## URL scheme

Next.js optional catch-all route: `src/app/crm/[[...slug]]/page.tsx`.

| URL | slug | legacy route | legacy arg |
|---|---|---|---|
| `/crm` | `[]` | `dash` | `null` |
| `/crm/customers` | `['customers']` | `customers` | `null` |
| `/crm/customer/:id` | `['customer', id]` | `customer` | `id` |
| `/crm/cases` | `['cases']` | `cases` | `null` |
| `/crm/case/:id` | `['case', id]` | `case` | `id` |
| `/crm/admin` | `['admin']` | `admin` | `null` |

Unrecognized slugs fall back to `dash` (same as no slug), rather than 404,
since the legacy client itself has no route validation/404 concept.

`src/middleware.ts` already protects any path starting with `/crm` by
prefix match (`PROTECTED_PREFIXES`), so no middleware change is required;
unauthenticated visits to any of the above redirect to
`/login?next=<encoded original path>`, exactly as `/crm` does today.

## Mechanism

1. **Source of truth stays legacy JS.** `docs/source-appscript/Index.html`
   already sets `S.route`/`S.routeArg` in exactly 6 places (view functions
   `vDash`, `vCustomers`, `vCustomer`, `vCases`, `vCase`, `vAdmin`). The
   generator (`scripts/port-legacy-index.mjs`) already rewrites every
   `S.route='X'` assignment to also call `setRouteAttr('X')`, which stamps
   `<main id="main" data-route="X">` — added purely as a test hook. We
   extend `setRouteAttr` to also accept the arg and stamp it as
   `data-route-arg`, so the DOM fully describes the current view.

2. **DOM → URL.** `LegacyFullCrmApp.tsx` attaches a `MutationObserver` to
   `#main` watching `data-route`/`data-route-arg` attribute changes. On
   change, it computes the corresponding path from the table above and
   calls `window.history.pushState(null, '', path)` (only when the path
   actually differs from the current one, to avoid duplicate history
   entries from unrelated re-renders of the same view).

3. **URL → DOM (initial load).** The catch-all page parses `params.slug`
   server-side into an initial `{ route, arg }` and passes it as a prop
   through `CrmApp` to `LegacyFullCrmApp`. After the legacy script is
   eval'd and its own boot sequence finishes (which today always lands on
   `dash`), the wrapper calls the legacy `nav(route, arg)` function once
   more, if the initial route isn't `dash`, to restore the requested view.
   The legacy script already exposes `nav` on `window` (global function
   declared at top level of the eval'd script), so this is a plain
   `window.nav(route, arg)` call guarded with `typeof window.nav ===
   'function'`.

4. **Back/forward.** The wrapper adds a `popstate` listener that re-parses
   `window.location.pathname` into `{ route, arg }` and calls `window.nav`
   again, mirroring step 3. This makes browser back/forward move between
   tabs.

5. **No React remount across tabs.** Because the catch-all segment maps to
   a single page component instance, navigating between `/crm/customers`
   and `/crm/cases` via the in-app nav buttons never triggers a Next.js
   client navigation (we use `history.pushState` directly, not
   `next/navigation`'s router) — so the legacy app is never torn down and
   re-eval'd while the user works. Only a hard browser refresh or a
   directly-typed/bookmarked URL goes through the normal Next.js server
   render + client mount + initial-route-restore path described in step 3.

## Files touched

- `docs/source-appscript/Index.html` — no changes needed; existing
  `S.route='X'; S.routeArg=Y;` assignment sites are already regex-matched
  by the generator.
- `scripts/port-legacy-index.mjs` — extend the `setRouteAttr` helper
  injection and the `S.route=` regex rewrite to also capture/stamp
  `S.routeArg`.
- `src/app/crm/legacy-full.generated.ts` — regenerated output only, via
  `node scripts/port-legacy-index.mjs`. Never hand-edited.
- `src/app/crm/page.tsx` → replaced by `src/app/crm/[[...slug]]/page.tsx`.
- `src/app/crm/CrmApp.tsx` — forwards `initialRoute`/`initialArg` props.
- `src/app/crm/LegacyFullCrmApp.tsx` — accepts `initialRoute`/`initialArg`,
  adds the `MutationObserver` + `popstate` wiring described above, cleans
  both up on unmount.

## Testing strategy (TDD)

Written before implementation, expected to fail (red) until each piece
lands:

1. **Generator unit test** (`scripts/port-legacy-index.test.mjs` or
   extending an existing generator test if one exists) — asserts the
   generated script stamps both `data-route` and `data-route-arg` and that
   `setRouteAttr` accepts an arg.
2. **Vitest jsdom test** (`src/app/crm/legacy-app.test.ts`) — extends
   existing coverage:
   - After `window.eval('nav("cases")')`, `#main` has `data-route="cases"`
     and `window.location.pathname` (jsdom) becomes `/crm/cases` via
     `pushState`.
   - Mounting `LegacyFullCrmApp` with `initialRoute="admin"` results in
     `#main[data-route="admin"]` after boot, without a manual nav click.
   - A `popstate` event with a mocked `location.pathname` of `/crm/cases`
     causes `#main` to become `data-route="cases"`.
3. **Playwright e2e** (`tests/e2e/crm-smoke.spec.ts`) — extends existing
   authenticated flow:
   - Clicking `Customers`/`Cases`/`Admin` nav buttons updates
     `page.url()` to `/crm/customers`, `/crm/cases`, `/crm/admin`.
   - Reloading the page on `/crm/cases` keeps `data-route="cases"` and the
     `Cases` nav button marked active, instead of resetting to `dash`.
   - Direct navigation (`page.goto`) to `/crm/admin` while authenticated
     renders the admin view without a nav click.
   - Unauthenticated `page.goto('/crm/cases')` redirects to
     `/login?next=%2Fcrm%2Fcases` (extends the existing `/crm` redirect
     assertion).

## Risks / mitigations

- **Generator regex fragility**: the `S.route='X'; S.routeArg=Y;` pattern
  must be matched precisely across all 6 sites, including `routeArg=null`
  and `routeArg=id` forms. Mitigate by testing the generated output
  directly (test 1 above) rather than trusting the regex by inspection.
- **Duplicate/loop history writes**: the `MutationObserver` callback must
  no-op when the computed path already equals `window.location.pathname`,
  otherwise resize/rerender hooks that redraw the current view (Index.html
  lines ~1707-1722) could spam `pushState`.
- **`popstate` re-entrancy**: the `popstate` handler calling `window.nav`
  will itself trigger the `MutationObserver`, which would recompute the
  same (already current) path and no-op per the above mitigation — not an
  infinite loop.
