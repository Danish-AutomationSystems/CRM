import http from 'node:http';

import { expect, test } from '@playwright/test';
import type { BrowserContext, Page } from '@playwright/test';

const fakeSupabasePort = 3999;
const fakeSupabaseUrl = `http://127.0.0.1:${fakeSupabasePort}`;
const storageCookieName = 'sb-127-auth-token';

test.describe.configure({ mode: 'serial' });

function isFakeSupabaseConfigured(): boolean {
  return process.env.NEXT_PUBLIC_SUPABASE_URL === fakeSupabaseUrl;
}

function createFakeSession() {
  return {
    access_token: 'playwright-access-token',
    refresh_token: 'playwright-refresh-token',
    expires_at: Math.floor(Date.now() / 1000) + 60 * 60,
    expires_in: 60 * 60,
    token_type: 'bearer',
    user: {
      id: 'playwright-user',
      aud: 'authenticated',
      role: 'authenticated',
      email: 'playwright@automationsystems.org',
      app_metadata: {},
      user_metadata: {
        name: 'Playwright Admin'
      },
      created_at: new Date().toISOString()
    }
  };
}

function bootPayload() {
  return {
    user: {
      email: 'playwright@automationsystems.org',
      name: 'Playwright Admin',
      role: 'L6',
      level: 6,
      allowedTags: ['*'],
      active: true
    },
    settings: {
      tags: ['Punjab', 'Chandigarh', 'NCR'],
      types: ['OEM', 'End User'],
      stages: ['Lead', 'Opportunity', 'Quoted'],
      outcomes: ['Won', 'Lost', 'Hold'],
      priorities: ['High', 'Medium', 'Low'],
      categories: ['Lighting'],
      seiNames: ['Ravi Kumar', 'Anita Rao'],
      taxPct: 18,
      currency: 'INR',
      company: 'Automation Systems NG Pvt Ltd'
    },
    nav: { admin: true },
    peers: [
      { email: 'sales@automationsystems.org', name: 'Sales User', role: 'L2', hasLogin: true },
      // P9: the virtual Direct account now rides along in the picker for L4+.
      { email: 'direct', name: 'Direct', role: 'L2', hasLogin: false }
    ],
    self: {
      stats: {
        myCustomers: 4,
        openOpps: 2,
        wonMonthValue: 120000,
        wonMonthCount: 1,
        won2wValue: 40000,
        won2wCount: 1
      },
      tickets: []
    },
    recent: [],
    isL1: false,
    isBackend: true
  };
}

const caseSummary = {
  id: 'CASE-2026-0001',
  title: 'Panel upgrade',
  customerName: 'Acme Controls',
  stage: 'Opportunity',
  outcome: '',
  quotedValue: 120000,
  owners: ['Playwright Admin'],
  assignee: 'Sales User',
  updatedOn: '2026-07-29'
};

const customerSummary = {
  id: 'CUST-2026-0001',
  name: 'Acme Controls',
  tags: ['Punjab'],
  type: 'OEM',
  priority: 'High',
  area: 'Mohali',
  // P8: sei is a string[] now, not free text.
  sei: ['Ravi Kumar'],
  remarks: '',
  contacts: 1,
  handlers: [{ name: 'Playwright Admin', email: 'playwright@automationsystems.org' }]
};

function customerDetailPayload() {
  return {
    access: 'FULL',
    customer: {
      id: customerSummary.id,
      name: customerSummary.name,
      tags: customerSummary.tags,
      type: customerSummary.type,
      priority: customerSummary.priority,
      status: '',
      area: customerSummary.area,
      sei: customerSummary.sei,
      remarks: '',
      address: '',
      gstin: '',
      website: '',
      notes: '',
      createdOn: '2026-07-01',
      createdBy: 'playwright@automationsystems.org'
    },
    handlers: customerSummary.handlers,
    contacts: [{ id: 'CT-1', name: 'Primary contact', phone: '9999999999', email: '', designation: '', notes: '' }],
    // Deliberately reuses caseSummary, whose long owner/assignee email
    // strings are exactly what previously blew the embedded Cases table
    // wider than its card (see the "customer detail page does not
    // overflow" test below).
    cases: [{ ...caseSummary, orderValue: 0, quotes: 0 }],
    quotes: []
  };
}

function rpcData(fn: string) {
  const boot = bootPayload();
  switch (fn) {
    case 'api_workspace':
      return {
        boot,
        customers: { scope: 'all', total: 0, customers: [] },
        cases: [caseSummary]
      };
    case 'api_bootstrap':
      return boot;
    case 'api_listCases':
      return [caseSummary];
    case 'api_myCustomers':
      return { scope: 'mine', total: 0, customers: [] };
    case 'api_allCustomers':
      return {
        scope: 'all',
        total: 1,
        customers: [customerSummary],
        canEditPriority: true,
        canEditClass: true,
        canDelete: true,
        tags: ['Punjab', 'Chandigarh', 'NCR'],
        types: ['OEM', 'End User'],
        priorities: ['High', 'Medium', 'Low'],
        // P8: the admin-managed SEI list the grid dropdown is built from.
        seiNames: ['Ravi Kumar', 'Anita Rao']
      };
    case 'api_getCustomer':
      return customerDetailPayload();
    case 'api_updateCustomer':
      return { ok: true };
    case 'api_getCase':
      return {
        customer: { id: 'CUST-2026-0001', name: 'Acme Controls' },
        case: {
          ...caseSummary,
          customerId: 'CUST-2026-0001',
          details: 'Replace panel controls',
          orderValue: '',
          wonCategories: [],
          // P10: owners now say WHY they own the case.
          ownerList: [
            { email: 'playwright@automationsystems.org', name: 'Playwright Admin', source: 'creator', removable: true }
          ]
        },
        canEdit: true,
        canAssignTicket: true,
        quotes: [
          {
            quoteNo: 'QTN-2026-0001',
            rev: 0,
            title: 'Panel upgrade quote',
            status: 'Sent',
            date: '2026-07-29',
            by: 'Playwright Admin',
            currency: 'INR',
            total: 120000,
            pdf: '/api/download/quote/QTN-2026-0001/0?format=html'
          }
        ],
        history: [{ when: '2026-07-29', who: 'Playwright Admin', action: 'Created', details: 'Smoke test case' }]
      };
    case 'api_getQuotation':
      return {
        customer: { id: 'CUST-2026-0001', name: 'Acme Controls' },
        quote: {
          quoteNo: 'QTN-2026-0001',
          rev: 0,
          caseId: 'CASE-2026-0001',
          source: 'Generated',
          title: 'Panel upgrade quote',
          status: 'Sent',
          date: '2026-07-29',
          by: 'Playwright Admin',
          currency: 'INR',
          subtotal: 101695,
          taxPct: 18,
          taxAmount: 18305,
          total: 120000,
          validUntil: '2026-08-29',
          notes: '',
          templateName: 'Default',
          doc: '/api/download/quote/QTN-2026-0001/0?format=doc',
          pdf: '/api/download/quote/QTN-2026-0001/0?format=html'
        },
        blocks: [{ title: 'Items', headers: ['Item', 'Amount'], rows: [['Panel upgrade', '120000']] }],
        revisions: [{ quoteNo: 'QTN-2026-0001', rev: 0, status: 'Sent', date: '2026-07-29', total: 120000 }]
      };
    // The Case-owners modal builds its "add another owner" picker from this, so
    // the modal renders empty without it - which is what made the P10 test fail.
    case 'api_listAssignableUsers':
      return [
        { email: 'playwright@automationsystems.org', name: 'Playwright Admin', role: 'L6' },
        { email: 'sales@automationsystems.org', name: 'Sales User', role: 'L2' }
      ];
    case 'api_admin_listUsers':
      return [boot.user];
    case 'api_admin_links':
      return { database: 'Supabase Postgres', supabaseUrl: fakeSupabaseUrl, tables: ['customers', 'cases', 'quotations'] };
    case 'api_admin_listRecycle':
      return { customers: [] };
    default:
      throw new Error(`Unexpected RPC ${fn}`);
  }
}

let fakeSupabaseServer: http.Server | undefined;

test.beforeAll(async () => {
  if (!isFakeSupabaseConfigured()) return;

  fakeSupabaseServer = http.createServer((request, response) => {
    if (request.url === '/auth/v1/user') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify(createFakeSession().user));
      return;
    }

    response.writeHead(404, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ error: 'not found' }));
  });

  await new Promise<void>((resolve) => {
    fakeSupabaseServer?.listen(fakeSupabasePort, '127.0.0.1', resolve);
  });
});

test.afterAll(async () => {
  if (!fakeSupabaseServer) return;

  await new Promise<void>((resolve, reject) => {
    fakeSupabaseServer?.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
});

test('unauthenticated CRM visit reaches the login gate', async ({ page }) => {
  await page.goto('/crm');

  await expect(page).toHaveURL(/\/login\?next=%2Fcrm$/);
  await expect(page.getByRole('heading', { name: 'AS CRM' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Continue with Google' })).toBeVisible();
});

test('unauthenticated deep links to a CRM subroute redirect back to that subroute after login', async ({ page }) => {
  await page.goto('/crm/cases');
  await expect(page).toHaveURL(/\/login\?next=%2Fcrm%2Fcases$/);

  await page.goto('/crm/case/CASE-2026-0001');
  await expect(page).toHaveURL(/\/login\?next=%2Fcrm%2Fcase%2FCASE-2026-0001$/);
});

async function setUpAuthenticatedSession(context: BrowserContext, page: Page) {
  await context.addCookies([
    {
      name: storageCookieName,
      value: JSON.stringify(createFakeSession()),
      domain: '127.0.0.1',
      path: '/',
      sameSite: 'Lax',
      httpOnly: false,
      secure: false,
      expires: Math.floor(Date.now() / 1000) + 60 * 60
    }
  ]);

  await page.route('**/api/rpc', async (route) => {
    const request = route.request();
    const body = request.postDataJSON() as { fn: string };

    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        ok: true,
        data: rpcData(body.fn)
      })
    });
  });
}

test('mocked authenticated session renders critical CRM route containers', async ({ context, page }) => {
  test.skip(
    !isFakeSupabaseConfigured(),
    `Set NEXT_PUBLIC_SUPABASE_URL=${fakeSupabaseUrl} and NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY to a dummy value to run the mocked-auth shell smoke test.`
  );

  await setUpAuthenticatedSession(context, page);

  await page.goto('/crm');

  await expect(page.getByText('AS CRM')).toBeVisible();
  await expect(page.getByTestId('crm-route')).toHaveAttribute('data-route', 'dash');
  await expect(page.getByRole('heading', { name: 'Overview' })).toBeVisible();

  await page.getByRole('button', { name: 'Customers' }).first().click();
  await expect(page.getByTestId('crm-route')).toHaveAttribute('data-route', 'customers');
  await expect(page.getByRole('heading', { name: 'Customers' })).toBeVisible();
  await expect(page.locator('#custQ')).toBeVisible();
  await expect(page.locator('table.grid input.ce').first()).toHaveValue(customerSummary.name);

  await page.getByRole('button', { name: 'Cases' }).click();
  await expect(page.getByTestId('crm-route')).toHaveAttribute('data-route', 'cases');
  await expect(page.getByRole('heading', { name: 'Cases' })).toBeVisible();
  await expect(page.locator('#cf_q')).toBeVisible();

  await page.getByText('Panel upgrade').first().click();
  await expect(page.getByTestId('crm-route')).toHaveAttribute('data-route', 'case');
  await expect(page.getByRole('heading', { name: 'Panel upgrade' })).toBeVisible();
  await page.getByTestId('crm-route').getByRole('button', { name: 'Open' }).click();
  await expect(page.getByRole('link', { name: 'Download PDF' })).toHaveAttribute(
    'href',
    '/api/download/quote/QTN-2026-0001/0?format=html'
  );
  await page.getByRole('button', { name: 'Close' }).click();

  await page.getByRole('button', { name: 'Admin' }).click();
  await expect(page.getByTestId('crm-route')).toHaveAttribute('data-route', 'admin');
  await expect(page.getByRole('heading', { name: 'Admin' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Run customer import' })).toBeVisible();
});

test('clicking a tab updates the URL without remounting the legacy app', async ({ context, page }) => {
  test.skip(
    !isFakeSupabaseConfigured(),
    `Set NEXT_PUBLIC_SUPABASE_URL=${fakeSupabaseUrl} and NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY to a dummy value to run the mocked-auth shell smoke test.`
  );

  await setUpAuthenticatedSession(context, page);
  await page.goto('/crm');
  await expect(page.getByTestId('crm-route')).toHaveAttribute('data-route', 'dash');

  // Stamp a sentinel that only survives if the legacy app's global scope
  // (and the React host it's eval'd into) is never torn down. If tab
  // navigation ever regresses to next/navigation's router.push instead of
  // a raw history.pushState, the catch-all segment's client subtree
  // remounts and this sentinel is lost.
  await page.evaluate(() => {
    (window as unknown as { __mountProbe?: string }).__mountProbe = 'still-mounted';
  });

  await page.getByRole('button', { name: 'Cases' }).first().click();
  await expect(page).toHaveURL(/\/crm\/cases$/);
  await expect(page.getByTestId('crm-route')).toHaveAttribute('data-route', 'cases');
  expect(await page.evaluate(() => (window as unknown as { __mountProbe?: string }).__mountProbe)).toBe(
    'still-mounted'
  );
});

test('opening a case shows its id in the URL', async ({ context, page }) => {
  test.skip(
    !isFakeSupabaseConfigured(),
    `Set NEXT_PUBLIC_SUPABASE_URL=${fakeSupabaseUrl} and NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY to a dummy value to run the mocked-auth shell smoke test.`
  );

  await setUpAuthenticatedSession(context, page);
  await page.goto('/crm');

  await page.getByRole('button', { name: 'Cases' }).first().click();
  await page.getByText('Panel upgrade').first().click();

  await expect(page).toHaveURL(/\/crm\/case\/CASE-2026-0001$/);
  await expect(page.getByTestId('crm-route')).toHaveAttribute('data-route', 'case');
});

test('refreshing a case view keeps the user on that case instead of resetting to the dashboard', async ({
  context,
  page
}) => {
  test.skip(
    !isFakeSupabaseConfigured(),
    `Set NEXT_PUBLIC_SUPABASE_URL=${fakeSupabaseUrl} and NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY to a dummy value to run the mocked-auth shell smoke test.`
  );

  await setUpAuthenticatedSession(context, page);
  await page.goto('/crm');
  await page.getByRole('button', { name: 'Cases' }).first().click();
  await page.getByText('Panel upgrade').first().click();
  await expect(page).toHaveURL(/\/crm\/case\/CASE-2026-0001$/);

  await page.reload();

  await expect(page).toHaveURL(/\/crm\/case\/CASE-2026-0001$/);
  await expect(page.getByTestId('crm-route')).toHaveAttribute('data-route', 'case');
  await expect(page.getByRole('heading', { name: 'Panel upgrade' })).toBeVisible();
});

test('a cold deep link renders the target view directly, without visiting the dashboard first', async ({
  context,
  page
}) => {
  test.skip(
    !isFakeSupabaseConfigured(),
    `Set NEXT_PUBLIC_SUPABASE_URL=${fakeSupabaseUrl} and NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY to a dummy value to run the mocked-auth shell smoke test.`
  );

  await setUpAuthenticatedSession(context, page);

  await page.goto('/crm/admin');

  await expect(page.getByTestId('crm-route')).toHaveAttribute('data-route', 'admin');
  await expect(page.getByRole('heading', { name: 'Admin' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Run customer import' })).toBeVisible();
});

test('browser back and forward move between previously visited tabs', async ({ context, page }) => {
  test.skip(
    !isFakeSupabaseConfigured(),
    `Set NEXT_PUBLIC_SUPABASE_URL=${fakeSupabaseUrl} and NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY to a dummy value to run the mocked-auth shell smoke test.`
  );

  await setUpAuthenticatedSession(context, page);
  await page.goto('/crm');

  await page.getByRole('button', { name: 'Customers' }).first().click();
  await expect(page).toHaveURL(/\/crm\/customers$/);

  await page.getByRole('button', { name: 'Cases' }).click();
  await expect(page).toHaveURL(/\/crm\/cases$/);

  await page.goBack();
  await expect(page).toHaveURL(/\/crm\/customers$/);
  await expect(page.getByTestId('crm-route')).toHaveAttribute('data-route', 'customers');
  await expect(page.getByRole('heading', { name: 'Customers' })).toBeVisible();

  await page.goBack();
  await expect(page).toHaveURL(/\/crm$/);
  await expect(page.getByTestId('crm-route')).toHaveAttribute('data-route', 'dash');
  await expect(page.getByRole('heading', { name: 'Overview' })).toBeVisible();

  await page.goForward();
  await expect(page).toHaveURL(/\/crm\/customers$/);
  await expect(page.getByTestId('crm-route')).toHaveAttribute('data-route', 'customers');
});

const mobileNavBreakpoints = [
  { name: 'phone (390x844)', width: 390, height: 844 },
  { name: 'tablet portrait (768x1024)', width: 768, height: 1024 }
];

for (const bp of mobileNavBreakpoints) {
  test(`the collapsed nav drawer spans the full header width on ${bp.name}`, async ({ context, page }) => {
    test.skip(
      !isFakeSupabaseConfigured(),
      `Set NEXT_PUBLIC_SUPABASE_URL=${fakeSupabaseUrl} and NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY to a dummy value to run the mocked-auth shell smoke test.`
    );

    // Regression test: the mobile nav's `flex:1` (inherited from the
    // desktop rule, flex-basis 0%) meant an explicit `width:100%` alone did
    // not force it onto its own row - it grew to fill only the leftover
    // space next to the user-info chip, splitting the screen into two
    // narrow columns instead of stacking full-width below the header.
    await page.setViewportSize({ width: bp.width, height: bp.height });
    await setUpAuthenticatedSession(context, page);

    await page.goto('/crm');
    await expect(page.getByTestId('crm-route')).toHaveAttribute('data-route', 'dash');

    // Regression test: the toggle previously sat to the right of the brand
    // title (after nav, before uchip in DOM order, no explicit `order`),
    // easy to miss and confusable with the brand mark's own bar icon. It
    // must lead the header row, left of the brand.
    const toggleBox = await page.locator('#navToggle').boundingBox();
    const brandBox = await page.locator('.brand').boundingBox();
    const uchipBox = await page.locator('.uchip').boundingBox();
    expect(toggleBox).not.toBeNull();
    expect(brandBox).not.toBeNull();
    expect(uchipBox).not.toBeNull();
    expect(toggleBox!.x).toBeLessThan(brandBox!.x);
    // Toggle, brand, and the user chip should all sit on the header's first
    // row together (a generous tolerance since this only checks "same row",
    // not pixel-perfect vertical centering).
    expect(Math.abs(toggleBox!.y - brandBox!.y)).toBeLessThan(30);
    expect(Math.abs(toggleBox!.y - uchipBox!.y)).toBeLessThan(30);

    await page.locator('#navToggle').click();
    await expect(page.locator('#nav')).toHaveClass(/nav-open/);

    const navBox = await page.locator('#nav').boundingBox();
    const hwrapBox = await page.locator('.hwrap').boundingBox();
    expect(navBox).not.toBeNull();
    expect(hwrapBox).not.toBeNull();
    expect(navBox!.width).toBeGreaterThan(hwrapBox!.width * 0.9);

    const hasHorizontalOverflow = await page.evaluate(
      () => document.documentElement.scrollWidth > document.documentElement.clientWidth
    );
    expect(hasHorizontalOverflow).toBe(false);
  });
}

test('the customer detail page does not overflow the mobile viewport', async ({ context, page }) => {
  test.skip(
    !isFakeSupabaseConfigured(),
    `Set NEXT_PUBLIC_SUPABASE_URL=${fakeSupabaseUrl} and NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY to a dummy value to run the mocked-auth shell smoke test.`
  );

  // Regression test: the embedded Cases table's long owner/assignee email
  // columns forced <table> past its card's width with nowhere to go,
  // widening #main/body/<html> along with it - the whole page became wider
  // than the viewport, matching the "have to pinch-zoom out to see it"
  // report. Fixed by making every <table> scroll its own overflow
  // internally (src/app/crm/legacy-full-ui.css).
  await page.setViewportSize({ width: 412, height: 915 });
  await setUpAuthenticatedSession(context, page);

  await page.goto('/crm/customer/CUST-2026-0001');
  await expect(page.getByTestId('crm-route')).toHaveAttribute('data-route', 'customer');
  await expect(page.getByRole('heading', { name: 'Acme Controls' })).toBeVisible();

  const overflow = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth
  }));
  expect(overflow.scrollWidth).toBe(overflow.clientWidth);
});

test('the cases list table does not overflow the mobile viewport', async ({ context, page }) => {
  test.skip(
    !isFakeSupabaseConfigured(),
    `Set NEXT_PUBLIC_SUPABASE_URL=${fakeSupabaseUrl} and NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY to a dummy value to run the mocked-auth shell smoke test.`
  );

  await page.setViewportSize({ width: 390, height: 844 });
  await setUpAuthenticatedSession(context, page);

  await page.goto('/crm/cases');
  await expect(page.getByTestId('crm-route')).toHaveAttribute('data-route', 'cases');
  await expect(page.getByText('Panel upgrade').first()).toBeVisible();

  const overflow = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth
  }));
  expect(overflow.scrollWidth).toBe(overflow.clientWidth);
});

test('editing a customer reflects the change immediately, without a manual reload', async ({ context, page }) => {
  test.skip(
    !isFakeSupabaseConfigured(),
    `Set NEXT_PUBLIC_SUPABASE_URL=${fakeSupabaseUrl} and NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY to a dummy value to run the mocked-auth shell smoke test.`
  );

  // Regression test: the SWR-caching work replaced the legacy client's
  // gs() (whose success handler called cacheBust() on every write) with a
  // version that only purged the newer SWR_CACHE, never the older
  // CACHE.cust/CACHE.kase store vCustomer()/vCase() use for their own 90s
  // stale-while-revalidate render. A save on a detail view the user is
  // already looking at rendered stale data until a hard refresh.
  let updateCustomerCalls = 0;
  await setUpAuthenticatedSession(context, page);
  await page.route('**/api/rpc', async (route) => {
    const body = route.request().postDataJSON() as { fn: string; args?: unknown[] };
    if (body.fn === 'api_updateCustomer') {
      updateCustomerCalls += 1;
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, data: { ok: true } }) });
      return;
    }
    if (body.fn === 'api_getCustomer') {
      const payload = customerDetailPayload();
      if (updateCustomerCalls > 0) payload.customer.name = 'Acme Controls Renamed';
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, data: payload }) });
      return;
    }
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, data: rpcData(body.fn) }) });
  });

  await page.goto('/crm/customer/CUST-2026-0001');
  await expect(page.getByRole('heading', { name: 'Acme Controls' })).toBeVisible();

  await page.getByRole('button', { name: 'Edit' }).first().click();
  await page.locator('#f_name').fill('Acme Controls Renamed');
  await page.getByRole('button', { name: 'Save changes' }).click();

  await expect(page.getByRole('heading', { name: 'Acme Controls Renamed' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Acme Controls', exact: true })).not.toBeVisible();
});

test('saving a quotation to Drive shows a working View in Drive link', async ({ context, page }) => {
  test.skip(
    !isFakeSupabaseConfigured(),
    `Set NEXT_PUBLIC_SUPABASE_URL=${fakeSupabaseUrl} and NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY to a dummy value to run the mocked-auth shell smoke test.`
  );

  let driveSaved = false;
  await setUpAuthenticatedSession(context, page);
  await page.route('**/api/rpc', async (route) => {
    const body = route.request().postDataJSON() as { fn: string; args?: unknown[] };
    if (body.fn === 'api_saveQuotationToDrive') {
      driveSaved = true;
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, data: { ok: true } }) });
      return;
    }
    if (body.fn === 'api_getQuotation') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          ok: true,
          data: {
            customer: { id: 'CUST-2026-0001', name: 'Acme Controls' },
            quote: {
              quoteNo: 'QTN-2026-0001',
              rev: 0,
              caseId: 'CASE-2026-0001',
              title: 'Panel upgrade quote',
              source: 'Generated',
              fileName: '',
              templateId: '',
              templateName: 'Standard',
              status: 'Sent',
              subtotal: 101695,
              taxPct: 18,
              taxAmount: 18305,
              total: 120000,
              currency: 'INR',
              validUntil: '2026-08-29',
              notes: '',
              doc: '/api/download/quote/QTN-2026-0001/0?format=html',
              pdf: '/api/download/quote/QTN-2026-0001/0?format=html',
              driveViewLink: driveSaved ? 'https://drive.google.com/file/d/file-123/view' : '',
              by: 'Playwright Admin',
              date: '2026-07-29'
            },
            blocks: [{ title: 'Items', headers: ['Item', 'Amount'], rows: [['Panel upgrade', '120000']] }],
            revisions: [{ rev: 0, status: 'Sent', date: '2026-07-29', total: 120000 }]
          }
        })
      });
      return;
    }
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, data: rpcData(body.fn) }) });
  });

  await page.goto('/crm/cases');
  await page.getByText('Panel upgrade').first().click();
  await page.getByTestId('crm-route').getByRole('button', { name: 'Open' }).click();

  await page.getByRole('button', { name: 'Save to Drive' }).click();
  await expect(page.getByRole('link', { name: 'View in Drive' })).toHaveAttribute(
    'href',
    'https://drive.google.com/file/d/file-123/view'
  );
});

test('generating a quotation surfaces real Drive document links and hides Save to Drive', async ({ context, page }) => {
  test.skip(
    !isFakeSupabaseConfigured(),
    `Set NEXT_PUBLIC_SUPABASE_URL=${fakeSupabaseUrl} and NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY to a dummy value to run the mocked-auth shell smoke test.`
  );

  let generated = false;
  await setUpAuthenticatedSession(context, page);
  await page.route('**/api/rpc', async (route) => {
    const body = route.request().postDataJSON() as { fn: string };
    if (body.fn === 'api_generateQuoteDoc') {
      generated = true;
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          ok: true,
          data: {
            doc: { url: 'https://drive.google.com/file/d/doc-1/view' },
            pdf: { url: 'https://drive.google.com/file/d/pdf-1/view' }
          }
        })
      });
      return;
    }
    if (body.fn === 'api_getQuotation') {
      const base = rpcData('api_getQuotation') as { quote: Record<string, unknown> };
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          ok: true,
          data: {
            ...base,
            quote: {
              ...base.quote,
              status: 'Draft',
              driveViewLink: '',
              doc: generated ? 'https://drive.google.com/file/d/doc-1/view' : '',
              pdf: generated ? 'https://drive.google.com/file/d/pdf-1/view' : ''
            }
          }
        })
      });
      return;
    }
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, data: rpcData(body.fn) }) });
  });

  await page.goto('/crm/cases');
  await page.getByText('Panel upgrade').first().click();
  await page.getByTestId('crm-route').getByRole('button', { name: 'Open' }).click();

  await page.getByRole('button', { name: /Generate download/ }).click();

  await expect(page.getByRole('link', { name: 'Download document' })).toHaveAttribute(
    'href',
    'https://drive.google.com/file/d/doc-1/view'
  );
  await expect(page.getByRole('link', { name: 'Download PDF' })).toHaveAttribute(
    'href',
    'https://drive.google.com/file/d/pdf-1/view'
  );
  await expect(page.getByRole('button', { name: 'Save to Drive' })).toHaveCount(0);
});

test('reassigning a ticket with a handover note shows it on the case page', async ({ context, page }) => {
  test.skip(
    !isFakeSupabaseConfigured(),
    `Set NEXT_PUBLIC_SUPABASE_URL=${fakeSupabaseUrl} and NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY to a dummy value to run the mocked-auth shell smoke test.`
  );

  let getCaseCalls = 0;
  let assignArgs: unknown[] | undefined;
  await setUpAuthenticatedSession(context, page);
  await page.route('**/api/rpc', async (route) => {
    const body = route.request().postDataJSON() as { fn: string; args?: unknown[] };
    if (body.fn === 'api_assignTicket') {
      assignArgs = body.args;
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, data: { ok: true } }) });
      return;
    }
    if (body.fn === 'api_getCase') {
      getCaseCalls += 1;
      const base = rpcData('api_getCase') as Record<string, unknown>;
      const data =
        getCaseCalls > 1
          ? { ...base, latestHandoverNote: 'Quoted, waiting on their PO.' }
          : base;
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, data }) });
      return;
    }
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, data: rpcData(body.fn) }) });
  });

  await page.goto('/crm/cases');
  await page.getByText('Panel upgrade').first().click();
  await expect(page.getByRole('heading', { name: 'Panel upgrade' })).toBeVisible();
  await expect(page.getByText('Latest handover note')).toHaveCount(0);

  await page.getByRole('button', { name: 'reassign' }).click();
  await page.locator('#wk_q').fill('Sales');
  await page.locator('#wk_res').getByText('Sales User').click();
  await page.locator('#wk_note').fill('Quoted, waiting on their PO.');
  await page.locator('#wk_go').click();

  await expect(page.getByText('Latest handover note')).toBeVisible();
  await expect(page.getByText('Quoted, waiting on their PO.')).toBeVisible();

  expect(assignArgs).toEqual(['CASE-2026-0001', 'sales@automationsystems.org', 'Quoted, waiting on their PO.']);
});

test('reassigning a ticket with an attachment uploads it to Drive and shows the link on the case page', async ({
  context,
  page
}) => {
  test.skip(
    !isFakeSupabaseConfigured(),
    `Set NEXT_PUBLIC_SUPABASE_URL=${fakeSupabaseUrl} and NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY to a dummy value to run the mocked-auth shell smoke test.`
  );

  const fakeSessionUrl = 'https://fake-upload.example.com/session/abc123';
  const noteText = 'Quoted, attaching the signed PO for reference.';
  const fileName = 'handover.pdf';
  const fileContents = Buffer.from('fake pdf bytes for e2e upload test');

  let getCaseCalls = 0;
  let assignArgs: unknown[] | undefined;
  let beginUploadArgs: unknown[] | undefined;
  let uploadPutCount = 0;

  await setUpAuthenticatedSession(context, page);

  // Intercept the resumable-upload PUT itself: it must never reach a real
  // Google Drive session URL. Respond the way Drive's resumable upload
  // endpoint does - 200 with the created file's JSON metadata.
  await page.route(fakeSessionUrl, async (route) => {
    uploadPutCount += 1;
    expect(route.request().method()).toBe('PUT');
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ id: 'file-999' })
    });
  });

  await page.route('**/api/rpc', async (route) => {
    const body = route.request().postDataJSON() as { fn: string; args?: unknown[] };

    if (body.fn === 'api_beginAttachmentUpload') {
      beginUploadArgs = body.args;
      const files = (body.args?.[1] ?? []) as Array<{ fileName: string }>;
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          ok: true,
          data: files.map((f) => ({ fileName: f.fileName, sessionUrl: fakeSessionUrl }))
        })
      });
      return;
    }
    if (body.fn === 'api_assignTicket') {
      assignArgs = body.args;
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, data: { ok: true } }) });
      return;
    }
    if (body.fn === 'api_getCase') {
      getCaseCalls += 1;
      const base = rpcData('api_getCase') as Record<string, unknown>;
      const data =
        getCaseCalls > 1
          ? {
              ...base,
              latestHandoverNote: noteText,
              // Mirrors the server: the handover card looks its attachments up
              // by activity id, not by matching on the note's text.
              latestHandoverActivityId: 'LOG-1',
              attachments: {
                'LOG-1': [{ fileName, viewLink: 'https://drive.google.com/file/d/file-999/view' }]
              },
              history: [
                {
                  id: 'LOG-1',
                  when: '2026-07-29',
                  who: 'Playwright Admin',
                  action: 'Reassigned',
                  note: noteText,
                  attachments: [{ fileName, viewLink: 'https://drive.google.com/file/d/file-999/view' }]
                }
              ]
            }
          : base;
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, data }) });
      return;
    }
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, data: rpcData(body.fn) }) });
  });

  await page.goto('/crm/cases');
  await page.getByText('Panel upgrade').first().click();
  await expect(page.getByRole('heading', { name: 'Panel upgrade' })).toBeVisible();
  await expect(page.getByText('Latest handover note')).toHaveCount(0);

  await page.getByRole('button', { name: 'reassign' }).click();
  await page.locator('#wk_q').fill('Sales');
  await page.locator('#wk_res').getByText('Sales User').click();
  await page.locator('#wk_files').setInputFiles({
    name: fileName,
    mimeType: 'application/pdf',
    buffer: fileContents
  });
  await page.locator('#wk_note').fill(noteText);
  await page.locator('#wk_go').click();

  await expect(page.getByText('Latest handover note')).toBeVisible();
  await expect(page.getByText(noteText).first()).toBeVisible();

  const attachmentLink = page.getByRole('link', { name: fileName }).first();
  await expect(attachmentLink).toBeVisible();
  await expect(attachmentLink).toHaveAttribute('href', 'https://drive.google.com/file/d/file-999/view');
  // Both render sites: the history entry and the Latest handover note card.
  await expect(page.getByRole('link', { name: fileName })).toHaveCount(2);

  expect(uploadPutCount).toBe(1);
  expect(beginUploadArgs).toEqual([
    'CASE-2026-0001',
    [{ fileName, mimeType: 'application/pdf', sizeBytes: fileContents.length }]
  ]);
  expect(assignArgs).toEqual([
    'CASE-2026-0001',
    'sales@automationsystems.org',
    noteText,
    [{ fileId: 'file-999', fileName, mimeType: 'application/pdf', sizeBytes: fileContents.length }]
  ]);
});

/* --------------------------------------------------------------------------
 * Manager-feedback points P5-P10 (workstream B, UI half).
 * ------------------------------------------------------------------------ */

test('P5 - the dashboard no longer duplicates the Customers and Cases nav buttons', async ({ context, page }) => {
  test.skip(!isFakeSupabaseConfigured(), 'Needs the fake Supabase env.');
  await setUpAuthenticatedSession(context, page);

  await page.goto('/crm');
  await expect(page.getByRole('heading', { name: 'Overview' })).toBeVisible();

  const main = page.locator('#main');
  await expect(main.getByRole('button', { name: 'Customers', exact: true })).toHaveCount(0);
  await expect(main.getByRole('button', { name: 'Cases', exact: true })).toHaveCount(0);
  await expect(main.getByRole('button', { name: '+ New customer' })).toHaveCount(0);

  // The top nav still routes to both.
  await page.locator('#nav').getByRole('button', { name: 'Customers' }).click();
  await expect(page.getByTestId('crm-route')).toHaveAttribute('data-route', 'customers');
  await page.locator('#nav').getByRole('button', { name: 'Cases' }).click();
  await expect(page.getByTestId('crm-route')).toHaveAttribute('data-route', 'cases');
});

test('P6 - the cases filter renders two normal-sized checkboxes, not one oversized box', async ({ context, page }) => {
  test.skip(!isFakeSupabaseConfigured(), 'Needs the fake Supabase env.');
  await setUpAuthenticatedSession(context, page);

  await page.goto('/crm/cases');
  await expect(page.getByRole('heading', { name: 'Cases' })).toBeVisible();

  const owned = page.locator('#cf_owned');
  const assigned = page.locator('#cf_assigned');
  await expect(owned).toBeVisible();
  await expect(assigned).toBeVisible();
  await expect(page.locator('#cf_mine')).toHaveCount(0);

  // The bug was purely visual: the global `input{width:100%;min-height:40px}`
  // rule plus `.filterbar input{min-width:140px}` turned it into a slab.
  const box = await owned.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.width).toBeLessThan(30);
  expect(box!.height).toBeLessThan(30);

  await owned.check();
  await expect(owned).toBeChecked();
  await assigned.check();
  await expect(assigned).toBeChecked();
  // Independent, not a radio pair.
  await owned.uncheck();
  await expect(assigned).toBeChecked();
});

test('P7 - the customer UI says Location, and the create modal puts it under Name', async ({ context, page }) => {
  test.skip(!isFakeSupabaseConfigured(), 'Needs the fake Supabase env.');
  await setUpAuthenticatedSession(context, page);

  await page.goto('/crm/customers');
  await expect(page.getByRole('heading', { name: 'Customers' })).toBeVisible();
  await expect(page.locator('table.grid th', { hasText: 'Location' }).first()).toBeVisible();
  await expect(page.locator('table.grid th').filter({ hasText: /^Tag$/ })).toHaveCount(0);

  await page.evaluate(() => (window as unknown as { mNewCustomer: (n: string) => void }).mNewCustomer('New Co'));
  const body = page.locator('#mbody');
  await expect(body.locator('label.req', { hasText: 'Location' })).toBeVisible();

  const nameTop = (await body.locator('#f_name').boundingBox())!.y;
  const locationTop = (await body.locator('#f_tags').boundingBox())!.y;
  const areaTop = (await body.locator('#f_area').boundingBox())!.y;
  expect(locationTop).toBeGreaterThan(nameTop);
  expect(areaTop).toBeGreaterThan(locationTop);

  // Mandatory: saving with no location never reaches the server.
  await page.getByRole('button', { name: 'Save customer' }).click();
  await expect(page.locator('#toast')).toContainText(/location/i);
});

test('P8 - SEI is a dropdown multi-select over the admin list, not a text box', async ({ context, page }) => {
  test.skip(!isFakeSupabaseConfigured(), 'Needs the fake Supabase env.');
  await setUpAuthenticatedSession(context, page);

  await page.goto('/crm/customers');
  const sei = page.locator('table.grid select.sei').first();
  await expect(sei).toBeVisible();
  await expect(sei).toHaveAttribute('multiple', '');
  await expect(sei.locator('option')).toHaveCount(2);
  // Deliberately NOT the pill/tagpick control used by locations.
  await expect(page.locator('table.grid .tagpick')).toHaveCount(0);
});

test('P9 - a Direct handler has no Remove button and no email address', async ({ context, page }) => {
  test.skip(!isFakeSupabaseConfigured(), 'Needs the fake Supabase env.');
  await context.addCookies([
    {
      name: storageCookieName,
      value: JSON.stringify(createFakeSession()),
      domain: '127.0.0.1',
      path: '/',
      sameSite: 'Lax',
      httpOnly: false,
      secure: false,
      expires: Math.floor(Date.now() / 1000) + 60 * 60
    }
  ]);
  await page.route('**/api/rpc', async (route) => {
    const body = route.request().postDataJSON() as { fn: string };
    const data =
      body.fn === 'api_getCustomer'
        ? { ...customerDetailPayload(), handlers: [{ email: 'direct', name: 'Direct' }] }
        : rpcData(body.fn);
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, data }) });
  });

  await page.goto('/crm/customer/CUST-2026-0001');
  const handlers = page.locator('.card', { has: page.getByText('Account handlers') });
  await expect(handlers.getByText('Direct', { exact: true })).toBeVisible();
  await expect(handlers.getByRole('button', { name: 'Remove' })).toHaveCount(0);
  await expect(handlers).not.toContainText('direct@');

  // Direct is offered in the dashboard picker, flagged as login-less.
  await page.goto('/crm');
  await expect(page.locator('#dashWho option[value="direct"]')).toHaveText('Direct (no login)');
});

test('P10 - a case creator is not mislabelled as the account handler', async ({ context, page }) => {
  test.skip(!isFakeSupabaseConfigured(), 'Needs the fake Supabase env.');
  await setUpAuthenticatedSession(context, page);

  await page.goto('/crm/case/CASE-2026-0001');
  await expect(page.getByRole('heading', { name: 'Panel upgrade' })).toBeVisible();
  await page.getByRole('button', { name: 'manage' }).click();

  const body = page.locator('#mbody');
  await expect(body).toContainText('created this case');
  await expect(body).not.toContainText('account handler — owner of every case on the account');
});

test('Admin config cards show configured items with edit/delete controls, and Case sources is gone', async ({
  context,
  page
}) => {
  test.skip(!isFakeSupabaseConfigured(), 'Needs the fake Supabase env.');
  await setUpAuthenticatedSession(context, page);

  await page.goto('/crm/admin');
  await expect(page.getByRole('heading', { name: 'Admin' })).toBeVisible();

  const locationsCard = page.locator('.card', { has: page.getByText('Customer locations (geographies)') });
  await expect(locationsCard).toBeVisible();
  const punjabRow = locationsCard.locator('.qr', { hasText: 'Punjab' });
  await expect(punjabRow).toBeVisible();
  await expect(punjabRow.getByRole('button', { name: 'edit' })).toBeVisible();
  await expect(punjabRow.getByRole('button', { name: 'delete' })).toBeVisible();

  await expect(page.getByText('SEI names')).toBeVisible();
  await expect(page.getByText('Case sources')).toHaveCount(0);
});

test('the cases list shows a priority badge only for cases that have one', async ({ context, page }) => {
  test.skip(!isFakeSupabaseConfigured(), 'Needs the fake Supabase env.');
  await context.addCookies([
    {
      name: storageCookieName,
      value: JSON.stringify(createFakeSession()),
      domain: '127.0.0.1',
      path: '/',
      sameSite: 'Lax',
      httpOnly: false,
      secure: false,
      expires: Math.floor(Date.now() / 1000) + 60 * 60
    }
  ]);
  const casesWithMixedPriority = [
    { ...caseSummary, id: 'CASE-2026-0001', title: 'Panel upgrade', priority: 'High' },
    { ...caseSummary, id: 'CASE-2026-0002', title: 'Sensor retrofit', priority: '' }
  ];
  await page.route('**/api/rpc', async (route) => {
    const body = route.request().postDataJSON() as { fn: string };
    // api_workspace warms the cases cache on cold nav; api_listCases refreshes
    // it afterwards. Both must carry the mixed-priority list or the app
    // renders the cached single-case default instead.
    let data = rpcData(body.fn);
    if (body.fn === 'api_listCases') data = casesWithMixedPriority;
    if (body.fn === 'api_workspace') data = { ...(data as object), cases: casesWithMixedPriority };
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, data }) });
  });

  await page.goto('/crm/cases');
  await expect(page.getByTestId('crm-route')).toHaveAttribute('data-route', 'cases');

  const highRow = page.locator('tr', { has: page.getByText('Panel upgrade') });
  await expect(highRow.getByText('High', { exact: true })).toBeVisible();

  const noPriorityRow = page.locator('tr', { has: page.getByText('Sensor retrofit') });
  await expect(noPriorityRow.locator('.badge')).toHaveCount(1); // only the status badge, no priority badge
  await expect(noPriorityRow.getByText('—')).toBeVisible();
});
