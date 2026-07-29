import http from 'node:http';

import { expect, test } from '@playwright/test';

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

test('mocked authenticated session renders critical CRM route containers', async ({ context, page }) => {
  test.skip(
    !isFakeSupabaseConfigured(),
    `Set NEXT_PUBLIC_SUPABASE_URL=${fakeSupabaseUrl} and NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY to a dummy value to run the mocked-auth shell smoke test.`
  );

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
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        ok: true,
        data: {
          user: {
            email: 'playwright@automationsystems.org',
            name: 'Playwright Admin',
            role: 'L6',
            allowedTags: ['Punjab'],
            active: true
          },
          settings: {
            tags: ['Punjab', 'Chandigarh', 'NCR'],
            stages: ['Lead', 'Opportunity', 'Quoted'],
            outcomes: ['Won', 'Lost', 'Hold'],
            priorities: ['High', 'Medium', 'Low']
          },
          nav: {
            admin: true
          },
          peers: [{ email: 'sales@automationsystems.org', name: 'Sales User', role: 'L2' }],
          self: {
            stats: {
              myCustomers: 4,
              openOpps: 2,
              wonMonthValue: 120000,
              won2wValue: 40000
            },
            tickets: [
              {
                id: 'CASE-2026-0001',
                title: 'Panel upgrade',
                customerName: 'Acme Controls',
                stage: 'Opportunity'
              }
            ]
          },
          isL1: false,
          isBackend: false
        }
      })
    });
  });

  await page.goto('/crm');

  await expect(page.getByLabel('AS CRM')).toBeVisible();
  await expect(page.getByTestId('crm-route')).toHaveAttribute('data-route', 'dash');
  await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();

  await page.getByRole('button', { name: 'Customers' }).click();
  await expect(page.getByTestId('crm-route')).toHaveAttribute('data-route', 'customers');
  await expect(page.getByRole('heading', { name: 'Customers' })).toBeVisible();
  await expect(page.getByLabel('Search customers')).toBeVisible();

  await page.getByRole('button', { name: 'Cases' }).click();
  await expect(page.getByTestId('crm-route')).toHaveAttribute('data-route', 'cases');
  await expect(page.getByRole('heading', { name: 'Cases' })).toBeVisible();
  await expect(page.getByLabel('Case search')).toBeVisible();

  await page.getByRole('button', { name: 'Dashboard' }).click();
  await page.getByRole('button', { name: /Panel upgrade/ }).click();
  await expect(page.getByTestId('crm-route')).toHaveAttribute('data-route', 'case');
  await expect(page.getByRole('heading', { name: 'Case' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Download PDF' })).toHaveAttribute(
    'href',
    '/api/download/quote/QTN-2026-0001/0?format=html'
  );

  await page.getByRole('button', { name: 'Admin' }).click();
  await expect(page.getByTestId('crm-route')).toHaveAttribute('data-route', 'admin');
  await expect(page.getByRole('heading', { name: 'Admin' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Run customer import' })).toBeVisible();
});
