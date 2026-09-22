import { NextResponse } from 'next/server';

import { caseRepository } from '../../../server/cases/repository';
import { createCaseService } from '../../../server/cases/service';
import { customerRepository } from '../../../server/customers/repository';
import { createCustomerService } from '../../../server/customers/service';
import { createDashboardService } from '../../../server/dashboard/service';
import type { CrmContext } from '../../../server/auth/context';

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

// L4 short-circuits recentActivity's batched customer lookup (every row counts
// as a self row), so only a lower-privileged context exercises that path.
const L2: CrmContext = {
  email: 'ajayneb@automationsystems.org',
  name: 'Ajay Neb',
  role: 'L2',
  allowedTags: ['Chandigarh', 'Geo', 'Punjab'],
  active: true
};

const L4: CrmContext = {
  email: 'danish@automationsystems.org',
  name: 'Danish',
  role: 'L4',
  allowedTags: ['*'],
  active: true
};

export async function GET(): Promise<NextResponse> {
  const started = Date.now();
  const steps: unknown[] = [];

  const customerService = createCustomerService(customerRepository);
  const caseService = createCaseService(caseRepository);
  const dashboard = createDashboardService(caseRepository, { customerService, caseService });

  steps.push(await timed('getCustomersByIds-empty', 5000, () => caseRepository.getCustomersByIds([])));
  steps.push(
    await timed('getCustomersByIds-real', 8000, async () => {
      const all = await customerRepository.listCustomers();
      const ids = all.map((c) => c.id);
      return caseRepository.getCustomersByIds(ids);
    })
  );

  steps.push(await timed('L2-bootstrap-1', 10000, () => dashboard.bootstrap(L2)));
  steps.push(await timed('L2-bootstrap-2', 10000, () => dashboard.bootstrap(L2)));
  steps.push(await timed('L2-workspace', 12000, () => dashboard.workspace(L2, {})));
  steps.push(await timed('L4-bootstrap', 8000, () => dashboard.bootstrap(L4)));

  return NextResponse.json(
    { totalMs: Date.now() - started, uptimeS: Math.round(process.uptime()), steps },
    { headers: { 'Cache-Control': 'no-store' } }
  );
}
