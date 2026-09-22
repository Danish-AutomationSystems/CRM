import { NextResponse } from 'next/server';

import { caseRepository } from '../../../server/cases/repository';
import { createCaseService } from '../../../server/cases/service';
import { customerRepository } from '../../../server/customers/repository';
import { createCustomerService } from '../../../server/customers/service';
import { createDashboardService } from '../../../server/dashboard/service';
import type { CrmContext } from '../../../server/auth/context';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const CONTEXTS: CrmContext[] = [
  { email: 'danish@automationsystems.org', name: 'Danish', role: 'L4', allowedTags: ['*'], active: true },
  { email: 'ajayneb@automationsystems.org', name: 'Ajay Neb', role: 'L2', allowedTags: ['Chandigarh', 'Geo', 'Punjab'], active: true },
  { email: 'testing@automationsystems.org', name: 'Testing', role: 'L2', allowedTags: ['*'], active: true },
  { email: 'himanshuneb@automationsystems.org', name: 'Himanshu Neb', role: 'L6', allowedTags: ['*'], active: true }
];

function percentile(sorted: number[], p: number): number {
  if (!sorted.length) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
}

// Read-only: drives the same workspace path a dashboard load uses, at a given
// concurrency, so saturation shows up as latency and failures rather than guesswork.
export async function GET(request: Request): Promise<NextResponse> {
  const url = new URL(request.url);
  const concurrency = Math.min(40, Math.max(1, Number(url.searchParams.get('c') ?? 10)));
  const started = Date.now();

  const customerService = createCustomerService(customerRepository);
  const caseService = createCaseService(caseRepository);
  const dashboard = createDashboardService(caseRepository, { customerService, caseService });

  const mode = url.searchParams.get('mode') ?? 'workspace';
  const run = (context: CrmContext) => {
    switch (mode) {
      case 'raw':
        return caseRepository.listUsers();
      case 'listCases':
        return caseService.listCases(context, {} as never);
      case 'myCustomers':
        return customerService.myCustomers(context);
      case 'bootstrap':
        return dashboard.bootstrap(context);
      default:
        return dashboard.workspace(context, {});
    }
  };

  const results = await Promise.all(
    Array.from({ length: concurrency }, async (_, i) => {
      const context = CONTEXTS[i % CONTEXTS.length];
      const t = Date.now();
      try {
        await Promise.race([
          run(context),
          new Promise<never>((_r, reject) => setTimeout(() => reject(new Error('timeout>25s')), 25000))
        ]);
        return { ok: true, ms: Date.now() - t };
      } catch (error) {
        return { ok: false, ms: Date.now() - t, error: (error as Error).message };
      }
    })
  );

  const oks = results.filter((r) => r.ok).map((r) => r.ms).sort((a, b) => a - b);
  const fails = results.filter((r) => !r.ok);

  return NextResponse.json(
    {
      concurrency,
      mode,
      totalMs: Date.now() - started,
      uptimeS: Math.round(process.uptime()),
      ok: oks.length,
      failed: fails.length,
      failures: fails.slice(0, 5).map((f) => f.error),
      latency: { min: oks[0] ?? 0, p50: percentile(oks, 50), p95: percentile(oks, 95), max: oks[oks.length - 1] ?? 0 }
    },
    { headers: { 'Cache-Control': 'no-store' } }
  );
}
