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

const probe = () => sql`select 1 as ok`;

// Runs each workspace component once, probing the shared pool immediately
// after each, so the first failing probe names the call that exhausts it.
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

  steps.push(await timed('probe-baseline', 6000, probe));

  steps.push(await timed('bootstrap', 6000, () => dashboard.bootstrap(context)));
  steps.push(await timed('probe-after-bootstrap', 6000, probe));

  steps.push(await timed('myCustomers', 6000, () => customerService.myCustomers(context)));
  steps.push(await timed('probe-after-myCustomers', 6000, probe));

  steps.push(await timed('listCases', 6000, () => caseService.listCases(context, {} as never)));
  steps.push(await timed('probe-after-listCases', 6000, probe));

  return NextResponse.json(
    { totalMs: Date.now() - started, uptimeS: Math.round(process.uptime()), steps },
    { headers: { 'Cache-Control': 'no-store' } }
  );
}
