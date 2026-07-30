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
      sources: ['Sales Team'],
      taxPct: 18,
      currency: 'INR',
      company: 'Automation Systems NG Pvt Ltd'
    },
    nav: { admin: true },
    peers: [{ email: 'sales@automationsystems.org', name: 'Sales User', role: 'L2' }],
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
      return { scope: 'all', total: 0, customers: [] };
    case 'api_getCase':
      return {
        customer: { id: 'CUST-2026-0001', name: 'Acme Controls' },
        case: {
          ...caseSummary,
          customerId: 'CUST-2026-0001',
          details: 'Replace panel controls',
          orderValue: '',
          wonCategories: []
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
  await expect(page.getByPlaceholder('Search customers by name, tag, type or area…')).toBeVisible();
  await expect(page.getByText('No customers in the database yet.')).toBeVisible();

  await page.getByRole('button', { name: 'Cases' }).click();
  await expect(page.getByTestId('crm-route')).toHaveAttribute('data-route', 'cases');
  await expect(page.getByRole('heading', { name: 'Cases' })).toBeVisible();
  await expect(page.getByPlaceholder('Search title / ID / customer')).toBeVisible();

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
