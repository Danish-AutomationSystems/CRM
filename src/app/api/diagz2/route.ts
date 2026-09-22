import { NextResponse } from 'next/server';
import postgres from 'postgres';

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

function burst(client: ReturnType<typeof postgres>, n: number) {
  return Promise.all(
    Array.from({ length: n }, () => client`select count(*)::int as n from public.customers`)
  );
}

// Compares the shared pool against fresh clients on the transaction pooler
// (6543) and the session pooler (5432) under identical parallel load, to
// establish whether the pooler mode is what stalls.
export async function GET(): Promise<NextResponse> {
  const started = Date.now();
  const steps: unknown[] = [];
  const raw = process.env.DATABASE_URL!;
  const on6543 = raw.replace(':5432/', ':6543/');
  const on5432 = raw.replace(':6543/', ':5432/');

  steps.push(await timed('shared-pool-burst20', 9000, () => burst(sql, 20)));

  const c6543 = postgres(on6543, { prepare: false, connect_timeout: 8, idle_timeout: 2 });
  steps.push(await timed('fresh-6543-burst20', 9000, () => burst(c6543, 20)));
  try {
    await c6543.end({ timeout: 3 });
  } catch {
    // ignore
  }

  const c5432 = postgres(on5432, { prepare: false, connect_timeout: 8, idle_timeout: 2 });
  steps.push(await timed('fresh-5432-burst20', 9000, () => burst(c5432, 20)));
  try {
    await c5432.end({ timeout: 3 });
  } catch {
    // ignore
  }

  steps.push(await timed('shared-pool-single', 9000, () => burst(sql, 1)));

  return NextResponse.json(
    { totalMs: Date.now() - started, uptimeS: Math.round(process.uptime()), steps },
    { headers: { 'Cache-Control': 'no-store' } }
  );
}
