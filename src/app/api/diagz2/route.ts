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

// Same nested fan-out bootstrap performs: an outer Promise.all whose middle
// branch fans out again, with listUsers running on both levels at once.
const bootstrapShape = () =>
  Promise.all([
    caseRepository.listUsers(),
    Promise.all([
      caseRepository.listActivity(250),
      caseRepository.listHandlers(),
      caseRepository.listUsers()
    ]),
    caseRepository.listSettings()
  ]);

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

  steps.push(await timed('shape-1', 8000, bootstrapShape));
  steps.push(await timed('shape-2', 8000, bootstrapShape));
  steps.push(await timed('shape-3', 8000, bootstrapShape));

  const customerService = createCustomerService(customerRepository);
  const caseService = createCaseService(caseRepository);
  const dashboard = createDashboardService(caseRepository, { customerService, caseService });

  steps.push(await timed('real-bootstrap-1', 8000, () => dashboard.bootstrap(L4)));
  steps.push(await timed('real-bootstrap-2', 8000, () => dashboard.bootstrap(L4)));

  return NextResponse.json(
    { totalMs: Date.now() - started, uptimeS: Math.round(process.uptime()), steps },
    { headers: { 'Cache-Control': 'no-store' } }
  );
}
