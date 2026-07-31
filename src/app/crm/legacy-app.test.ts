import { cleanup, render, screen, waitFor } from '@testing-library/react';
import fs from 'node:fs';
import path from 'node:path';
import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { CrmApp } from './CrmApp';
import { quoteDownloadActions } from './legacy-app';
import { legacyAppScript } from './legacy-full.generated';

declare global {
  interface Window {
    BOOT?: { ok: boolean; reason?: string; email?: string };
    __AS_CRM_XSS__?: boolean;
  }
}

function bootstrap(role = 'L6') {
  const level = Number(role.slice(1));
  return {
    user: {
      email: 'admin@automationsystems.org',
      name: 'Admin User',
      role,
      level
    },
    settings: {
      stages: ['Lead', 'Opportunity', 'Quoted'],
      outcomes: ['Won', 'Lost', 'Hold'],
      tags: ['Punjab', 'Chandigarh'],
      types: ['OEM', 'End User'],
      priorities: ['High', 'Medium', 'Low'],
      categories: ['Lighting'],
      sources: ['Sales Team'],
      taxPct: 18,
      currency: 'INR',
      company: 'Automation Systems NG Pvt Ltd'
    },
    nav: { admin: level >= 6 },
    isL1: level <= 1,
    isBackend: level >= 5,
    peers: [],
    self: {
      stats: {
        myCustomers: 4,
        openOpps: 2,
        wonMonthValue: 120000,
        wonMonthCount: 1,
        won2wValue: 50000,
        won2wCount: 1
      },
      cases: [],
      tickets: []
    },
    recent: []
  };
}

function workspace(role = 'L6') {
  return {
    boot: bootstrap(role),
    customers: { scope: 'mine', customers: [] },
    cases: []
  };
}

function mockRpc(handler: (fn: string, args: unknown[]) => unknown) {
  const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? '{}')) as { fn: string; args?: unknown[] };
    const data = handler(body.fn, body.args ?? []);
    return new Response(JSON.stringify({ ok: true, data }), {
      status: 200,
      headers: { 'content-type': 'application/json' }
    });
  });

  vi.stubGlobal('fetch', fetchMock);
  Object.defineProperty(window, 'fetch', { configurable: true, writable: true, value: fetchMock });
  return fetchMock;
}

describe('legacy CRM full client', () => {
  beforeEach(() => {
    vi.useRealTimers();
    window.history.pushState(null, '', '/crm');
  });

  afterEach(() => {
    cleanup();
    document.body.innerHTML = '';
    delete window.BOOT;
    delete window.__AS_CRM_XSS__;
    vi.unstubAllGlobals();
    window.history.pushState(null, '', '/crm');
  });

  test('renders the route container and bootstraps through the fetch-backed legacy gs helper', async () => {
    const fetchMock = mockRpc((fn) => {
      if (fn === 'api_workspace') return workspace();
      throw new Error(`Unexpected RPC ${fn}`);
    });

    render(createElement(CrmApp));

    expect(await screen.findByTestId('crm-route')).toHaveAttribute('data-route', 'dash');
    expect(await screen.findByRole('heading', { name: 'Overview' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Dashboard' })).toHaveClass('on');
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/rpc',
      expect.objectContaining({
        method: 'POST',
        body: expect.stringContaining('"fn":"api_workspace"')
      })
    );
  });

  test('preserves role-based navigation from the legacy header', async () => {
    mockRpc((fn) => {
      if (fn === 'api_workspace') return workspace('L1');
      throw new Error(`Unexpected RPC ${fn}`);
    });

    render(createElement(CrmApp));

    expect(await screen.findByRole('heading', { name: 'My work' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Dashboard' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Customers' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Cases' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Admin' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Quick log/ })).not.toBeInTheDocument();
  });

  test('honors a failed legacy boot lock without calling the RPC layer', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    Object.defineProperty(window, 'fetch', { configurable: true, writable: true, value: fetchMock });
    window.BOOT = {
      ok: false,
      reason: 'NOT_REGISTERED: Ask your manager to add you to CRM users.',
      email: 'new.user@automationsystems.org'
    };

    render(createElement(CrmApp));

    expect(await screen.findByRole('heading', { name: 'You are not registered yet' })).toBeInTheDocument();
    expect(screen.getByText('Ask your manager to add you to CRM users.')).toBeInTheDocument();
    expect(screen.getByText('Signed in as new.user@automationsystems.org')).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('renders the legacy access lock when the RPC layer rejects the session', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: false, error: 'Authentication required.' }), { status: 401 }));
    vi.stubGlobal('fetch', fetchMock);
    Object.defineProperty(window, 'fetch', { configurable: true, writable: true, value: fetchMock });

    render(createElement(CrmApp));

    expect(await screen.findByRole('heading', { name: 'Access pending' })).toBeInTheDocument();
    expect(screen.getByText('Authentication required.')).toBeInTheDocument();
  });

  test('does not execute customer names embedded in recycle-bin actions', async () => {
    mockRpc((fn) => {
      if (fn === 'api_workspace') return workspace('L6');
      if (fn === 'api_admin_listUsers') return [{ ...bootstrap('L6').user, allowedTags: ['*'], active: true }];
      if (fn === 'api_admin_links') return { database: 'Supabase Postgres', supabaseUrl: 'https://example.supabase.co', tables: [] };
      if (fn === 'api_admin_listRecycle') {
        return {
          customers: [
            {
              id: 'CUST-XSS',
              name: "Bad');window.__AS_CRM_XSS__=true;//",
              tags: ['Punjab'],
              area: 'Mohali',
              deletedOn: '2026-07-29',
              deletedBy: 'sales@automationsystems.org'
            }
          ]
        };
      }
      throw new Error(`Unexpected RPC ${fn}`);
    });

    render(createElement(CrmApp));

    await screen.findByRole('heading', { name: 'Overview' });
    window.eval('nav("admin")');
    await screen.findByRole('heading', { name: 'Admin' });
    const deleteButton = await screen.findByRole('button', { name: 'Delete forever' });
    window.eval(deleteButton.getAttribute('onclick') ?? '');

    expect(window.__AS_CRM_XSS__).not.toBe(true);
    expect(screen.getByRole('heading', { name: 'Delete forever' })).toBeInTheDocument();
    expect(document.getElementById('mbody')?.textContent).toBe(
      "Permanently delete Bad');window.__AS_CRM_XSS__=true;// from the recycle bin? This cannot be undone."
    );
  });

  test('saving a quotation to Drive replaces the button with a working link', async () => {
    let saveCalls = 0;
    mockRpc((fn) => {
      if (fn === 'api_workspace') return workspace('L6');
      if (fn === 'api_listCases') return [];
      if (fn === 'api_getQuotation') {
        return {
          quote: {
            quoteNo: 'QTN-2026-0001',
            rev: 0,
            caseId: 'CASE-2026-0001',
            title: 'Panel upgrade quote',
            source: 'Generated',
            fileName: '',
            templateId: '',
            templateName: 'Standard',
            status: 'Draft',
            subtotal: 100,
            taxPct: 18,
            taxAmount: 18,
            total: 118,
            currency: 'INR',
            validUntil: '',
            notes: '',
            doc: '/api/download/quote/QTN-2026-0001/0?format=html',
            pdf: '/api/download/quote/QTN-2026-0001/0?format=html',
            driveViewLink: saveCalls > 0 ? 'https://drive.google.com/file/d/file-123/view' : '',
            by: 'Admin User',
            date: '2026-07-29'
          },
          customer: { id: 'CUST-2026-0001', name: 'Acme Controls' },
          blocks: [],
          revisions: [{ rev: 0, status: 'Draft', date: '2026-07-29', total: 118 }]
        };
      }
      if (fn === 'api_saveQuotationToDrive') {
        saveCalls += 1;
        return { ok: true };
      }
      throw new Error(`Unexpected RPC ${fn}`);
    });

    render(createElement(CrmApp));
    await screen.findByRole('heading', { name: 'Overview' });
    window.eval('mQuoteViewer("QTN-2026-0001", 0)');

    const saveButton = await screen.findByRole('button', { name: 'Save to Drive' });
    window.eval(saveButton.getAttribute('onclick') ?? '');

    expect(await screen.findByRole('link', { name: 'View in Drive' })).toHaveAttribute(
      'href',
      'https://drive.google.com/file/d/file-123/view'
    );
  });

  test('does not leave generated inline handlers with HTML-escaped JavaScript string arguments', () => {
    const unsafeHandlerArguments = [...legacyAppScript.matchAll(/\\''\+esc\([^)]+\)\+'\\'/g)];

    expect(unsafeHandlerArguments).toEqual([]);
  });

  test('uses direct quote download URLs when quote payloads provide them', () => {
    const actions = quoteDownloadActions({
      source: 'Generated',
      doc: '/api/download/quote/QTN-2026-0001/0?format=html',
      pdf: '/api/download/quote/QTN-2026-0001/0?format=html'
    });

    expect(actions).toEqual([
      { label: 'Download document', href: '/api/download/quote/QTN-2026-0001/0?format=html' },
      { label: 'Download PDF', href: '/api/download/quote/QTN-2026-0001/0?format=html' }
    ]);
  });

  test('does not retain Apps Script runtime references, scriptlets, or Drive UI copy', () => {
    const crmDir = path.join(process.cwd(), 'src', 'app', 'crm');
    const source = fs
      .readdirSync(crmDir)
      .filter((file) => /\.(ts|tsx)$/.test(file) && !file.endsWith('.test.ts'))
      .map((file) => fs.readFileSync(path.join(crmDir, file), 'utf8'))
      .join('\n');

    expect(source).not.toMatch(/google\.script\.run/);
    expect(source).not.toMatch(/<\?|\?>/);
    expect(source).not.toMatch(/Drive links|Open Google|Database sheet|Generated quotations folder|Templates folder|Apps Script editor|setupCRM|CRM Quotations folder/);
  });

  test('keeps the legacy font assets available to the ported UI', () => {
    const css = fs.readFileSync(path.join(process.cwd(), 'src', 'app', 'crm', 'legacy-full-ui.css'), 'utf8');

    expect(css).toContain('https://fonts.googleapis.com/css2');
    expect(css).toContain('IBM+Plex+Mono');
    expect(css).toContain('Space+Grotesk');
    expect(css).toContain('Inter');
  });

  test('uses the full legacy client rather than inert placeholder route shells', () => {
    const crmApp = fs.readFileSync(path.join(process.cwd(), 'src', 'app', 'crm', 'CrmApp.tsx'), 'utf8');

    expect(crmApp).not.toMatch(/PlaceholderDetail|Start with search|sampleActions/);
  });

  describe('tab URL sync', () => {
    test('navigating to a tab updates the browser URL to match the route', async () => {
      mockRpc((fn) => {
        if (fn === 'api_workspace') return workspace('L6');
        throw new Error(`Unexpected RPC ${fn}`);
      });

      render(createElement(CrmApp));

      await screen.findByRole('heading', { name: 'Overview' });
      window.eval('nav("cases")');

      await waitFor(() => expect(window.location.pathname).toBe('/crm/cases'));
    });

    test('navigating to a detail view encodes the record id in the URL', async () => {
      mockRpc((fn) => {
        if (fn === 'api_workspace') return workspace('L6');
        throw new Error(`Unexpected RPC ${fn}`);
      });

      render(createElement(CrmApp));

      await screen.findByRole('heading', { name: 'Overview' });
      window.eval('nav("case", "CASE-2026-0001")');

      await waitFor(() => expect(window.location.pathname).toBe('/crm/case/CASE-2026-0001'));
      expect(screen.getByTestId('crm-route')).toHaveAttribute('data-route', 'case');
    });

    test('navigating from one detail record to another re-syncs the URL', async () => {
      mockRpc((fn) => {
        if (fn === 'api_workspace') return workspace('L6');
        throw new Error(`Unexpected RPC ${fn}`);
      });

      render(createElement(CrmApp));

      await screen.findByRole('heading', { name: 'Overview' });
      window.eval('nav("case", "CASE-A")');
      await waitFor(() => expect(window.location.pathname).toBe('/crm/case/CASE-A'));

      window.eval('nav("case", "CASE-B")');
      await waitFor(() => expect(window.location.pathname).toBe('/crm/case/CASE-B'));
    });

    test('mounting with an initial route restores that view after boot instead of staying on dash', async () => {
      mockRpc((fn) => {
        if (fn === 'api_workspace') return workspace('L6');
        throw new Error(`Unexpected RPC ${fn}`);
      });
      window.history.pushState(null, '', '/crm/admin');

      render(createElement(CrmApp, { initialRoute: 'admin', initialArg: null }));

      expect(await screen.findByRole('heading', { name: 'Admin' })).toBeInTheDocument();
      // Boot's vDash always lands on dash first and its render .then is
      // unguarded - give that macrotask a chance to run and clobber us if
      // the restore isn't actually winning.
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(screen.getByTestId('crm-route')).toHaveAttribute('data-route', 'admin');
      expect(screen.queryByRole('heading', { name: 'Overview' })).not.toBeInTheDocument();
      expect(window.location.pathname).toBe('/crm/admin');
    });

    test('browser back/forward (popstate) restores the matching view without adding history entries', async () => {
      mockRpc((fn) => {
        if (fn === 'api_workspace') return workspace('L6');
        throw new Error(`Unexpected RPC ${fn}`);
      });

      render(createElement(CrmApp));

      await screen.findByRole('heading', { name: 'Overview' });
      window.eval('nav("cases")');
      await waitFor(() => expect(window.location.pathname).toBe('/crm/cases'));

      // Simulate the browser having already moved to '/crm' (as it does
      // before ever dispatching popstate) - capture the length AFTER that,
      // so the assertion below proves our popstate handler doesn't add a
      // second entry on top of it.
      window.history.pushState(null, '', '/crm');
      const historyLengthBeforePop = window.history.length;
      window.dispatchEvent(new PopStateEvent('popstate'));

      await screen.findByRole('heading', { name: 'Overview' });
      expect(screen.getByTestId('crm-route')).toHaveAttribute('data-route', 'dash');
      expect(window.history.length).toBe(historyLengthBeforePop);
    });

    test('a synchronous boot lock does not rewrite the deep-linked URL', async () => {
      const fetchMock = vi.fn();
      vi.stubGlobal('fetch', fetchMock);
      Object.defineProperty(window, 'fetch', { configurable: true, writable: true, value: fetchMock });
      window.BOOT = {
        ok: false,
        reason: 'NOT_REGISTERED: Ask your manager to add you to CRM users.',
        email: 'new.user@automationsystems.org'
      };
      window.history.pushState(null, '', '/crm/cases');

      render(createElement(CrmApp, { initialRoute: 'cases', initialArg: null }));

      expect(await screen.findByRole('heading', { name: 'You are not registered yet' })).toBeInTheDocument();
      expect(fetchMock).not.toHaveBeenCalled();
      expect(window.location.pathname).toBe('/crm/cases');
    });

    test('an async boot failure does not rewrite the deep-linked URL', async () => {
      const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: false, error: 'Authentication required.' }), { status: 401 }));
      vi.stubGlobal('fetch', fetchMock);
      Object.defineProperty(window, 'fetch', { configurable: true, writable: true, value: fetchMock });
      window.history.pushState(null, '', '/crm/cases');

      render(createElement(CrmApp, { initialRoute: 'cases', initialArg: null }));

      expect(await screen.findByRole('heading', { name: 'Access pending' })).toBeInTheDocument();
      expect(window.location.pathname).toBe('/crm/cases');
    });

    test('deep-linking into a role-hidden tab falls back to the dashboard', async () => {
      mockRpc((fn) => {
        if (fn === 'api_workspace') return workspace('L1');
        throw new Error(`Unexpected RPC ${fn}`);
      });
      window.history.pushState(null, '', '/crm/cases');
      const historyLengthBeforeRender = window.history.length;

      render(createElement(CrmApp, { initialRoute: 'cases', initialArg: null }));

      expect(await screen.findByRole('heading', { name: 'My work' })).toBeInTheDocument();
      await waitFor(() => expect(window.location.pathname).toBe('/crm'));
      expect(screen.getByTestId('crm-route')).toHaveAttribute('data-route', 'dash');
      // replaceState, not pushState - no new entry for an access fallback.
      expect(window.history.length).toBe(historyLengthBeforeRender);
    });

    test('unmounting before the deferred restore fires does not throw or call the RPC layer again', async () => {
      const fetchMock = mockRpc((fn) => {
        if (fn === 'api_workspace') return workspace('L6');
        throw new Error(`Unexpected RPC ${fn}`);
      });
      window.history.pushState(null, '', '/crm/admin');

      const { unmount } = render(createElement(CrmApp, { initialRoute: 'admin', initialArg: null }));
      // Let the boot mutation's microtask arm the deferred restore, then tear
      // down before its setTimeout(0) macrotask ever runs.
      await Promise.resolve();
      const callCountAtUnmount = fetchMock.mock.calls.length;
      unmount();

      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(fetchMock.mock.calls.length).toBe(callCountAtUnmount);
    });
  });

  describe('client-side cache invalidation after writes', () => {
    test('saving a customer edit reflects instantly instead of showing the 90s-stale cached detail', async () => {
      let getCustomerCalls = 0;
      mockRpc((fn, args) => {
        if (fn === 'api_workspace') return workspace('L6');
        if (fn === 'api_getCustomer') {
          getCustomerCalls += 1;
          return {
            access: 'FULL',
            customer: {
              id: 'CUST-1',
              name: getCustomerCalls === 1 ? 'Old Name' : 'New Name',
              tags: [],
              createdOn: '2026-07-01',
              createdBy: 'admin@automationsystems.org'
            },
            handlers: [],
            contacts: [],
            cases: [],
            quotes: []
          };
        }
        if (fn === 'api_updateCustomer') return { ok: true };
        throw new Error(`Unexpected RPC ${fn} ${JSON.stringify(args)}`);
      });

      render(createElement(CrmApp));

      await screen.findByRole('heading', { name: 'Overview' });
      window.eval('nav("customer", "CUST-1")');
      await screen.findByRole('heading', { name: 'Old Name' });

      // Mirrors the real save-success handler at
      // docs/source-appscript/Index.html:951 -
      // `gs('api_updateCustomer', id, d).then(function(){ ...; vCustomer(id); })`.
      window.eval('gs("api_updateCustomer", "CUST-1", {}).then(function(){ vCustomer("CUST-1"); })');

      await screen.findByRole('heading', { name: 'New Name' });
      expect(screen.queryByRole('heading', { name: 'Old Name' })).not.toBeInTheDocument();
    });
  });
});
