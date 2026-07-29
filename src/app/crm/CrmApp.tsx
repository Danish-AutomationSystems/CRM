'use client';

import React, { useEffect, useMemo, useState } from 'react';

import { gs } from '../../client/gs';
import {
  canUseQuickLog,
  formatInr,
  isAuthFailure,
  levelDescriptions,
  quoteDownloadActions,
  roleLevel,
  routeLabels,
  type BootstrapData,
  type CrmRoute
} from './legacy-app';

type AppState =
  | { status: 'loading' }
  | { status: 'ready'; boot: BootstrapData }
  | { status: 'login'; message: string }
  | { status: 'error'; message: string };

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error ?? 'Could not load AS CRM.');
}

function routeButtonClass(active: boolean): string {
  return active ? 'legacy-nav-button is-active' : 'legacy-nav-button';
}

function availableRoutes(boot: BootstrapData): CrmRoute[] {
  const routes: CrmRoute[] = ['dash'];
  if (!boot.isL1) routes.push('customers', 'cases');
  if (boot.nav.admin) routes.push('admin');
  return routes;
}

function StatCard({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="legacy-stat">
      <div className="legacy-stat-value">{value}</div>
      <div className="legacy-stat-label">{label}</div>
    </div>
  );
}

function DashboardView({ boot, onRoute }: { boot: BootstrapData; onRoute: (route: CrmRoute) => void }) {
  if (boot.isL1) {
    const tickets = boot.self?.tickets ?? [];
    return (
      <section className="legacy-panel">
        <div className="legacy-panel-title">Assignments only</div>
        {tickets.length ? (
          <div className="legacy-list">
            {tickets.map((ticket) => (
              <button key={ticket.id} className="legacy-list-row" type="button" onClick={() => onRoute('case')}>
                <strong>{ticket.title}</strong>
                <span>{ticket.customerName}</span>
              </button>
            ))}
          </div>
        ) : (
          <p className="legacy-empty">No open cases assigned to you.</p>
        )}
      </section>
    );
  }

  if (boot.isBackend) {
    return (
      <>
        <div className="legacy-page-head">
          <div>
            <h1>Overview</h1>
            <p>Back-office view with full data access and no personal sales dashboard.</p>
          </div>
          <div className="legacy-actions">
            <button type="button" onClick={() => onRoute('customers')}>
              Customers
            </button>
            <button type="button" onClick={() => onRoute('cases')}>
              Cases
            </button>
            {boot.nav.admin ? (
              <button type="button" onClick={() => onRoute('admin')}>
                Admin
              </button>
            ) : null}
          </div>
        </div>
        <section className="legacy-panel">
          <label htmlFor="dashWho">View a user&apos;s dashboard</label>
          <select id="dashWho" disabled>
            <option>-- select a user --</option>
            {boot.peers.map((peer) => (
              <option key={peer.email}>{peer.name}</option>
            ))}
          </select>
          <p className="legacy-empty">Select a user above to view their dashboard.</p>
        </section>
      </>
    );
  }

  const stats = boot.self?.stats;
  return (
    <>
      <div className="legacy-page-head">
        <div>
          <h1>Dashboard</h1>
          <p>My customers, open cases, recent wins, and opportunity tickets.</p>
        </div>
        <button type="button" onClick={() => onRoute('customers')}>
          + New customer
        </button>
      </div>
      <div className="legacy-stats">
        <StatCard label="My customers" value={stats?.myCustomers ?? 0} />
        <StatCard label="Open cases" value={stats?.openOpps ?? 0} />
        <StatCard label="Value Won this month" value={`INR ${formatInr(stats?.wonMonthValue ?? 0)}`} />
        <StatCard label="Value Won last 2 weeks" value={`INR ${formatInr(stats?.won2wValue ?? 0)}`} />
      </div>
      <section className="legacy-panel">
        <div className="legacy-panel-title">Opportunity tickets - assigned to me</div>
        {(boot.self?.tickets ?? []).length ? (
          <div className="legacy-list">
            {(boot.self?.tickets ?? []).map((ticket) => (
              <button key={ticket.id} className="legacy-list-row" type="button" onClick={() => onRoute('case')}>
                <strong>{ticket.title}</strong>
                <span>
                  {ticket.customerName} / {ticket.stage}
                </span>
              </button>
            ))}
          </div>
        ) : (
          <p className="legacy-empty">No open cases assigned to you.</p>
        )}
      </section>
    </>
  );
}

function CustomersView() {
  return (
    <>
      <div className="legacy-page-head">
        <div>
          <h1>Customers</h1>
          <p>Search customers by name, tag, type, area, handler, or contact.</p>
        </div>
        <div className="legacy-actions">
          <button type="button">Bulk add</button>
          <button type="button">Refresh</button>
        </div>
      </div>
      <section className="legacy-panel">
        <input aria-label="Search customers" placeholder="Search customers by name, tag, type or area..." />
        <div className="legacy-grid-toolbar">
          <button type="button">Fetch all customers</button>
          <button type="button">Clear filters</button>
          <button type="button">Delete selected</button>
        </div>
        <p className="legacy-empty">Start with search or load your customer grid.</p>
      </section>
    </>
  );
}

function CasesView() {
  return (
    <>
      <div className="legacy-page-head">
        <div>
          <h1>Cases</h1>
          <p>Cases on customers you can access, plus any you own.</p>
        </div>
        <button type="button">+ New case</button>
      </div>
      <section className="legacy-panel legacy-filter-grid">
        <input aria-label="Case search" placeholder="Search cases or customers" />
        <select aria-label="Stage">
          <option>All stages</option>
          <option>Lead</option>
          <option>Opportunity</option>
          <option>Quoted</option>
        </select>
        <select aria-label="Outcome">
          <option>Open</option>
          <option>Won</option>
          <option>Lost</option>
          <option>Hold</option>
        </select>
        <label className="legacy-checkbox">
          <input type="checkbox" /> Mine only
        </label>
        <button type="button">Apply</button>
      </section>
    </>
  );
}

function AdminView({ boot }: { boot: BootstrapData }) {
  if (roleLevel(boot.user) < 6) {
    return (
      <section className="legacy-panel">
        <p className="legacy-empty">The Admin area needs L6.</p>
      </section>
    );
  }

  return (
    <>
      <div className="legacy-page-head">
        <div>
          <h1>Admin</h1>
          <p>Users, lists, import, and database links.</p>
        </div>
        <button type="button">+ Add user</button>
      </div>
      <div className="legacy-admin-grid">
        <section className="legacy-panel">
          <div className="legacy-panel-title">Users & access levels</div>
          <p>{levelDescriptions.L6}</p>
          <button type="button">Save user</button>
        </section>
        <section className="legacy-panel">
          <div className="legacy-panel-title">Customer tags (geographies)</div>
          <textarea defaultValue={boot.settings.tags.join('\n')} />
          <button type="button">Save tags</button>
        </section>
        <section className="legacy-panel">
          <div className="legacy-panel-title">Import customers from the sheet</div>
          <button type="button">Run customer import</button>
        </section>
        <section className="legacy-panel">
          <div className="legacy-panel-title">Recycle bin - deleted customers</div>
          <button type="button">Restore</button>
          <button type="button">Delete forever</button>
        </section>
      </div>
    </>
  );
}

function PlaceholderDetail({ route }: { route: CrmRoute }) {
  const isCase = route === 'case';
  const sampleActions = quoteDownloadActions({
    source: 'Generated',
    pdf: '/api/download/quote/QTN-2026-0001/0?format=html'
  });

  return (
    <>
      <div className="legacy-page-head">
        <div>
          <h1>{isCase ? 'Case' : 'Customer'}</h1>
          <p>{isCase ? 'Details, stage, owners, assignee, quotations, and history.' : 'Details, handlers, contacts, cases, and latest quotations.'}</p>
        </div>
        <div className="legacy-actions">
          <button type="button">Edit</button>
          <button type="button">+ Quotation</button>
          <button type="button">Upload quotation</button>
        </div>
      </div>
      <section className="legacy-panel">
        <div className="legacy-panel-title">Quotations</div>
        <div className="legacy-actions">
          {sampleActions.map((action) => (
            <a key={action.label} href={action.href}>
              {action.label}
            </a>
          ))}
        </div>
      </section>
    </>
  );
}

function RouteView({ route, boot, onRoute }: { route: CrmRoute; boot: BootstrapData; onRoute: (route: CrmRoute) => void }) {
  if (route === 'dash') return <DashboardView boot={boot} onRoute={onRoute} />;
  if (route === 'customers') return <CustomersView />;
  if (route === 'cases') return <CasesView />;
  if (route === 'admin') return <AdminView boot={boot} />;
  return <PlaceholderDetail route={route} />;
}

export function CrmApp() {
  const [state, setState] = useState<AppState>({ status: 'loading' });
  const [route, setRoute] = useState<CrmRoute>('dash');

  useEffect(() => {
    let alive = true;
    gs<BootstrapData>('api_bootstrap')
      .then((boot) => {
        if (alive) setState({ status: 'ready', boot });
      })
      .catch((error) => {
        if (!alive) return;
        if (isAuthFailure(error)) {
          setState({ status: 'login', message: errorMessage(error) });
        } else {
          setState({ status: 'error', message: errorMessage(error) });
        }
      });
    return () => {
      alive = false;
    };
  }, []);

  const routes = useMemo(() => (state.status === 'ready' ? availableRoutes(state.boot) : ['dash' as CrmRoute]), [state]);

  if (state.status === 'loading') {
    return (
      <main className="legacy-crm">
        <section className="legacy-lock-card">Loading dashboard...</section>
      </main>
    );
  }

  if (state.status === 'login') {
    return (
      <main className="legacy-crm">
        <section className="legacy-lock-card">
          <h1>Sign in required</h1>
          <p>{state.message}</p>
          <a className="legacy-primary-link" href="/login?next=/crm">
            Go to login
          </a>
        </section>
      </main>
    );
  }

  if (state.status === 'error') {
    return (
      <main className="legacy-crm">
        <section className="legacy-lock-card">
          <h1>Could not load</h1>
          <p>{state.message}</p>
          <button type="button" onClick={() => window.location.reload()}>
            Reload
          </button>
        </section>
      </main>
    );
  }

  const { boot } = state;

  return (
    <div className="legacy-crm">
      <div className="legacy-busy" aria-hidden="true" />
      <header className="legacy-header">
        <div className="legacy-header-inner">
          <div className="legacy-brand" aria-label="AS CRM">
            <div className="legacy-mark" aria-hidden="true">
              <i />
              <i />
              <i />
            </div>
            <div>
              <b>AS CRM</b>
              <small>Automation Systems NG</small>
            </div>
          </div>
          <nav aria-label="CRM sections" className="legacy-nav">
            {routes.map((nextRoute) => (
              <button
                key={nextRoute}
                type="button"
                className={routeButtonClass(route === nextRoute)}
                aria-current={route === nextRoute ? 'page' : undefined}
                onClick={() => setRoute(nextRoute)}
              >
                {routeLabels[nextRoute]}
              </button>
            ))}
          </nav>
          <div className="legacy-user-chip">
            <div>
              <div className="legacy-user-name">{boot.user.name}</div>
              <div className="legacy-user-email">{boot.user.email}</div>
            </div>
            <span>{boot.user.role}</span>
          </div>
        </div>
      </header>
      <main className="legacy-main" data-testid="crm-route" data-route={route}>
        <RouteView route={route} boot={boot} onRoute={setRoute} />
      </main>
      {canUseQuickLog(boot.user) ? (
        <button className="legacy-quick-log" type="button">
          + Quick log
        </button>
      ) : null}
      <div className="legacy-toast" aria-live="polite" />
    </div>
  );
}
