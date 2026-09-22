import { NextResponse } from 'next/server';

import { sql } from '../../../server/db/client';

export const dynamic = 'force-dynamic';
export const maxDuration = 40;

// Exercises the SHARED pool (the one every repository uses), so a stall that
// only appears on a reused connection is reproducible without a browser.
export async function GET(): Promise<NextResponse> {
  const started = Date.now();
  const steps: Array<Record<string, unknown>> = [];

  for (const label of ['first', 'second', 'third']) {
    const t = Date.now();
    try {
      const rows = await Promise.race([
        sql`select count(*)::int as n from public.customers`,
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('STALLED >12s')), 12000)
        )
      ]);
      steps.push({ label, ok: true, ms: Date.now() - t, n: (rows as Array<{ n: number }>)[0]?.n });
    } catch (error) {
      steps.push({ label, ok: false, ms: Date.now() - t, error: (error as Error).message });
    }
  }

  return NextResponse.json(
    { totalMs: Date.now() - started, pid: process.pid, uptimeS: Math.round(process.uptime()), steps },
    { headers: { 'Cache-Control': 'no-store' } }
  );
}
