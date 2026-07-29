import { render, screen, waitFor } from '@testing-library/react';
import fs from 'node:fs';
import path from 'node:path';
import { createElement } from 'react';
import { describe, expect, test, vi, beforeEach } from 'vitest';

import { gs } from '../../client/gs';
import { CrmApp } from './CrmApp';
import { quoteDownloadActions } from './legacy-app';

vi.mock('../../client/gs', () => ({
  gs: vi.fn()
}));

const mockGs = vi.mocked(gs);

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

describe('legacy CRM app parity shell', () => {
  beforeEach(() => {
    mockGs.mockReset();
  });

  test('renders the route container and bootstraps through the fetch-backed gs helper', async () => {
    mockGs.mockResolvedValueOnce(bootstrap());

    render(createElement(CrmApp));

    expect(await screen.findByTestId('crm-route')).toHaveAttribute('data-route', 'dash');
    expect(screen.getByRole('navigation', { name: 'CRM sections' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Dashboard' })).toHaveAttribute('aria-current', 'page');
    expect(mockGs).toHaveBeenCalledWith('api_bootstrap');
  });

  test('preserves role-based navigation from the legacy header', async () => {
    mockGs.mockResolvedValueOnce(bootstrap('L1'));

    render(createElement(CrmApp));

    await screen.findByText('Assignments only');
    expect(screen.getByRole('button', { name: 'Dashboard' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Customers' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Cases' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Admin' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '+ Quick log' })).not.toBeInTheDocument();
  });

  test('gates authentication failures back to login', async () => {
    mockGs.mockRejectedValueOnce(new Error('Authentication required.'));

    render(createElement(CrmApp));

    const login = await screen.findByRole('link', { name: 'Go to login' });
    expect(login).toHaveAttribute('href', '/login?next=/crm');
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

  test('does not retain Apps Script runtime references or scriptlets', () => {
    const crmDir = path.join(process.cwd(), 'src', 'app', 'crm');
    const source = ['CrmApp.tsx', 'legacy-app.ts', 'page.tsx']
      .map((file) => fs.readFileSync(path.join(crmDir, file), 'utf8'))
      .join('\n');

    expect(source).not.toMatch(/google\.script\.run/);
    expect(source).not.toMatch(/<\?|\?>/);
  });
});
