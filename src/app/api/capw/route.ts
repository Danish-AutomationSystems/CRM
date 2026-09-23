import { NextResponse } from 'next/server';

import { caseRepository } from '../../../server/cases/repository';
import { createCaseService } from '../../../server/cases/service';
import { customerRepository } from '../../../server/customers/repository';
import { createCustomerService } from '../../../server/customers/service';
import { memoizeRepository } from '../../../server/db/memoize-repository';
import { CASE_READ_METHODS, CUSTOMER_READ_METHODS } from '../../../server/db/repository-reads';
import type { CrmContext } from '../../../server/auth/context';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

// Temporary write probe. Drives the real create paths - which take a
// transaction, an id counter and, for customers, a name row lock - so
// concurrent writes are measured rather than assumed safe.
const CONTEXTS: CrmContext[] = [
  { email: 'danish@automationsystems.org', name: 'Danish', role: 'L4', allowedTags: ['*'], active: true },
  { email: 'ajayneb@automationsystems.org', name: 'Ajay Neb', role: 'L2', allowedTags: ['Chandigarh', 'Geo', 'Punjab'], active: true },
  { email: 'testing@automationsystems.org', name: 'Testing', role: 'L2', allowedTags: ['*'], active: true },
  { email: 'himanshuneb@automationsystems.org', name: 'Himanshu Neb', role: 'L6', allowedTags: ['*'], active: true }
];

export async function GET(request: Request): Promise<NextResponse> {
  const started = Date.now();
  const params = new URL(request.url).searchParams;
  const who = Number(params.get('u') ?? 0);
  const mode = params.get('mode') ?? 'case';
  const nonce = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  // L6 must name an assignee explicitly, so use an L4/L2 context for case writes.
  const context = CONTEXTS[who % (mode === 'case' ? 3 : CONTEXTS.length)];

  const cases = memoizeRepository(caseRepository, CASE_READ_METHODS);
  const customers = memoizeRepository(customerRepository, CUSTOMER_READ_METHODS);

  try {
    let created: unknown;
    if (mode === 'customer') {
      created = await createCustomerService(customers).createCustomer(context, {
        name: `LOADTESTW Company ${nonce}`,
        tags: ['Punjab']
      } as never);
    } else {
      created = await createCaseService(cases).createCase(context, 'CUST-0001', {
        title: `LOADTESTW case ${nonce}`
      } as never);
    }

    const id =
      created && typeof created === 'object'
        ? ((created as { id?: string; caseId?: string; customerId?: string }).id ??
          (created as { caseId?: string }).caseId ??
          null)
        : null;

    return NextResponse.json(
      { ok: true, mode, ms: Date.now() - started, id, uptimeS: Math.round(process.uptime()) },
      { headers: { 'Cache-Control': 'no-store' } }
    );
  } catch (error) {
    return NextResponse.json(
      { ok: false, mode, ms: Date.now() - started, error: (error as Error).message },
      { status: 500, headers: { 'Cache-Control': 'no-store' } }
    );
  }
}
