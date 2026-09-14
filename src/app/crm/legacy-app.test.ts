import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
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
    cases: [] as Array<Record<string, unknown>>
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
      expect(document.getElementById('custQ')?.previousElementSibling?.textContent).toMatch(/location/i);
      expect(document.getElementById('custQ')?.previousElementSibling?.textContent).not.toMatch(/\btag\b/i);
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
      await waitFor(() => expect(document.getElementById('wk_q')).toBeTruthy());
      window.eval('wkPick("other@automationsystems.org", "Other User")');

      const noteField = document.getElementById('wk_note') as HTMLTextAreaElement;
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

    test('escapes HTML in the handover note at both render sites', async () => {
      // Both the history note and the "Latest handover note" block go through
      // esc(). Pin that: a refactor that drops esc() from either site must fail
      // here rather than ship an injection.
      const payload = '<img src=x onerror=alert(1)>';

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
                note: payload
              }
            ],
            latestHandoverNote: payload
          };
        }
        throw new Error(`Unexpected RPC ${fn}`);
      });

      render(createElement(CrmApp));
      await screen.findByRole('heading', { name: 'Overview' });
      window.eval('nav("case", "CASE-1")');
      await screen.findByRole('heading', { name: 'Panel upgrade' });

      const main = document.getElementById('main')!;
      const html = main.innerHTML;

      // The "Latest handover note" block and the history entry are the two
      // render sites; both must have escaped the payload.
      expect(html).toContain('Latest handover note');
      expect(html).not.toContain(payload);
      expect(html).not.toContain('<img');
      expect(main.querySelector('img')).toBeNull();
      // Escaped exactly twice - once per render site.
      expect(html.split('&lt;img src=x onerror=alert(1)&gt;').length - 1).toBe(2);
      expect(window.__AS_CRM_XSS__).not.toBe(true);
    });
  });

  describe('Task 6 - reassignment attachments', () => {
    function setFiles(input: HTMLInputElement, files: File[]) {
      Object.defineProperty(input, 'files', {
        configurable: true,
        value: files
      });
    }

    class FakeXhrUpload {
      onprogress: ((ev: unknown) => void) | null = null;
    }

    class FakeXhr {
      static instances: FakeXhr[] = [];
      method = '';
      url = '';
      status = 0;
      responseText = '';
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      onabort: (() => void) | null = null;
      upload = new FakeXhrUpload();
      aborted = false;
      sentBody: unknown = null;
      constructor() {
        FakeXhr.instances.push(this);
      }
      open(method: string, url: string) {
        this.method = method;
        this.url = url;
      }
      setRequestHeader() {
        // no-op
      }
      send(body: unknown) {
        this.sentBody = body;
      }
      abort() {
        this.aborted = true;
        this.onabort?.();
      }
      respond(status: number, body: unknown) {
        this.status = status;
        this.responseText = JSON.stringify(body);
        this.onload?.();
      }
      fail() {
        this.onerror?.();
      }
      progress(loaded: number, total: number) {
        this.upload.onprogress?.({ lengthComputable: true, loaded, total });
      }
    }

    beforeEach(() => {
      FakeXhr.instances = [];
      vi.stubGlobal('XMLHttpRequest', FakeXhr);
    });

    async function openReassignModalWithPick() {
      render(createElement(CrmApp));
      await screen.findByRole('heading', { name: 'Overview' });
      window.eval('mAssign("CASE-1", [])');
      await waitFor(() => expect(document.getElementById('wk_q')).toBeTruthy());
      window.eval('wkPick("other@automationsystems.org", "Other User")');
      await screen.findByRole('button', { name: 'Reassign' });
    }

    test('selecting files lists their names and sizes', async () => {
      mockRpc((fn) => {
        if (fn === 'api_workspace') return workspace('L6');
        if (fn === 'api_listAssignableUsers') return [{ email: 'other@automationsystems.org', name: 'Other User' }];
        throw new Error(`Unexpected RPC ${fn}`);
      });

      await openReassignModalWithPick();

      const input = document.getElementById('wk_files') as HTMLInputElement;
      expect(input).toBeTruthy();
      const file = new File(['x'.repeat(2048)], 'report.pdf', { type: 'application/pdf' });
      setFiles(input, [file]);
      window.eval('wkFilesPicked()');

      const list = document.getElementById('wk_filelist')!;
      expect(list.textContent).toContain('report.pdf');
      expect(list.textContent).toContain('2.0 KB');
    });

    test('submitting uploads files via XHR then calls api_assignTicket with the uploaded file objects', async () => {
      let beginArgs: unknown[] = [];
      let assignArgs: unknown[] = [];
      mockRpc((fn, args) => {
        if (fn === 'api_workspace') return workspace('L6');
        if (fn === 'api_listAssignableUsers') return [{ email: 'other@automationsystems.org', name: 'Other User' }];
        if (fn === 'api_beginAttachmentUpload') {
          beginArgs = args;
          return [{ fileName: 'report.pdf', sessionUrl: 'https://upload.example/session-1' }];
        }
        if (fn === 'api_assignTicket') {
          assignArgs = args;
          return { ok: true, assignee: 'Other User' };
        }
        throw new Error(`Unexpected RPC ${fn}`);
      });

      await openReassignModalWithPick();

      const input = document.getElementById('wk_files') as HTMLInputElement;
      const file = new File(['hello world'], 'report.pdf', { type: 'application/pdf' });
      setFiles(input, [file]);
      window.eval('wkFilesPicked()');

      const reassignButton = await screen.findByRole('button', { name: 'Reassign' });
      window.eval(reassignButton.getAttribute('onclick') ?? '');

      await waitFor(() => expect(beginArgs.length).toBeGreaterThan(0));
      expect(beginArgs[0]).toBe('CASE-1');
      expect(beginArgs[1]).toEqual([{ fileName: 'report.pdf', mimeType: 'application/pdf', sizeBytes: file.size }]);

      await waitFor(() => expect(FakeXhr.instances.length).toBe(1));
      const xhr = FakeXhr.instances[0];
      expect(xhr.method).toBe('PUT');
      expect(xhr.url).toBe('https://upload.example/session-1');
      expect(xhr.sentBody).toBe(file);

      xhr.respond(200, { id: 'DRIVE-FILE-1' });

      await waitFor(() => expect(assignArgs.length).toBeGreaterThan(0));
      expect(assignArgs[0]).toBe('CASE-1');
      expect(assignArgs[1]).toBe('other@automationsystems.org');
      expect(assignArgs[3]).toEqual([
        { fileId: 'DRIVE-FILE-1', fileName: 'report.pdf', mimeType: 'application/pdf', sizeBytes: file.size }
      ]);
    });

    test('a file over 100 MB is rejected client-side with no RPC call', async () => {
      mockRpc((fn) => {
        if (fn === 'api_workspace') return workspace('L6');
        if (fn === 'api_listAssignableUsers') return [{ email: 'other@automationsystems.org', name: 'Other User' }];
        if (fn === 'api_beginAttachmentUpload' || fn === 'api_assignTicket') {
          throw new Error(`Should not call ${fn} for an oversized file`);
        }
        throw new Error(`Unexpected RPC ${fn}`);
      });

      await openReassignModalWithPick();

      const input = document.getElementById('wk_files') as HTMLInputElement;
      const bigFile = new File(['x'], 'huge.zip', { type: 'application/zip' });
      Object.defineProperty(bigFile, 'size', { value: 101 * 1024 * 1024 });
      setFiles(input, [bigFile]);
      window.eval('wkFilesPicked()');

      const reassignButton = await screen.findByRole('button', { name: 'Reassign' });
      window.eval(reassignButton.getAttribute('onclick') ?? '');

      await waitFor(() => {
        const toast = document.getElementById('toast');
        expect(toast?.className).toContain('err');
      });
      expect(document.getElementById('toast')?.textContent).toMatch(/100 ?MB/i);
      expect(FakeXhr.instances.length).toBe(0);
    });

    test('submit is disabled while uploading, and cancel stops the in-flight upload', async () => {
      mockRpc((fn) => {
        if (fn === 'api_workspace') return workspace('L6');
        if (fn === 'api_listAssignableUsers') return [{ email: 'other@automationsystems.org', name: 'Other User' }];
        if (fn === 'api_beginAttachmentUpload') {
          return [{ fileName: 'report.pdf', sessionUrl: 'https://upload.example/session-1' }];
        }
        if (fn === 'api_assignTicket') {
          throw new Error('api_assignTicket must not be called once the upload is cancelled');
        }
        throw new Error(`Unexpected RPC ${fn}`);
      });

      await openReassignModalWithPick();

      const input = document.getElementById('wk_files') as HTMLInputElement;
      const file = new File(['hello world'], 'report.pdf', { type: 'application/pdf' });
      setFiles(input, [file]);
      window.eval('wkFilesPicked()');

      const reassignButton = (await screen.findByRole('button', { name: 'Reassign' })) as HTMLButtonElement;
      window.eval(reassignButton.getAttribute('onclick') ?? '');

      await waitFor(() => expect(FakeXhr.instances.length).toBe(1));
      expect((document.getElementById('wk_go') as HTMLButtonElement).disabled).toBe(true);

      const cancelButton = document.getElementById('wk_cancel') as HTMLButtonElement;
      expect(cancelButton).toBeTruthy();
      expect(cancelButton.style.display).not.toBe('none');
      window.eval(cancelButton.getAttribute('onclick') ?? '');

      expect(FakeXhr.instances[0].aborted).toBe(true);
      await waitFor(() => expect((document.getElementById('wk_go') as HTMLButtonElement).disabled).toBe(false));
      expect(cancelButton.style.display).toBe('none');
    });

    test('history renders attachment links', async () => {
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
                note: '',
                attachments: [
                  {
                    id: 'ATT-1',
                    fileName: 'quote-annex.pdf',
                    viewLink: 'https://drive.google.com/file/d/abc/view',
                    mimeType: 'application/pdf',
                    sizeBytes: 4096,
                    uploadedBy: 'Admin User',
                    uploadedOn: '2026-08-01'
                  }
                ]
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

      const main = document.getElementById('main')!;
      const link = main.querySelector('a[href="https://drive.google.com/file/d/abc/view"]');
      expect(link).toBeTruthy();
      expect(link?.textContent).toBe('quote-annex.pdf');
    });

    test('a response with no attachments renders exactly as before', async () => {
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

      const main = document.getElementById('main')!;
      expect(main.querySelectorAll('a[target="_blank"]').length).toBe(0);
      expect(main.innerHTML).not.toContain('undefined');
    });

    test('an attachment filename containing HTML is escaped and does not execute', async () => {
      const payload = "Bad'\"><img src=x onerror=window.__AS_CRM_XSS__=true>.pdf";
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
                note: '',
                attachments: [
                  {
                    id: 'ATT-1',
                    fileName: payload,
                    viewLink: 'https://drive.google.com/file/d/abc/view',
                    mimeType: 'application/pdf',
                    sizeBytes: 4096,
                    uploadedBy: 'Admin User',
                    uploadedOn: '2026-08-01'
                  }
                ]
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

      const main = document.getElementById('main')!;
      expect(main.querySelector('img')).toBeNull();
      expect(main.innerHTML).not.toContain(payload);
      expect(window.__AS_CRM_XSS__).not.toBe(true);
    });

    test('the Latest handover note card also renders its attachment links', async () => {
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
                id: 'LOG-1',
                when: '2026-08-01',
                who: 'Admin User',
                action: 'Reassigned',
                details: 'to Other User',
                note: 'Quoted, waiting on their PO.',
                attachments: [
                  {
                    id: 'ATT-1',
                    fileName: 'quote-annex.pdf',
                    viewLink: 'https://drive.google.com/file/d/abc/view',
                    mimeType: 'application/pdf',
                    sizeBytes: 4096,
                    uploadedBy: 'Admin User',
                    uploadedOn: '2026-08-01'
                  }
                ]
              }
            ],
            attachments: {
              'LOG-1': [
                {
                  id: 'ATT-1',
                  fileName: 'quote-annex.pdf',
                  viewLink: 'https://drive.google.com/file/d/abc/view',
                  mimeType: 'application/pdf',
                  sizeBytes: 4096,
                  uploadedBy: 'Admin User',
                  uploadedOn: '2026-08-01'
                }
              ]
            },
            latestHandoverNote: 'Quoted, waiting on their PO.',
            latestHandoverActivityId: 'LOG-1'
          };
        }
        throw new Error(`Unexpected RPC ${fn}`);
      });

      render(createElement(CrmApp));
      await screen.findByRole('heading', { name: 'Overview' });
      window.eval('nav("case", "CASE-1")');
      await screen.findByRole('heading', { name: 'Panel upgrade' });

      const main = document.getElementById('main')!;
      const noteCard = [...main.querySelectorAll('.card')].find((c) => c.textContent?.includes('Latest handover note'));
      expect(noteCard).toBeTruthy();
      const link = noteCard!.querySelector('a[href="https://drive.google.com/file/d/abc/view"]');
      expect(link).toBeTruthy();
      expect(link?.textContent).toBe('quote-annex.pdf');

      // Present at both render sites - the history entry and the summary card.
      expect(main.querySelectorAll('a[href="https://drive.google.com/file/d/abc/view"]').length).toBe(2);
    });

    test('the Latest handover note card still finds its attachments when the handover is outside the 40-entry history window', async () => {
      // The card used to match on note TEXT, walking d.history - which the server
      // caps at 40 entries while latestHandoverNote is uncapped. On a busy case
      // the handover fell off the end of that window and the card silently
      // rendered no links. Matching on the activity id removes the dependency.
      const history = Array.from({ length: 40 }, (_, i) => ({
        id: `LOG-${100 + i}`,
        when: '2026-08-02',
        who: 'Admin User',
        action: 'Edited',
        details: `edit ${i}`,
        note: '',
        attachments: []
      }));

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
            // The handover itself is NOT in history - it aged out of the window.
            history,
            attachments: {
              'LOG-1': [
                {
                  id: 'ATT-1',
                  fileName: 'quote-annex.pdf',
                  viewLink: 'https://drive.google.com/file/d/abc/view',
                  mimeType: 'application/pdf',
                  sizeBytes: 4096,
                  uploadedBy: 'Admin User',
                  uploadedOn: '2026-08-01'
                }
              ]
            },
            latestHandoverNote: 'Quoted, waiting on their PO.',
            latestHandoverActivityId: 'LOG-1'
          };
        }
        throw new Error(`Unexpected RPC ${fn}`);
      });

      render(createElement(CrmApp));
      await screen.findByRole('heading', { name: 'Overview' });
      window.eval('nav("case", "CASE-1")');
      await screen.findByRole('heading', { name: 'Panel upgrade' });

      const main = document.getElementById('main')!;
      const noteCard = [...main.querySelectorAll('.card')].find((c) => c.textContent?.includes('Latest handover note'));
      const link = noteCard!.querySelector('a[href="https://drive.google.com/file/d/abc/view"]');
      expect(link).toBeTruthy();
      expect(link?.textContent).toBe('quote-annex.pdf');
      // Only the card renders it: the handover activity is not in the window.
      expect(main.querySelectorAll('a[href="https://drive.google.com/file/d/abc/view"]').length).toBe(1);
    });

    test('an attachment filename is escaped at both the history and Latest handover note render sites', async () => {
      const payload = '<img src=x onerror=window.__AS_CRM_XSS__=true>.pdf';
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
                id: 'LOG-1',
                when: '2026-08-01',
                who: 'Admin User',
                action: 'Reassigned',
                details: 'to Other User',
                note: 'Quoted, waiting on their PO.',
                attachments: [
                  {
                    id: 'ATT-1',
                    fileName: payload,
                    viewLink: 'https://drive.google.com/file/d/abc/view',
                    mimeType: 'application/pdf',
                    sizeBytes: 4096,
                    uploadedBy: 'Admin User',
                    uploadedOn: '2026-08-01'
                  }
                ]
              }
            ],
            attachments: {
              'LOG-1': [
                {
                  id: 'ATT-1',
                  fileName: payload,
                  viewLink: 'https://drive.google.com/file/d/abc/view',
                  mimeType: 'application/pdf',
                  sizeBytes: 4096,
                  uploadedBy: 'Admin User',
                  uploadedOn: '2026-08-01'
                }
              ]
            },
            latestHandoverNote: 'Quoted, waiting on their PO.',
            latestHandoverActivityId: 'LOG-1'
          };
        }
        throw new Error(`Unexpected RPC ${fn}`);
      });

      render(createElement(CrmApp));
      await screen.findByRole('heading', { name: 'Overview' });
      window.eval('nav("case", "CASE-1")');
      await screen.findByRole('heading', { name: 'Panel upgrade' });

      const main = document.getElementById('main')!;
      const html = main.innerHTML;
      expect(main.querySelector('img')).toBeNull();
      expect(html).not.toContain(payload);
      // Escaped exactly twice - once per render site (history + summary card).
      expect(html.split('&lt;img src=x onerror=window.__AS_CRM_XSS__=true&gt;.pdf').length - 1).toBe(2);
      expect(window.__AS_CRM_XSS__).not.toBe(true);
    });

    test('shows upload progress per file while uploading', async () => {
      mockRpc((fn) => {
        if (fn === 'api_workspace') return workspace('L6');
        if (fn === 'api_listAssignableUsers') return [{ email: 'other@automationsystems.org', name: 'Other User' }];
        if (fn === 'api_beginAttachmentUpload') {
          return [{ fileName: 'report.pdf', sessionUrl: 'https://upload.example/session-1' }];
        }
        if (fn === 'api_assignTicket') return { ok: true, assignee: 'Other User' };
        throw new Error(`Unexpected RPC ${fn}`);
      });

      await openReassignModalWithPick();

      const input = document.getElementById('wk_files') as HTMLInputElement;
      const file = new File(['x'.repeat(1000)], 'report.pdf', { type: 'application/pdf' });
      setFiles(input, [file]);
      window.eval('wkFilesPicked()');

      const reassignButton = await screen.findByRole('button', { name: 'Reassign' });
      window.eval(reassignButton.getAttribute('onclick') ?? '');

      await waitFor(() => expect(FakeXhr.instances.length).toBe(1));
      const xhr = FakeXhr.instances[0];

      expect(document.getElementById('wk_filelist')?.textContent).not.toMatch(/%/);
      xhr.progress(50, 100);
      await waitFor(() => expect(document.getElementById('wk_filelist')?.textContent).toMatch(/50%/));

      xhr.respond(200, { id: 'DRIVE-FILE-1' });
      await waitFor(() => expect(document.getElementById('mwrap')?.className).not.toContain('on'));
    });
  });
});

describe('form fields carry no placeholder text', () => {
  const indexHtml = fs.readFileSync(
    path.join(__dirname, '..', '..', '..', 'docs', 'source-appscript', 'Index.html'),
    'utf8'
  );

  test('has no placeholder attribute anywhere in the legacy client source', () => {
    const found = [...indexHtml.matchAll(/placeholder\s*=/gi)].map((match) => {
      const upto = indexHtml.slice(0, match.index ?? 0);
      return `line ${upto.split('\n').length}`;
    });
    expect(found, `placeholder attributes remain at: ${found.join(', ')}`).toEqual([]);
  });

  test('still tells the user the bulk-import column order', () => {
    // The placeholder that carried this was removed deliberately; the guidance
    // moved to a visible hint. Without it a pasted Excel range maps every column
    // wrong and writes bad data to every row, silently.
    expect(indexHtml).toContain('Name · Location · Type · Priority · Area');
    expect(indexHtml).toContain('Name · Designation · Phone · Email');
  });
});

describe('the old paste-based bulk-add tool is gone', () => {
  const indexHtml = fs.readFileSync(
    path.join(__dirname, '..', '..', '..', 'docs', 'source-appscript', 'Index.html'),
    'utf8'
  );

  test('has no Bulk add button on the Customers page', () => {
    expect(indexHtml).not.toContain('mBulkCustomers()');
  });

  test('has none of the old customer-specific bulk-add functions', () => {
    for (const name of ['function mBulkCustomers(', 'function previewBulkCust(', 'function saveBulkCust(']) {
      expect(indexHtml, `${name} should have been removed`).not.toContain(name);
    }
  });

  test('kept parseBulkRows, which the contacts bulk-add tool still uses', () => {
    // parseBulkRows is a shared paste-row parser. mBulkContacts (bk_paste) calls
    // it too, so deleting it alongside the customer-only bulk-add functions would
    // break the unrelated contacts bulk-add feature.
    expect(indexHtml).toContain('function parseBulkRows(');
    expect(indexHtml).toContain('parseBulkRows(el(\'bk_paste\').value)');
  });
});

describe('admin bulk-add repeatable rows', () => {
  // api_bulkCustomers is wired into the same beforeEach handler (rather than
  // re-stubbing fetch mid-test) because LegacyFullCrmApp captures
  // window.__AS_CRM_FETCH__ as a bound reference to whatever `fetch` was
  // current at mount time - a later `mockRpc()` call inside a test replaces
  // global fetch, but the legacy client keeps calling the old, already-bound
  // function, so the new handler would never be reached.
  let bulkCustomersCalls: unknown[][] = [];
  let bulkCustomersResult: { created: number; skipped: string[] } = { created: 0, skipped: [] };

  beforeEach(async () => {
    bulkCustomersCalls = [];
    bulkCustomersResult = { created: 0, skipped: [] };

    mockRpc((fn, args) => {
      if (fn === 'api_workspace') return workspace('L6');
      if (fn === 'api_admin_listUsers') return [{ ...bootstrap('L6').user, allowedTags: ['*'], active: true }];
      if (fn === 'api_admin_links') return { database: 'Supabase Postgres', supabaseUrl: 'https://example.supabase.co', tables: [] };
      if (fn === 'api_bulkCustomers') {
        bulkCustomersCalls.push(args);
        return bulkCustomersResult;
      }
      throw new Error(`Unexpected RPC ${fn}`);
    });

    render(createElement(CrmApp));

    await screen.findByRole('heading', { name: 'Overview' });
    window.eval('nav("admin")');
    await screen.findByRole('heading', { name: 'Admin' });
    await waitFor(() => expect(document.getElementById('bc_name_0')).toBeTruthy());
  });

  test('starts with exactly one row', () => {
    expect(document.querySelectorAll('[id^="bc_name_"]').length).toBe(1);
  });

  test('adding a row does not lose text already typed into another row', () => {
    (document.getElementById('bc_name_0') as HTMLInputElement).value = 'Alpha Panels';
    (document.getElementById('bc_area_0') as HTMLInputElement).value = 'Ludhiana';
    (window as any).bcAddRow();
    expect((document.getElementById('bc_name_0') as HTMLInputElement).value).toBe('Alpha Panels');
    expect((document.getElementById('bc_area_0') as HTMLInputElement).value).toBe('Ludhiana');
    expect(document.querySelectorAll('[id^="bc_name_"]').length).toBe(2);
  });

  test('removing a row keeps the surviving rows contiguous and their values intact', () => {
    (document.getElementById('bc_name_0') as HTMLInputElement).value = 'Alpha';
    (window as any).bcAddRow();
    (document.getElementById('bc_name_1') as HTMLInputElement).value = 'Beta';
    (window as any).bcAddRow();
    (document.getElementById('bc_name_2') as HTMLInputElement).value = 'Gamma';
    (window as any).bcRemoveRow(1); // remove the middle row (Beta)
    expect(document.querySelectorAll('[id^="bc_name_"]').length).toBe(2);
    expect((document.getElementById('bc_name_0') as HTMLInputElement).value).toBe('Alpha');
    expect((document.getElementById('bc_name_1') as HTMLInputElement).value).toBe('Gamma');
  });

  test('does not show a remove button when there is only one row', () => {
    expect(document.querySelector('#bc_rows [data-bc-remove]')).toBeNull();
  });

  test('shows a remove button on every row once there are two or more', () => {
    (window as any).bcAddRow();
    expect(document.querySelectorAll('#bc_rows [data-bc-remove]').length).toBe(2);
  });

  test('bcSubmit drops blank rows and calls the RPC with only the named ones', async () => {
    bulkCustomersResult = { created: 1, skipped: [] };
    (document.getElementById('bc_name_0') as HTMLInputElement).value = 'Alpha Panels';
    (window as any).bcAddRow();
    // row 1 left blank

    (window as any).bcSubmit();

    await waitFor(() => {
      expect(bulkCustomersCalls).toHaveLength(1);
    });

    const rows = bulkCustomersCalls[0]?.[0] as Array<{ name: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0].name).toBe('Alpha Panels');
  });

  test('bcSubmit shows an error and calls no RPC when every row is blank', async () => {
    (window as any).bcSubmit();

    await waitFor(() => {
      expect(document.getElementById('toast')?.textContent).toContain('every row needs a name');
    });

    expect(bulkCustomersCalls).toHaveLength(0);
  });

  describe('IST timestamp formatting', () => {
    async function bootDashboard() {
      mockRpc((fn) => {
        if (fn === 'api_workspace') return workspace('L6');
        throw new Error(`Unexpected RPC ${fn}`);
      });
      render(createElement(CrmApp));
      await screen.findByRole('heading', { name: 'Overview' });
    }

    test('fmtDateTime renders a UTC ISO timestamp as its IST wall-clock time, including the date shift across midnight', async () => {
      await bootDashboard();

      // 2026-08-23T19:00:00.000Z is IST (UTC+5:30) 2026-08-24 00:30 - the
      // date itself rolls to the next day, which a naive "strip the Z and
      // reformat in UTC" implementation would get wrong.
      const result = window.eval('fmtDateTime("2026-08-23T19:00:00.000Z")') as string;

      expect(result).toContain('24 Aug 2026');
      expect(result).toContain('12:30');
      expect(result.toLowerCase()).toContain('am');
    });

    test('fmtDateTime returns the empty-cell placeholder for null, undefined, and empty input', async () => {
      await bootDashboard();

      expect(window.eval('fmtDateTime(null)')).toBe('—');
      expect(window.eval('fmtDateTime(undefined)')).toBe('—');
      expect(window.eval('fmtDateTime("")')).toBe('—');
    });

    test("the customer detail view's Created line renders through fmtDateTime instead of a raw ISO string", async () => {
      mockRpc((fn) => {
        if (fn === 'api_workspace') return gridWorkspace('L6');
        if (fn === 'api_getCustomer') {
          return customerDetail({
            customer: {
              id: 'CUST-1',
              name: 'Acme Controls',
              tags: ['Punjab'],
              type: 'OEM',
              priority: 'High',
              area: 'Mohali',
              sei: [],
              remarks: '',
              address: '',
              gstin: '',
              website: '',
              notes: '',
              status: '',
              createdOn: '2026-08-23T19:00:00.000Z',
              createdBy: 'admin@automationsystems.org'
            }
          });
        }
        throw new Error(`Unexpected RPC ${fn}`);
      });

      render(createElement(CrmApp));
      await screen.findByRole('heading', { name: 'Overview' });
      window.eval('nav("customer", "CUST-1")');
      await screen.findByRole('heading', { name: 'Acme Controls' });

      const main = document.getElementById('main') as HTMLElement;
      expect(main.textContent).toContain('24 Aug 2026');
      expect(main.textContent).not.toMatch(/2026-08-23T19:00:00/);
    });
  });

  describe('case aging indicator', () => {
    async function bootDashboard() {
      mockRpc((fn) => {
        if (fn === 'api_workspace') return workspace('L6');
        throw new Error(`Unexpected RPC ${fn}`);
      });
      render(createElement(CrmApp));
      await screen.findByRole('heading', { name: 'Overview' });
    }

    afterEach(() => {
      vi.useRealTimers();
    });

    test('daysSinceIST measures a calendar-day difference in IST, not elapsed hours', async () => {
      await bootDashboard();
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-08-24T10:00:00.000Z')); // 2026-08-24, 3:30pm IST

      // 2026-08-23T19:00:00.000Z is IST 2026-08-24 00:30 - same IST calendar day as "now",
      // even though only ~15 real hours have passed. Must read as 0 days, proving this is
      // calendar-date subtraction, not an hours-elapsed countdown.
      expect(window.eval('daysSinceIST("2026-08-23T19:00:00.000Z")')).toBe(0);

      // 2026-08-21T19:00:00.000Z is IST 2026-08-22 00:30 - two IST calendar days before
      // 2026-08-24.
      expect(window.eval('daysSinceIST("2026-08-21T19:00:00.000Z")')).toBe(2);
    });

    test('daysSinceIST returns null for empty or unparseable input', async () => {
      await bootDashboard();

      expect(window.eval('daysSinceIST(null)')).toBeNull();
      expect(window.eval('daysSinceIST(undefined)')).toBeNull();
      expect(window.eval('daysSinceIST("")')).toBeNull();
      expect(window.eval('daysSinceIST("not-a-date")')).toBeNull();
    });

    test('daysSinceIST returns null instead of throwing if Intl.DateTimeFormat fails', async () => {
      await bootDashboard();
      const original = window.Intl.DateTimeFormat;
      (window.Intl as any).DateTimeFormat = function () {
        throw new RangeError('unsupported time zone');
      };
      try {
        expect(window.eval('daysSinceIST("2026-08-20T10:00:00.000Z")')).toBeNull();
      } finally {
        window.Intl.DateTimeFormat = original;
      }
    });

    test('agingChip is empty at 0-1 days, amber at exactly 2, red at 3+', async () => {
      await bootDashboard();
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-08-24T10:00:00.000Z'));

      expect(window.eval('agingChip("2026-08-23T10:00:00.000Z", "")')).toBe(''); // 1 day
      const two = window.eval('agingChip("2026-08-22T10:00:00.000Z", "")') as string;
      expect(two).toContain('b-amber');
      expect(two).toContain('2d');
      const five = window.eval('agingChip("2026-08-19T10:00:00.000Z", "")') as string;
      expect(five).toContain('b-red');
      expect(five).toContain('5d');
    });

    test('agingChip is empty whenever outcome is truthy, no matter how stale', async () => {
      await bootDashboard();
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-08-24T10:00:00.000Z'));

      expect(window.eval('agingChip("2026-08-01T10:00:00.000Z", "Won")')).toBe('');
      expect(window.eval('agingChip("2026-08-01T10:00:00.000Z", "Lost")')).toBe('');
      expect(window.eval('agingChip("2026-08-01T10:00:00.000Z", "Hold")')).toBe('');
    });

    test('agingChip treats a missing outcome as open (dashboard ticket rows never send one)', async () => {
      await bootDashboard();
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-08-24T10:00:00.000Z'));

      const result = window.eval('agingChip("2026-08-19T10:00:00.000Z", undefined)') as string;
      expect(result).toContain('b-red');
    });

    test('agingChip is empty for missing/invalid updatedOn', async () => {
      await bootDashboard();

      expect(window.eval('agingChip(null, "")')).toBe('');
      expect(window.eval('agingChip(undefined, "")')).toBe('');
      expect(window.eval('agingChip("", "")')).toBe('');
    });

    test('the Cases tab shows a stale badge on an Open case and none on a closed one', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      vi.setSystemTime(new Date('2026-08-24T10:00:00.000Z'));

      mockRpc((fn, args) => {
        if (fn === 'api_workspace') return workspace('L6');
        if (fn === 'api_listCases') {
          return [
            {
              id: 'CASE-STALE',
              title: 'Stale open case',
              customerName: 'Acme Controls',
              stage: 'Lead',
              outcome: '',
              orderValue: '',
              owners: [],
              assignee: '',
              updatedOn: '2026-08-19T10:00:00.000Z'
            },
            {
              id: 'CASE-CLOSED',
              title: 'Old but closed',
              customerName: 'Acme Controls',
              stage: 'Lead',
              outcome: 'Won',
              orderValue: 5000,
              owners: [],
              assignee: '',
              updatedOn: '2026-08-19T10:00:00.000Z'
            }
          ];
        }
        throw new Error(`Unexpected RPC ${fn}`);
      });

      render(createElement(CrmApp));
      await screen.findByRole('heading', { name: 'Overview' });

      window.eval('nav("cases")');
      await screen.findByRole('heading', { name: 'Cases' });

      // Clear the outcome filter to show all cases
      window.eval('document.getElementById("cf_outcome").value = ""; applyCaseF();');
      // Wait for the cases to load
      await waitFor(() => {
        const m = document.getElementById('main') as HTMLElement;
        expect(m.innerHTML).not.toContain('No cases match');
      });

      const main = document.getElementById('main') as HTMLElement;
      // 2026-08-19 to 2026-08-24 is exactly 5 IST calendar days - pins the day-count math,
      // not just "some" stale badge.
      expect(main.innerHTML).toContain('5d stale');

      const rows = main.querySelectorAll('tr');
      const staleRow = Array.from(rows).find((row) => row.textContent?.includes('Stale open case'));
      const closedRow = Array.from(rows).find((row) => row.textContent?.includes('Old but closed'));
      expect(staleRow?.innerHTML).toContain('5d stale');
      expect(staleRow?.innerHTML).toContain('b-red');
      expect(closedRow?.innerHTML).not.toContain('b-red');
      expect(closedRow?.innerHTML).not.toContain('stale');
    });

    test('the My work list (L1) shows a stale badge on an assigned ticket', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      vi.setSystemTime(new Date('2026-08-24T10:00:00.000Z'));

      mockRpc((fn) => {
        if (fn === 'api_workspace') {
          const w = workspace('L1');
          (w.boot.self as any).tickets = [
            {
              id: 'CASE-STALE',
              title: 'Stale ticket',
              customerId: 'CUST-1',
              customerName: 'Acme Controls',
              stage: 'Lead',
              priority: 'High',
              updatedOn: '2026-08-22T10:00:00.000Z'
            }
          ];
          return w;
        }
        throw new Error(`Unexpected RPC ${fn}`);
      });

      render(createElement(CrmApp));
      await screen.findByRole('heading', { name: 'My work' });

      const main = document.getElementById('main') as HTMLElement;
      expect(main.innerHTML).toContain('b-amber');
      expect(main.innerHTML).toContain('2d stale');
    });
  });
});

describe('case lifecycle UI', () => {
  const calls: Array<{ fn: string; args: unknown[] }> = [];
  let stage: string;
  let mapped: boolean;
  let role: string;
  let canQuote: boolean;
  let source: string;
  let loseAccess: boolean;
  let outcome: string;
  function detail() {
    const d = caseDetail([{ name: 'Original Owner', email: 'owner@automationsystems.org', source: 'creator' }]);
    return { ...d, customer: mapped ? d.customer : null, canQuote, canMapCustomer: !mapped && canQuote,
      canAssignTicket: stage !== 'Quoted', canRequestRevision: stage === 'Quoted' && !outcome,
      case: { ...d.case, customerId: mapped ? 'CUST-1' : '', stage, outcome, assignee: stage === 'Quoted' ? '' : 'Other User' } };
  }
  function quote() {
    return { customer: { id: 'CUST-1', name: 'Acme Controls' }, quote: {
      quoteNo: 'Q-1', rev: 0, caseId: 'CASE-1', title: 'Panel quotation', source, status: 'Draft',
      subtotal: 100, taxPct: 18, taxAmount: 18, total: 118, currency: 'INR', templateId: 'TPL-1'
    }, blocks: [{ title: '', headers: ['Item'], rows: [['Panel']] }], revisions: [] };
  }
  function rpc(fn: string, args: unknown[]) {
    calls.push({ fn, args });
    if (fn === 'api_workspace') {
      const w = workspace(role);
      w.boot.settings.stages.push('Revision');
      // The server's workspace() prefetches cases via the same listCases() call
      // api_listCases makes for this filter, so the mock must agree with it here too.
      w.cases = [{ ...detail().case, customerName: mapped ? 'Acme Controls' : '' }];
      return w;
    }
    if (fn === 'api_bootstrap') return bootstrap(role);
    if (fn === 'api_getCase') {
      if (loseAccess && stage === 'Quoted') throw new Error('No ticket access');
      return detail();
    }
    if (fn === 'api_listCases') return [{ ...detail().case, customerName: mapped ? 'Acme Controls' : '' }];
    if (fn === 'api_listAssignableUsers') return [{ email: 'other@automationsystems.org', name: 'Other User', active: true }];
    if (fn === 'api_assignTicket') { if (args[4]) stage = 'Revision'; return { ok: true, stage, assignee: 'Other User' }; }
    if (fn === 'api_setCaseStage') { stage = String(args[1]); return { ok: true, stage }; }
    if (fn === 'api_createCase') return { id: 'CASE-1' };
    if (fn === 'api_quickLog') return { caseId: 'CASE-1', customerId: '' };
    if (fn === 'api_searchCustomers') return [
      { id: 'LIMITED-1', name: 'Search Visible', tags: [], access: 'LIMITED' },
      { id: 'CUST-1', name: 'Acme Controls', tags: [], access: 'FULL' }
    ];
    if (fn === 'api_getCustomer') return customerDetail();
    if (fn === 'api_listTemplates') return [{ id: 'TPL-1', name: 'Standard' }];
    if (fn === 'api_getQuotation') return quote();
    if (fn === 'api_createQuotation') { mapped = true; return { quoteNo: 'Q-1', rev: 0 }; }
    if (fn === 'api_uploadQuotation') {
      mapped = true;
      const payload = args[0] as { status?: string };
      if (payload.status === 'Sent') stage = 'Quoted';
      return { quoteNo: 'Q-1', rev: 0 };
    }
    if (fn === 'api_setQuoteStatus') {
      if (args[2] === 'Sent') stage = 'Quoted';
      return { ok: true };
    }
    throw new Error(`Unexpected RPC ${fn}`);
  }
  function press(name: string | RegExp, scope: HTMLElement = document.body) {
    const button = within(scope).getByRole('button', { name });
    window.eval(button.getAttribute('onclick') ?? '');
  }
  function set(id: string, value: string) { (document.getElementById(id) as HTMLInputElement).value = value; }
  async function startCase() {
    mockRpc(rpc);
    render(createElement(CrmApp));
    await screen.findByRole('heading', { name: role === 'L1' ? 'My work' : 'Overview' });
    window.eval('nav("case", "CASE-1")');
    await screen.findByRole('heading', { name: 'Panel upgrade' });
  }
  async function chooseCustomer() {
    const search = await screen.findByRole('textbox', { name: 'Customer search' });
    expect(search).not.toHaveAttribute('placeholder');
    set(search.id, 'Acme');
    window.eval(search.getAttribute('oninput') ?? '');
    await screen.findByRole('button', { name: 'Acme Controls' });
    expect(screen.queryByRole('button', { name: 'Search Visible' })).not.toBeInTheDocument();
    press('Acme Controls');
  }
  beforeEach(() => {
    vi.useRealTimers();
    window.history.pushState(null, '', '/crm');
    calls.length = 0;
    stage = 'Quoted'; mapped = true; role = 'L6'; canQuote = true; source = 'Generated'; loseAccess = false; outcome = '';
  });
  afterEach(() => { cleanup(); document.body.innerHTML = ''; delete window.BOOT; vi.unstubAllGlobals(); });

  test('Quoted hides holder and reassignment; canceling its revision request does not write', async () => {
    await startCase();
    expect(document.getElementById('main')?.textContent).not.toContain('Assigned to:');
    expect(screen.queryByRole('button', { name: 'reassign' })).not.toBeInTheDocument();
    set('stSel', 'Revision'); press('Update stage');
    await screen.findByRole('textbox', { name: 'Search for a user' });
    expect(within(document.getElementById('mfoot')!).getByRole('button', { name: 'Mark revision' })).toBeDisabled();
    press('Cancel');
    expect(calls.filter(c => c.fn === 'api_assignTicket')).toHaveLength(0);
  });

  test('revision confirmation sends the active holder, note, attachments slot and revision flag, then refreshes', async () => {
    await startCase();
    set('stSel', 'Revision'); press('Update stage');
    await screen.findByRole('textbox', { name: 'Search for a user' });
    window.eval(document.querySelector('#wk_res .resrow')?.getAttribute('onclick') ?? '');
    set('wk_note', 'Revise panel dimensions');
    press('Mark revision', document.getElementById('mfoot')!);
    await waitFor(() => expect(calls.find(c => c.fn === 'api_assignTicket')?.args).toEqual([
      'CASE-1', 'other@automationsystems.org', 'Revise panel dimensions', [], true
    ]));
    await waitFor(() => expect(screen.getByRole('button', { name: 'reassign' })).toBeInTheDocument());
    expect(document.getElementById('main')?.textContent).toContain('Original Owner');
  });

  test('choosing Revision through the stage picker requests a holder instead of writing the stage', async () => {
    await startCase();
    set('stSel', 'Revision'); set('stNote', 'Update controls'); press('Update stage');
    await screen.findByRole('textbox', { name: 'Search for a user' });
    expect(document.getElementById('wk_note')).toHaveValue('Update controls');
    expect(calls.filter(c => c.fn === 'api_setCaseStage')).toHaveLength(0);
  });

  test.each(['Generated', 'External'])('New revision of a %s quote confirms a holder before opening its form', async (kind) => {
    source = kind;
    await startCase();
    window.eval('mQuoteViewer("Q-1",0)');
    press(await screen.findByRole('button', { name: 'New revision' }).then(b => b.textContent!));
    await screen.findByRole('textbox', { name: 'Search for a user' });
    expect(document.getElementById('qb_save')).toBeNull();
    expect(document.getElementById('uq_save')).toBeNull();
    window.eval(document.querySelector('#wk_res .resrow')?.getAttribute('onclick') ?? '');
    press('Mark revision', document.getElementById('mfoot')!);
    await waitFor(() => expect(document.getElementById(kind === 'Generated' ? 'qb_save' : 'uq_save')).not.toBeNull());
    expect(calls.find(c => c.fn === 'api_assignTicket')?.args[4]).toBe(true);
    press('Cancel');
    expect(stage).toBe('Revision');
    expect(calls.filter(c => c.fn === 'api_createQuotation' || c.fn === 'api_uploadQuotation')).toHaveLength(0);
  });

  test('Revision permits ordinary reassignment without a revision request', async () => {
    stage = 'Revision'; await startCase(); press('reassign');
    await waitFor(() => expect(document.getElementById('wk_q')).not.toBeNull());
    window.eval(document.querySelector('#wk_res .resrow')?.getAttribute('onclick') ?? '');
    press('Reassign', document.getElementById('mfoot')!);
    await waitFor(() => expect(calls.find(c => c.fn === 'api_assignTicket')?.args.slice(0, 3)).toEqual(['CASE-1', 'other@automationsystems.org', '']));
    expect(calls.find(c => c.fn === 'api_assignTicket')?.args[4]).not.toBe(true);
  });

  test('a user without quote permission cannot open the Quoted entry point via the stage picker', async () => {
    role = 'L1'; canQuote = false; stage = 'Opportunity'; loseAccess = true;
    await startCase();
    const options = Array.from((document.getElementById('stSel') as HTMLSelectElement).options).map(o => o.value);
    expect(options).not.toContain('Quoted');
    press('Update stage');
    expect(screen.queryByRole('button', { name: 'Create a new quotation' })).not.toBeInTheDocument();
    expect(calls.filter(c => c.fn === 'api_setCaseStage')).toHaveLength(0);
    expect(screen.getByRole('heading', { name: 'Panel upgrade' })).toBeInTheDocument();
  });

  test('Cases offers customerless creation and posts the empty customer ID', async () => {
    mapped = false; stage = 'Lead'; mockRpc(rpc); render(createElement(CrmApp));
    await screen.findByRole('heading', { name: 'Overview' });
    window.eval('nav("cases")'); press('+ New case'); press('Create without customer');
    await waitFor(() => expect(document.getElementById('fo_title')).not.toBeNull());
    set('fo_title', 'Panel upgrade'); set('fo_owner', 'other@automationsystems.org'); press('Create');
    await waitFor(() => expect(calls.find(c => c.fn === 'api_createCase')?.args).toEqual(['', expect.objectContaining({ title: 'Panel upgrade', stage: 'Lead' })]));
    await screen.findByRole('heading', { name: 'Panel upgrade' });
    expect(document.getElementById('main')?.textContent).toContain('Customer not mapped');
  });

  test('Quick log explicitly defers customer selection', async () => {
    mapped = false; stage = 'Lead'; mockRpc(rpc); render(createElement(CrmApp));
    await screen.findByRole('heading', { name: 'Overview' }); press(/Quick log/);
    const toggle = screen.getByRole('checkbox', { name: 'Choose customer later' }) as HTMLInputElement;
    toggle.checked = true; window.eval(toggle.getAttribute('onchange') ?? '');
    set('ql_title', 'Panel upgrade'); press('Log case');
    await waitFor(() => expect(calls.find(c => c.fn === 'api_quickLog')?.args).toEqual([expect.objectContaining({ customerLater: true, title: 'Panel upgrade' })]));
    await screen.findByRole('heading', { name: 'Panel upgrade' });
  });

  test.each(['builder', 'upload'])('unmapped %s chooses a FULL customer locally and cancel does not map', async (mode) => {
    mapped = false; stage = 'Lead'; await startCase();
    expect(document.getElementById('main')?.textContent).toContain('Customer not mapped');
    set('stSel', 'Quoted'); press('Update stage');
    await screen.findByRole('button', { name: 'Create a new quotation' });
    press(mode === 'builder' ? 'Create a new quotation' : 'Upload an existing one');
    await chooseCustomer();
    await waitFor(() => expect(document.getElementById(mode === 'builder' ? 'qb_save' : 'uq_save')).not.toBeNull());
    press('Cancel');
    expect(mapped).toBe(false);
    expect(calls.filter(c => !['api_workspace', 'api_getCase', 'api_searchCustomers', 'api_getCustomer', 'api_listTemplates'].includes(c.fn))).toHaveLength(0);
    expect(document.getElementById('main')?.textContent).toContain('Customer not mapped');
  });

  test.each(['builder', 'upload'])('first %s save sends selected customer with the original case, then refreshes mapped details', async (mode) => {
    mapped = false; stage = 'Lead'; await startCase();
    set('stSel', 'Quoted'); press('Update stage');
    await screen.findByRole('button', { name: 'Create a new quotation' });
    press(mode === 'builder' ? 'Create a new quotation' : 'Upload an existing one');
    await chooseCustomer();
    if (mode === 'builder') {
      await screen.findByRole('option', { name: 'Standard' });
      set('qb_title', 'Panel quotation'); set('qb_tpl', 'TPL-1'); set('qb_sub', '100'); set('qb_bx_0', 'Item\nPanel'); press('Save quotation');
    } else {
      await waitFor(() => expect(document.getElementById('uq_file')).not.toBeNull());
      set('uq_title', 'Panel quotation'); set('uq_total', '118');
      Object.defineProperty(document.getElementById('uq_file'), 'files', { value: [new File(['quote'], 'quote.pdf', { type: 'application/pdf' })] });
      press('Upload quotation', document.getElementById('mfoot')!);
    }
    await waitFor(() => expect(calls.find(c => c.fn === (mode === 'builder' ? 'api_createQuotation' : 'api_uploadQuotation'))?.args).toEqual([expect.objectContaining({ customerId: 'CUST-1', caseId: 'CASE-1' })]));
    await waitFor(() => expect(document.getElementById('main')?.textContent).toContain('Acme Controls'));
    expect(document.getElementById('main')?.textContent).not.toContain('Customer not mapped');
    expect(document.getElementById('main')?.textContent).toContain('Original Owner');
  });

  test('readable cases without quotation permission expose no quotation mapping forms', async () => {
    stage = 'Lead'; mapped = false; canQuote = false; role = 'L1'; await startCase();
    expect(screen.queryByRole('button', { name: '+ Quotation' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Upload quotation' })).not.toBeInTheDocument();
  });

  test('unmapped list rows have an explicit customer label', async () => {
    mapped = false; stage = 'Lead'; await startCase(); window.eval('nav("cases")');
    await waitFor(() => expect(document.getElementById('caseRes')?.textContent).toContain('Customer not mapped'));
  });

  test('a closed Quoted case (e.g. Won) hides the quote buttons instead of leaving dead controls', async () => {
    outcome = 'Won';
    await startCase();
    expect(screen.queryByRole('button', { name: '+ Quotation' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Upload quotation' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Mark revision' })).not.toBeInTheDocument();
  });

  test('the stage picker never offers Revision on a case that cannot use it', async () => {
    stage = 'Lead';
    await startCase();
    const options = Array.from((document.getElementById('stSel') as HTMLSelectElement).options).map((o) => o.value);
    expect(options).not.toContain('Revision');
  });

  test('submitting the stage picker unchanged on a Revision case is a no-op, not an error', async () => {
    stage = 'Revision';
    await startCase();
    expect((document.getElementById('stSel') as HTMLSelectElement).value).toBe('Revision');
    press('Update stage');
    expect(calls.filter((c) => c.fn === 'api_setCaseStage')).toHaveLength(0);
    expect(document.getElementById('toast')?.className ?? '').not.toContain('err');
  });

  test('customerless "New case" does not offer Order (Won), which the server always rejects for it', async () => {
    mapped = false; stage = 'Lead'; mockRpc(rpc); render(createElement(CrmApp));
    await screen.findByRole('heading', { name: 'Overview' });
    window.eval('nav("cases")'); press('+ New case'); press('Create without customer');
    await waitFor(() => expect(document.getElementById('fo_title')).not.toBeNull());
    expect(screen.queryByRole('button', { name: 'Order (Won)' })).not.toBeInTheDocument();
  });

  test('Update stage button starts disabled and enables only when the selection differs from the current stage', async () => {
    stage = 'Opportunity';
    await startCase();

    const btn = screen.getByRole('button', { name: 'Update stage' });
    expect(btn).toBeDisabled();

    const select = document.getElementById('stSel') as HTMLSelectElement;
    select.value = 'Lead';
    window.eval(select.getAttribute('onchange') ?? '');
    expect(btn).not.toBeDisabled();

    select.value = 'Opportunity';
    window.eval(select.getAttribute('onchange') ?? '');
    expect(btn).toBeDisabled();
  });

  test('Update priority button follows the same disabled-until-changed rule', async () => {
    stage = 'Opportunity';
    await startCase();

    const btn = screen.getByRole('button', { name: 'Update priority' });
    expect(btn).toBeDisabled();

    const select = document.getElementById('priSel') as HTMLSelectElement;
    select.value = 'High';
    window.eval(select.getAttribute('onchange') ?? '');
    expect(btn).not.toBeDisabled();

    select.value = '';
    window.eval(select.getAttribute('onchange') ?? '');
    expect(btn).toBeDisabled();
  });

  test('the three old case-page buttons are gone at every stage', async () => {
    for (const s of ['Lead', 'Opportunity', 'Quoted', 'Revision']) {
      stage = s;
      await startCase();
      expect(screen.queryByRole('button', { name: 'Mark revision' })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: '+ Quotation' })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Upload quotation' })).not.toBeInTheDocument();
      cleanup();
      document.body.innerHTML = '';
    }
  });

  test('picking Quoted and Update stage opens a Create/Upload choice instead of calling api_setCaseStage', async () => {
    stage = 'Opportunity';
    await startCase();

    const select = document.getElementById('stSel') as HTMLSelectElement;
    select.value = 'Quoted';
    window.eval(select.getAttribute('onchange') ?? '');
    press('Update stage');

    await screen.findByRole('button', { name: 'Create a new quotation' });
    expect(screen.getByRole('button', { name: 'Upload an existing one' })).toBeInTheDocument();
    expect(calls.filter((c) => c.fn === 'api_setCaseStage')).toHaveLength(0);
  });

  test('choosing Create opens the quote builder and saving as Draft does not change the case stage', async () => {
    stage = 'Opportunity';
    await startCase();

    const select = document.getElementById('stSel') as HTMLSelectElement;
    select.value = 'Quoted';
    window.eval(select.getAttribute('onchange') ?? '');
    press('Update stage');
    await screen.findByRole('button', { name: 'Create a new quotation' });
    press('Create a new quotation');

    await screen.findByRole('heading', { name: 'New quotation' });
    set('qb_title', 'Panel quotation');
    set('qb_tpl', 'TPL-1');
    set('qb_sub', '100');
    set('qb_bx_0', 'Item\nPanel');
    press('Save quotation');

    await waitFor(() => expect(calls.some((c) => c.fn === 'api_createQuotation')).toBe(true));
    expect(calls.filter((c) => c.fn === 'api_setCaseStage' && c.args[1] === 'Quoted')).toHaveLength(0);
    expect(stage).toBe('Opportunity');
  });

  test('choosing Upload and picking Sent status commits the case to Quoted', async () => {
    stage = 'Opportunity';
    await startCase();

    const select = document.getElementById('stSel') as HTMLSelectElement;
    select.value = 'Quoted';
    window.eval(select.getAttribute('onchange') ?? '');
    press('Update stage');
    await screen.findByRole('button', { name: 'Upload an existing one' });
    press('Upload an existing one');

    await waitFor(() => expect(document.getElementById('uq_file')).not.toBeNull());
    set('uq_title', 'Panel quotation');
    set('uq_total', '118');
    Object.defineProperty(document.getElementById('uq_file'), 'files', {
      value: [new File(['quote'], 'quote.pdf', { type: 'application/pdf' })]
    });
    press('Upload quotation', document.getElementById('mfoot')!);

    await waitFor(() => expect(calls.some((c) => c.fn === 'api_uploadQuotation')).toBe(true));
    const uploadCall = calls.find((c) => c.fn === 'api_uploadQuotation');
    expect(uploadCall?.args[0]).toMatchObject({ caseId: 'CASE-1', status: 'Sent' });
    expect(stage).toBe('Quoted');
  });

  test('choosing Create, saving as Draft, then marking that quote Sent from the viewer commits the case to Quoted', async () => {
    stage = 'Opportunity';
    await startCase();

    const select = document.getElementById('stSel') as HTMLSelectElement;
    select.value = 'Quoted';
    window.eval(select.getAttribute('onchange') ?? '');
    press('Update stage');
    await screen.findByRole('button', { name: 'Create a new quotation' });
    press('Create a new quotation');
    await screen.findByRole('heading', { name: 'New quotation' });
    set('qb_title', 'Panel quotation');
    set('qb_tpl', 'TPL-1');
    set('qb_sub', '100');
    set('qb_bx_0', 'Item\nPanel');
    press('Save quotation');

    await screen.findByRole('button', { name: 'Mark Sent' });
    expect(stage).toBe('Opportunity');
    press('Mark Sent');

    await waitFor(() => expect(calls.some((c) => c.fn === 'api_setQuoteStatus')).toBe(true));
    expect(stage).toBe('Quoted');
  });

  test('the Quotations card explains where to add a quotation, worded for the case\'s current stage', async () => {
    stage = 'Opportunity';
    await startCase();
    expect(document.getElementById('main')?.textContent).toContain('set the stage to Quoted above');

    cleanup();
    document.body.innerHTML = '';
    stage = 'Quoted';
    await startCase();
    expect(document.getElementById('main')?.textContent).toContain('set the stage to Revision above');
  });

  test('the Stage card does not show a Draft-quote hint when there are no unsent quotations', async () => {
    stage = 'Opportunity';
    await startCase();
    expect(document.getElementById('main')?.textContent).not.toContain('still Draft');
  });

  test('the Quotations card hides its hint on a Won case, since the Stage control it points at is gone', async () => {
    outcome = 'Won';
    await startCase();
    expect(document.getElementById('main')?.textContent).not.toContain('set the stage to Quoted above');
    expect(document.getElementById('main')?.textContent).not.toContain('set the stage to Revision above');
  });

  test('the Stage dropdown omits Quoted for a canEdit user without quote permission, and offers it when they can', async () => {
    role = 'L1'; canQuote = false; stage = 'Opportunity'; loseAccess = true;
    await startCase();
    const optionsWithoutQuote = Array.from((document.getElementById('stSel') as HTMLSelectElement).options).map(o => o.value);
    expect(optionsWithoutQuote).not.toContain('Quoted');

    cleanup();
    document.body.innerHTML = '';
    canQuote = true;
    await startCase();
    const optionsWithQuote = Array.from((document.getElementById('stSel') as HTMLSelectElement).options).map(o => o.value);
    expect(optionsWithQuote).toContain('Quoted');
  });

  test('the Draft-quote hint names the count and does not pick one quote arbitrarily', async () => {
    mockRpc((fn) => {
      if (fn === 'api_workspace') {
        const w = workspace('L6');
        w.boot.settings.stages.push('Revision');
        w.cases = [];
        return w;
      }
      if (fn === 'api_getCase') {
        return {
          ...caseDetail([{ name: 'Original Owner', email: 'owner@automationsystems.org', source: 'creator' }]),
          canQuote: true,
          canRequestRevision: false,
          quotes: [
            { quoteNo: 'Q-1', rev: 0, status: 'Draft', title: 'A', date: '2026-09-14', by: 'sales@automationsystems.org', currency: 'INR', total: 100 },
            { quoteNo: 'Q-2', rev: 0, status: 'Draft', title: 'B', date: '2026-09-14', by: 'sales@automationsystems.org', currency: 'INR', total: 200 },
            { quoteNo: 'Q-3', rev: 0, status: 'Sent', title: 'C', date: '2026-09-14', by: 'sales@automationsystems.org', currency: 'INR', total: 300 }
          ]
        };
      }
      throw new Error(`Unexpected RPC ${fn}`);
    });
    render(createElement(CrmApp));
    await screen.findByRole('heading', { name: 'Overview' });
    window.eval('nav("case", "CASE-1")');
    await screen.findByRole('heading', { name: 'Panel upgrade' });

    expect(document.getElementById('main')?.textContent).toContain('2 quotations are still Draft');
    expect(document.getElementById('main')?.textContent).not.toContain('1 quotation');
  });
});
