import { NextResponse } from 'next/server';
import postgres from 'postgres';

import { caseRepository } from '../../../server/cases/repository';
import { createCaseService } from '../../../server/cases/service';
import { customerRepository } from '../../../server/customers/repository';
import { createCustomerService } from '../../../server/customers/service';
import { createDashboardService } from '../../../server/dashboard/service';
import type { CrmContext } from '../../../server/auth/context';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

function describeUrl(raw: string | undefined) {
  if (!raw) return { present: false };
  try {
    const u = new URL(raw);
    return { present: true, host: u.hostname, port: u.port, user: u.username };
  } catch {
    return { present: true, parse: 'failed' };
  }
}

async function timed<T>(label: string, ms: number, fn: () => Promise<T>) {
  const start = Date.now();
  try {
    const value = await Promise.race([
      fn(),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`TIMED OUT after ${ms}ms`)), ms)
      )
    ]);
    const size = Array.isArray(value) ? value.length : value && typeof value === 'object' ? Object.keys(value).length : 1;
    return { step: label, ok: true, ms: Date.now() - start, size };
  } catch (error) {
    return { step: label, ok: false, ms: Date.now() - start, error: (error as Error).message };
  }
}

export async function GET(): Promise<NextResponse> {
  const started = Date.now();
  const results: unknown[] = [];

  const sql = postgres(process.env.DATABASE_URL!, {
    prepare: false,
    max: 1,
    connect_timeout: 8,
    idle_timeout: 5
  });

  results.push(await timed('raw_select_1', 10000, async () => sql`select 1 as ok`));
  results.push(await timed('raw_users', 10000, async () => sql`select count(*)::int as n from public.users`));
  try {
    await sql.end({ timeout: 3 });
  } catch {
    // ignore
  }

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

  results.push(await timed('bootstrap', 15000, () => dashboard.bootstrap(context)));
  results.push(await timed('myCustomers', 15000, () => customerService.myCustomers(context)));
  results.push(await timed('listCases', 15000, () => caseService.listCases(context, {} as never)));

  return NextResponse.json(
    { totalMs: Date.now() - started, env: describeUrl(process.env.DATABASE_URL), results },
    { headers: { 'Cache-Control': 'no-store' } }
  );
}
