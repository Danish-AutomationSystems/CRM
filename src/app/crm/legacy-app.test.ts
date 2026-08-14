import { cleanup, render, screen, waitFor } from '@testing-library/react';
import fs from 'node:fs';
import path from 'node:path';
import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { CrmApp } from './CrmApp';
import { quoteDownloadActions } from './legacy-app';
import { legacyAppScript, legacyBodyHtml } from './legacy-full.generated';

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

/**
 * Customer-grid metadata as workstream A now serves it: `seiNames` carries the
 * admin-managed SEI list, `tags` already excludes the `TO BE FILLED` backfill
 * placeholder, and every `customers[].sei` is an array rather than a string.
 */
function customerGrid(overrides: Record<string, unknown> = {}) {
  return {
    scope: 'all',
    total: 1,
    canEditPriority: true,
    canEditClass: true,
    canDelete: true,
    tags: ['Punjab', 'Chandigarh'],
    types: ['OEM', 'End User'],
    priorities: ['High', 'Medium', 'Low'],
    seiNames: ['Ravi Kumar', 'Anita Rao'],
    customers: [
      {
        id: 'CUST-1',
        name: 'Acme Controls',
        tags: ['Punjab'],
        type: 'OEM',
        priority: 'High',
        area: 'Mohali',
        sei: ['Ravi Kumar'],
        remarks: '',
        contacts: 1,
        handlers: []
      }
    ],
    ...overrides
  };
}

function gridWorkspace(role = 'L6') {
  return { boot: bootstrap(role), customers: customerGrid(), cases: [] };
}

function customerDetail(overrides: Record<string, unknown> = {}) {
  return {
    access: 'FULL',
    customer: {
      id: 'CUST-1',
      name: 'Acme Controls',
      tags: ['Punjab'],
      type: 'OEM',
      priority: 'High',
      area: 'Mohali',
      sei: ['Ravi Kumar', 'Anita Rao'],
      remarks: '',
      address: '',
      gstin: '',
      website: '',
      notes: '',
      status: '',
      createdOn: '2026-07-01',
      createdBy: 'admin@automationsystems.org'
    },
    handlers: [],
    contacts: [],
    cases: [],
    quotes: [],
    ...overrides
  };
}

function caseDetail(ownerList: Array<Record<string, unknown>>) {
  return {
    customer: { id: 'CUST-1', name: 'Acme Controls' },
    case: {
      id: 'CASE-1',
      title: 'Panel upgrade',
      customerId: 'CUST-1',
      stage: 'Lead',
      outcome: '',
      details: '',
      orderValue: '',
      wonCategories: [],
      owners: ownerList.map((owner) => owner.name),
      ownerList
    },
    canEdit: true,
    canAssignTicket: true,
    quotes: [],
    history: []
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

  test('a Drive-hosted upload shows only a View in Drive link', async () => {
    mockRpc((fn) => {
      if (fn === 'api_workspace') return workspace('L6');
      if (fn === 'api_listCases') return [];
      if (fn === 'api_getQuotation') {
        return {
          quote: {
            quoteNo: 'QTN-2026-0001',
            rev: 0,
            caseId: 'CASE-2026-0001',
            title: 'Vendor offer',
            source: 'External',
            fileName: 'vendor-offer.pdf',
            templateId: '',
            templateName: '',
            status: 'Sent',
            subtotal: '',
            taxPct: '',
            taxAmount: '',
            total: 100,
            currency: 'INR',
            validUntil: '',
            notes: '',
            doc: '',
            pdf: '',
            driveViewLink: 'https://drive.google.com/file/d/drive-file-1/view',
            by: 'Admin User',
            date: '2026-08-13'
          },
          customer: { id: 'CUST-2026-0001', name: 'Acme Controls' },
          blocks: [],
          revisions: [{ rev: 0, status: 'Sent', date: '2026-08-13', total: 100 }]
        };
      }
      throw new Error(`Unexpected RPC ${fn}`);
    });

    render(createElement(CrmApp));
    await screen.findByRole('heading', { name: 'Overview' });
    window.eval('mQuoteViewer("QTN-2026-0001", 0)');

    expect(await screen.findByRole('link', { name: 'View in Drive' })).toHaveAttribute(
      'href',
      'https://drive.google.com/file/d/drive-file-1/view'
    );

    const body = document.getElementById('mbody')?.innerHTML ?? '';
    expect(body).not.toContain('Download uploaded file');
    expect(body).not.toContain('Save to Drive');
  });

  test('hides Save to Drive for generated quotes already hosted in Drive', async () => {
    mockRpc((fn) => {
      if (fn === 'api_workspace') return workspace('L6');
      if (fn === 'api_getQuotation') {
        return {
          quote: {
            quoteNo: 'QTN-2026-0001',
            rev: 0,
            caseId: 'CASE-2026-0001',
            title: 'Panel upgrade quote',
            source: 'Generated',
            fileName: '',
            templateId: 'tpl-1',
            templateName: 'Standard',
            status: 'Draft',
            subtotal: 100,
            taxPct: 18,
            taxAmount: 18,
            total: 118,
            currency: 'INR',
            validUntil: '',
            notes: '',
            doc: 'https://drive.google.com/file/d/doc-1/view',
            pdf: 'https://drive.google.com/file/d/pdf-1/view',
            driveViewLink: '',
            by: 'Admin User',
            date: '2026-07-29'
          },
          customer: { id: 'CUST-2026-0001', name: 'Acme Controls' },
          blocks: [],
          revisions: [{ rev: 0, status: 'Draft', date: '2026-07-29', total: 118 }]
        };
      }
      throw new Error(`Unexpected RPC ${fn}`);
    });

    render(createElement(CrmApp));
    await screen.findByRole('heading', { name: 'Overview' });
    window.eval('mQuoteViewer("QTN-2026-0001", 0)');

    expect(await screen.findByRole('link', { name: 'Download document' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Save to Drive' })).not.toBeInTheDocument();
  });

  test('is syntactically valid JavaScript - the check whose absence let the generated artifact rot', () => {
    // scripts/port-legacy-index.mjs's el(x).innerHTML/textContent -> setHtml/setText
    // rewrite previously stopped scanning at the FIRST ';' in the assigned
    // expression, silently emitting invalid JS whenever that expression
    // contained a ';' inside a string, template literal, or nested callback
    // body. This must never regress unnoticed again.
    expect(() => new Function(legacyAppScript)).not.toThrow();
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
    // legacy-full.generated.ts is excluded from the raw-file scan and checked
    // via the already-imported, already-unescaped legacyAppScript/legacyBodyHtml
    // strings instead - the file on disk stores the script as a single JSON
    // string literal (real newlines escaped to literal "\n" sequences), so
    // stripping full-line "//" developer comments (which legitimately may
    // reference legacy terms while describing *why* the generator rewrites
    // them, without leaving any actual untransformed UI copy behind) is only
    // meaningful against the real, multi-line source text.
    const rawSource = fs
      .readdirSync(crmDir)
      .filter((file) => /\.(ts|tsx)$/.test(file) && !file.endsWith('.test.ts') && file !== 'legacy-full.generated.ts')
      .map((file) => fs.readFileSync(path.join(crmDir, file), 'utf8'))
      .join('\n');

    const scriptWithoutComments = legacyAppScript
      .split('\n')
      .filter((line) => !line.trim().startsWith('//'))
      .join('\n');

    const source = rawSource + '\n' + legacyBodyHtml + '\n' + scriptWithoutComments;

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

  /* ------------------------------------------------------------------
   * Manager-feedback points P5-P10 (workstream B, UI half).
   * ---------------------------------------------------------------- */

  describe('P5 - redundant dashboard buttons are gone', () => {
    test('the L4 dashboard no longer duplicates the top nav with "+ New customer"', async () => {
      mockRpc((fn) => {
        if (fn === 'api_workspace') return workspace('L4');
        throw new Error(`Unexpected RPC ${fn}`);
      });

      render(createElement(CrmApp));

      await screen.findByRole('heading', { name: 'Dashboard' });
      const main = document.getElementById('main') as HTMLElement;
      expect(main.querySelector('#dashWho, .sub')).toBeTruthy();
      expect([...main.querySelectorAll('button')].map((b) => b.textContent)).not.toContain('+ New customer');
    });

    test('the L5/L6 dashboard no longer duplicates the Customers and Cases nav buttons', async () => {
      mockRpc((fn) => {
        if (fn === 'api_workspace') return workspace('L6');
        throw new Error(`Unexpected RPC ${fn}`);
      });

      render(createElement(CrmApp));

      await screen.findByRole('heading', { name: 'Overview' });
      const main = document.getElementById('main') as HTMLElement;
      const labels = [...main.querySelectorAll('button')].map((b) => b.textContent);
      expect(labels).not.toContain('Customers');
      expect(labels).not.toContain('Cases');
      // The Admin shortcut was kept in the first pass because the manager named
      // only three buttons. The project owner then confirmed it should go too,
      // on the same reasoning: it routes to the same tab as the top nav.
      expect(labels).not.toContain('Admin');
      // The real nav must still carry all three.
      expect(document.querySelector('#navCust')).toBeTruthy();
      expect(document.querySelector('#navCases')).toBeTruthy();
      expect(document.querySelector('#navAdmin')).toBeTruthy();
    });
  });

  describe('P6 - cases filter is two independent checkboxes', () => {
    test('renders "Owned by me" and "Assigned to me" instead of a single "Mine only" box', async () => {
      mockRpc((fn) => {
        if (fn === 'api_workspace') return workspace('L6');
        if (fn === 'api_listCases') return [];
        throw new Error(`Unexpected RPC ${fn}`);
      });

      render(createElement(CrmApp));
      await screen.findByRole('heading', { name: 'Overview' });
      window.eval('nav("cases")');
      await screen.findByRole('heading', { name: 'Cases' });

      expect(document.getElementById('cf_owned')).toBeTruthy();
      expect(document.getElementById('cf_assigned')).toBeTruthy();
      expect(document.getElementById('cf_mine')).toBeNull();
      expect(document.getElementById('main')?.textContent).toContain('Owned by me');
      expect(document.getElementById('main')?.textContent).toContain('Assigned to me');
      expect(document.getElementById('main')?.textContent).not.toContain('Mine only');
    });

    test('each checkbox maps to its own server filter flag and both are OR-combined', async () => {
      const listCalls: unknown[][] = [];
      mockRpc((fn, args) => {
        if (fn === 'api_workspace') return workspace('L6');
        if (fn === 'api_listCases') {
          listCalls.push(args);
          return [];
        }
        throw new Error(`Unexpected RPC ${fn}`);
      });

      render(createElement(CrmApp));
      await screen.findByRole('heading', { name: 'Overview' });
      window.eval('nav("cases")');
      await screen.findByRole('heading', { name: 'Cases' });

      window.eval('document.getElementById("cf_owned").checked = true; applyCaseF();');
      await waitFor(() => expect(listCalls.length).toBeGreaterThan(0));
      expect(listCalls.at(-1)?.[0]).toMatchObject({ owned: true, assigned: false });

      window.eval('document.getElementById("cf_assigned").checked = true; applyCaseF();');
      await waitFor(() => expect(listCalls.at(-1)?.[0]).toMatchObject({ owned: true, assigned: true }));

      window.eval(
        'document.getElementById("cf_owned").checked = false; document.getElementById("cf_assigned").checked = false; applyCaseF();'
      );
      await waitFor(() => expect(listCalls.at(-1)?.[0]).toMatchObject({ owned: false, assigned: false }));
    });

    test('checkboxes are exempted from the global full-width input rule that inflated them', () => {
      const css = fs.readFileSync(path.join(process.cwd(), 'src', 'app', 'crm', 'legacy-full-ui.css'), 'utf8');

      expect(css).toMatch(/input\[type=checkbox\]/);
      // The inline style="width:auto" this replaces lost to `.filterbar input`
      // (same specificity, defined later). The real fix must therefore both
      // out-specify AND out-order that rule.
      expect(css.indexOf('.filterbar input[type=checkbox]')).toBeGreaterThan(css.indexOf('.filterbar input,.filterbar select'));
    });
  });

  describe('P7 - location is mandatory, first, and never called "tag"', () => {
    test('the create-customer modal puts Location directly under Name and marks it required', async () => {
      mockRpc((fn) => {
        if (fn === 'api_workspace') return gridWorkspace('L6');
        throw new Error(`Unexpected RPC ${fn}`);
      });

      render(createElement(CrmApp));
      await screen.findByRole('heading', { name: 'Overview' });
      window.eval('mNewCustomer("Acme Controls")');

      const body = document.getElementById('mbody') as HTMLElement;
      const name = body.querySelector('#f_name') as HTMLElement;
      const tags = body.querySelector('#f_tags') as HTMLElement;
      expect(name).toBeTruthy();
      expect(tags).toBeTruthy();
      // Location sits after Name and before every other field.
      expect(name.compareDocumentPosition(tags) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      const area = body.querySelector('#f_area') as HTMLElement;
      expect(tags.compareDocumentPosition(area) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

      const locationLabel = [...body.querySelectorAll('label')].find((l) => l.textContent?.trim() === 'Location');
      expect(locationLabel).toBeTruthy();
      expect(locationLabel?.className).toContain('req');
      expect(body.textContent).not.toMatch(/\bTags?\b/);
    });

    test('saving a new customer with no location is refused client-side, matching the server', async () => {
      const calls: string[] = [];
      mockRpc((fn) => {
        calls.push(fn);
        if (fn === 'api_workspace') return gridWorkspace('L6');
        if (fn === 'api_createCustomer') return { id: 'CUST-2' };
        throw new Error(`Unexpected RPC ${fn}`);
      });

      render(createElement(CrmApp));
      await screen.findByRole('heading', { name: 'Overview' });
      window.eval('mNewCustomer("Acme Controls")');
      window.eval('saveNewCustomer(false)');

      expect(calls).not.toContain('api_createCustomer');
      expect(document.getElementById('toast')?.textContent).toMatch(/location/i);

      window.eval('document.querySelector("#f_tags button").className = "on"; saveNewCustomer(false)');
      await waitFor(() => expect(calls).toContain('api_createCustomer'));
    });

    test('the customer grid, search box and restricted view all say Location, never Tag', async () => {
      mockRpc((fn) => {
        if (fn === 'api_workspace') return gridWorkspace('L6');
        if (fn === 'api_allCustomers') return customerGrid();
        throw new Error(`Unexpected RPC ${fn}`);
      });

      render(createElement(CrmApp));
      await screen.findByRole('heading', { name: 'Overview' });
      window.eval('nav("customers")');
      await screen.findByRole('heading', { name: 'Customers' });
      await waitFor(() => expect(document.querySelector('table.grid')).toBeTruthy());

      const headers = [...document.querySelectorAll('table.grid th')].map((th) => th.textContent);
      expect(headers).toContain('Location');
      expect(headers).not.toContain('Tag');
      expect((document.getElementById('custQ') as HTMLInputElement).placeholder).toMatch(/location/i);
      expect((document.getElementById('custQ') as HTMLInputElement).placeholder).not.toMatch(/\btag\b/i);
    });
  });

  describe('P8 - SEI is an optional dropdown multi-select over the admin list', () => {
    test('the grid cell is a multi-select of seiNames, not a free-text input', async () => {
      mockRpc((fn) => {
        if (fn === 'api_workspace') return gridWorkspace('L6');
        if (fn === 'api_allCustomers') return customerGrid();
        throw new Error(`Unexpected RPC ${fn}`);
      });

      render(createElement(CrmApp));
      await screen.findByRole('heading', { name: 'Overview' });
      window.eval('nav("customers")');
      await waitFor(() => expect(document.querySelector('table.grid')).toBeTruthy());

      const sei = document.querySelector('table.grid select.sei') as HTMLSelectElement;
      expect(sei).toBeTruthy();
      expect(sei.multiple).toBe(true);
      expect([...sei.options].map((o) => o.value)).toEqual(['Ravi Kumar', 'Anita Rao']);
      expect([...sei.selectedOptions].map((o) => o.value)).toEqual(['Ravi Kumar']);
      // Deliberately NOT the pill/tagpick style used by locations.
      expect(sei.closest('td')?.querySelector('.tagpick')).toBeNull();
    });

    test('SEI round-trips as an array, and zero selections is valid', async () => {
      const patches: unknown[] = [];
      mockRpc((fn, args) => {
        if (fn === 'api_workspace') return gridWorkspace('L6');
        if (fn === 'api_allCustomers') return customerGrid();
        if (fn === 'api_saveCustomerCells') {
          patches.push(args[0]);
          return { saved: ['CUST-1'], failed: [] };
        }
        throw new Error(`Unexpected RPC ${fn}`);
      });

      render(createElement(CrmApp));
      await screen.findByRole('heading', { name: 'Overview' });
      window.eval('nav("customers")');
      await waitFor(() => expect(document.querySelector('table.grid select.sei')).toBeTruthy());

      window.eval(
        'var s=document.querySelector("table.grid select.sei"); s.options[0].selected=false; s.options[1].selected=true; cellSaveMulti("CUST-1","sei",s); flushCells();'
      );

      await waitFor(() => expect(patches.length).toBe(1));
      expect(patches[0]).toEqual([{ id: 'CUST-1', fields: { sei: ['Anita Rao'] } }]);

      window.eval(
        'var s2=document.querySelector("table.grid select.sei"); s2.options[1].selected=false; cellSaveMulti("CUST-1","sei",s2); flushCells();'
      );
      await waitFor(() => expect(patches.length).toBe(2));
      expect(patches[1]).toEqual([{ id: 'CUST-1', fields: { sei: [] } }]);
    });

    test('the customer detail view lists every SEI name instead of printing an array', async () => {
      mockRpc((fn) => {
        if (fn === 'api_workspace') return gridWorkspace('L6');
        if (fn === 'api_getCustomer') return customerDetail();
        throw new Error(`Unexpected RPC ${fn}`);
      });

      render(createElement(CrmApp));
      await screen.findByRole('heading', { name: 'Overview' });
      window.eval('nav("customer", "CUST-1")');
      await screen.findByRole('heading', { name: 'Acme Controls' });

      expect(document.getElementById('main')?.textContent).toContain('Ravi Kumar, Anita Rao');
    });
  });

  describe('P9 - Direct is a special, non-removable handler', () => {
    test('a Direct handler renders with no Remove button and no email address', async () => {
      mockRpc((fn) => {
        if (fn === 'api_workspace') return gridWorkspace('L6');
        if (fn === 'api_getCustomer') {
          return customerDetail({ handlers: [{ email: 'direct', name: 'Direct' }] });
        }
        throw new Error(`Unexpected RPC ${fn}`);
      });

      render(createElement(CrmApp));
      await screen.findByRole('heading', { name: 'Overview' });
      window.eval('nav("customer", "CUST-1")');
      await screen.findByRole('heading', { name: 'Acme Controls' });

      const main = document.getElementById('main') as HTMLElement;
      expect(main.textContent).toContain('Direct');
      expect(main.textContent).not.toContain('direct@');
      expect([...main.querySelectorAll('button')].map((b) => b.textContent)).not.toContain('Remove');
    });

    test('a real handler keeps its Remove button', async () => {
      mockRpc((fn) => {
        if (fn === 'api_workspace') return gridWorkspace('L6');
        if (fn === 'api_getCustomer') {
          return customerDetail({ handlers: [{ email: 'sales@automationsystems.org', name: 'Sales User' }] });
        }
        throw new Error(`Unexpected RPC ${fn}`);
      });

      render(createElement(CrmApp));
      await screen.findByRole('heading', { name: 'Overview' });
      window.eval('nav("customer", "CUST-1")');
      await screen.findByRole('heading', { name: 'Acme Controls' });

      const main = document.getElementById('main') as HTMLElement;
      expect(main.textContent).toContain('sales@automationsystems.org');
      expect([...main.querySelectorAll('button')].map((b) => b.textContent)).toContain('Remove');
    });

    test('Direct appears in the dashboard picker as a login-less account', async () => {
      const boot = bootstrap('L6');
      boot.peers = [
        { email: 'sales@automationsystems.org', name: 'Sales User', role: 'L2', hasLogin: true },
        { email: 'direct', name: 'Direct', role: 'L2', hasLogin: false }
      ] as never;
      mockRpc((fn) => {
        if (fn === 'api_workspace') return { boot, customers: customerGrid(), cases: [] };
        throw new Error(`Unexpected RPC ${fn}`);
      });

      render(createElement(CrmApp));
      await screen.findByRole('heading', { name: 'Overview' });

      const picker = document.getElementById('dashWho') as HTMLSelectElement;
      expect(picker).toBeTruthy();
      const direct = [...picker.options].find((o) => o.value === 'direct');
      expect(direct).toBeTruthy();
      expect(direct?.textContent).toBe('Direct (no login)');
    });
  });

  describe('P10 - case owners are labelled by why they own the case', () => {
    test('a creator-sourced owner is not described as the account handler', async () => {
      mockRpc((fn) => {
        if (fn === 'api_workspace') return gridWorkspace('L6');
        if (fn === 'api_listAssignableUsers') return [{ email: 'admin@automationsystems.org', name: 'Admin User' }];
        if (fn === 'api_getCase') {
          return caseDetail([
            { email: 'admin@automationsystems.org', name: 'Admin User', source: 'creator', removable: false }
          ]);
        }
        throw new Error(`Unexpected RPC ${fn}`);
      });

      render(createElement(CrmApp));
      await screen.findByRole('heading', { name: 'Overview' });
      window.eval('nav("case", "CASE-1")');
      await screen.findByRole('heading', { name: 'Panel upgrade' });
      window.eval('mOwners()');

      await waitFor(() => expect(document.getElementById('mbody')?.textContent).toContain('Admin User'));
      const body = document.getElementById('mbody')?.textContent ?? '';
      expect(body).toMatch(/created this case/i);
      expect(body).not.toMatch(/account handler — owner of every case/);
    });

    test('handler, creator and manual owners each get their own wording', async () => {
      mockRpc((fn) => {
        if (fn === 'api_workspace') return gridWorkspace('L6');
        if (fn === 'api_listAssignableUsers') return [{ email: 'admin@automationsystems.org', name: 'Admin User' }];
        if (fn === 'api_getCase') {
          return caseDetail([
            { email: 'handler@automationsystems.org', name: 'Handler User', source: 'handler', removable: false },
            { email: 'creator@automationsystems.org', name: 'Creator User', source: 'creator', removable: true },
            { email: 'added@automationsystems.org', name: 'Added User', source: 'manual', removable: true }
          ]);
        }
        throw new Error(`Unexpected RPC ${fn}`);
      });

      render(createElement(CrmApp));
      await screen.findByRole('heading', { name: 'Overview' });
      window.eval('nav("case", "CASE-1")');
      await screen.findByRole('heading', { name: 'Panel upgrade' });
      window.eval('mOwners()');

      await waitFor(() => expect(document.getElementById('mbody')?.textContent).toContain('Handler User'));
      const rows = [...(document.getElementById('mbody')?.querySelectorAll('.qr') ?? [])].map((r) => r.textContent ?? '');
      expect(rows[0]).toMatch(/account handler — owner of every case on the account/);
      expect(rows[1]).toMatch(/created this case/i);
      expect(rows[2]).toMatch(/added to this case/i);
      // Only the non-removable handler loses its remove control.
      expect(rows[0]).not.toMatch(/remove/i);
      expect(rows[1]).toMatch(/remove/i);
      expect(rows[2]).toMatch(/remove/i);
    });
  });

  describe('Task 4 - handover notes', () => {
    test('the reassign modal sends the handover note', async () => {
      let sentArgs: unknown[] = [];
      mockRpc((fn, args) => {
        if (fn === 'api_workspace') return workspace('L6');
        if (fn === 'api_listAssignableUsers') return [{ email: 'other@automationsystems.org', name: 'Other User' }];
        if (fn === 'api_assignTicket') {
          sentArgs = args;
          return { ok: true, assignee: 'Other User' };
        }
        throw new Error(`Unexpected RPC ${fn}`);
      });

      render(createElement(CrmApp));
      await screen.findByRole('heading', { name: 'Overview' });

      window.eval('mAssign("CASE-1", [])');
      await screen.findByPlaceholderText('type a name or username…');
      window.eval('wkPick("other@automationsystems.org", "Other User")');

      const noteField = await screen.findByPlaceholderText(
        'What has been done so far, and what the next person needs to know.'
      );
      window.eval(
        `document.getElementById('wk_note').value = ${JSON.stringify('Quoted, waiting on their PO.')};`
      );
      expect(noteField).toHaveValue('Quoted, waiting on their PO.');

      const reassignButton = await screen.findByRole('button', { name: 'Reassign' });
      window.eval(reassignButton.getAttribute('onclick') ?? '');

      await waitFor(() => expect(sentArgs[2]).toBe('Quoted, waiting on their PO.'));
    });

    test('the case page shows the latest handover note', async () => {
      mockRpc((fn) => {
        if (fn === 'api_workspace') return gridWorkspace('L6');
        if (fn === 'api_getCase') {
          return {
            customer: { id: 'CUST-1', name: 'Acme Controls' },
            case: {
              id: 'CASE-1',
              title: 'Panel upgrade',
              customerId: 'CUST-1',
              stage: 'Lead',
              outcome: '',
              details: '',
              orderValue: '',
              wonCategories: [],
              owners: ['Admin User'],
              ownerList: [{ email: 'admin@automationsystems.org', name: 'Admin User', source: 'creator', removable: false }]
            },
            canEdit: true,
            canAssignTicket: true,
            quotes: [],
            history: [
              {
                when: '2026-08-01',
                who: 'Admin User',
                action: 'Reassigned',
                details: 'to Other User',
                note: 'Quoted, waiting on their PO.'
              }
            ],
            latestHandoverNote: 'Quoted, waiting on their PO.'
          };
        }
        throw new Error(`Unexpected RPC ${fn}`);
      });

      render(createElement(CrmApp));
      await screen.findByRole('heading', { name: 'Overview' });
      window.eval('nav("case", "CASE-1")');
      await screen.findByRole('heading', { name: 'Panel upgrade' });

      expect(document.getElementById('main')!.innerHTML).toContain('Quoted, waiting on their PO.');
    });

    test('a case with no handover note renders no note block', async () => {
      mockRpc((fn) => {
        if (fn === 'api_workspace') return gridWorkspace('L6');
        if (fn === 'api_getCase') {
          return {
            customer: { id: 'CUST-1', name: 'Acme Controls' },
            case: {
              id: 'CASE-1',
              title: 'Panel upgrade',
              customerId: 'CUST-1',
              stage: 'Lead',
              outcome: '',
              details: '',
              orderValue: '',
              wonCategories: [],
              owners: ['Admin User'],
              ownerList: [{ email: 'admin@automationsystems.org', name: 'Admin User', source: 'creator', removable: false }]
            },
            canEdit: true,
            canAssignTicket: true,
            quotes: [],
            history: [
              {
                when: '2026-08-01',
                who: 'Admin User',
                action: 'Created',
                details: 'Case created',
                note: ''
              }
            ],
            latestHandoverNote: ''
          };
        }
        throw new Error(`Unexpected RPC ${fn}`);
      });

      render(createElement(CrmApp));
      await screen.findByRole('heading', { name: 'Overview' });
      window.eval('nav("case", "CASE-1")');
      await screen.findByRole('heading', { name: 'Panel upgrade' });

      expect(document.getElementById('main')!.innerHTML).not.toContain('Handover note');
    });
  });
});
