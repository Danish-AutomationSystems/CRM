import { NextResponse } from 'next/server';

import { caseRepository } from '../../../server/cases/repository';
import { createCaseService } from '../../../server/cases/service';
import { customerRepository } from '../../../server/customers/repository';
import { createCustomerService } from '../../../server/customers/service';
import { createDashboardService } from '../../../server/dashboard/service';
import type { CrmContext } from '../../../server/auth/context';
import { sql } from '../../../server/db/client';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

async function timed<T>(label: string, ms: number, run: () => Promise<T>) {
  const t = Date.now();
  try {
    await Promise.race([
      run(),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`STALLED >${ms}ms`)), ms))
    ]);
    return { label, ok: true, ms: Date.now() - t };
  } catch (error) {
    return { label, ok: false, ms: Date.now() - t, error: (error as Error).message };
  }
}

// Mirrors what api_workspace actually does - repeated calls plus a parallel
// burst - so a stall that only shows under real query volume is reproducible.
export async function GET(): Promise<NextResponse> {
  const started = Date.now();
  const steps: unknown[] = [];

  const context: CrmContext = {
    email: 'danish@automationsystems.org',
    name: 'Danish',
    role: 'L4',
    allowedTags: ['*'],
    active: true
  };

  const customerService = createCustomerService(customerRepository);
  const caseService = createCaseService(caseRepository);
  const dashboard = createDashboardService(caseRepository, { customerService, caseService });

  steps.push(await timed('workspace-1', 20000, () => dashboard.workspace(context, {})));
  steps.push(await timed('workspace-2', 20000, () => dashboard.workspace(context, {})));
  steps.push(
    await timed('parallel-burst-20', 20000, async () =>
      Promise.all(
        Array.from({ length: 20 }, () => sql`select count(*)::int as n from public.customers`)
      )
    )
  );
  steps.push(await timed('workspace-3', 20000, () => dashboard.workspace(context, {})));

  return NextResponse.json(
    { totalMs: Date.now() - started, uptimeS: Math.round(process.uptime()), steps },
    { headers: { 'Cache-Control': 'no-store' } }
  );
}
