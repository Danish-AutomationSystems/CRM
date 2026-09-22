import { NextResponse } from 'next/server';

import { caseRepository } from '../../../server/cases/repository';
import { createCaseService } from '../../../server/cases/service';
import { customerRepository } from '../../../server/customers/repository';
import { createCustomerService } from '../../../server/customers/service';
import { createDashboardService } from '../../../server/dashboard/service';
import type { CrmContext } from '../../../server/auth/context';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

// Temporary capacity probe. One request here does the same data work as one
// dashboard load, so external concurrency against it measures the real thing:
// separate invocations that the platform spreads across instances, rather than
// a fan-out inside a single instance sharing one pool.
const CONTEXTS: CrmContext[] = [
  { email: 'danish@automationsystems.org', name: 'Danish', role: 'L4', allowedTags: ['*'], active: true },
  { email: 'ajayneb@automationsystems.org', name: 'Ajay Neb', role: 'L2', allowedTags: ['Chandigarh', 'Geo', 'Punjab'], active: true },
  { email: 'testing@automationsystems.org', name: 'Testing', role: 'L2', allowedTags: ['*'], active: true },
  { email: 'himanshuneb@automationsystems.org', name: 'Himanshu Neb', role: 'L6', allowedTags: ['*'], active: true }
];

export async function GET(request: Request): Promise<NextResponse> {
  const started = Date.now();
  const who = Number(new URL(request.url).searchParams.get('u') ?? 0);
  const context = CONTEXTS[who % CONTEXTS.length];

  const customerService = createCustomerService(customerRepository);
  const caseService = createCaseService(caseRepository);
  const dashboard = createDashboardService(caseRepository, { customerService, caseService });

  try {
    const result = (await dashboard.workspace(context, {})) as {
      cases?: { cases?: unknown[] } | null;
      customers?: { customers?: unknown[] } | null;
    };
    return NextResponse.json(
      {
        ok: true,
        ms: Date.now() - started,
        uptimeS: Math.round(process.uptime()),
        cases: result?.cases?.cases?.length ?? null,
        customers: result?.customers?.customers?.length ?? null
      },
      { headers: { 'Cache-Control': 'no-store' } }
    );
  } catch (error) {
    return NextResponse.json(
      { ok: false, ms: Date.now() - started, error: (error as Error).message },
      { status: 500, headers: { 'Cache-Control': 'no-store' } }
    );
  }
}
