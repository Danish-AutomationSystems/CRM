import { NextResponse } from 'next/server';
import postgres from 'postgres';

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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Isolates idle_timeout as the variable: same load, same pooler, one client
// that retires idle connections aggressively and one that keeps them.
async function trial(label: string, idleTimeout: number | undefined, steps: unknown[]) {
  const client = postgres(process.env.DATABASE_URL!, {
    prepare: false,
    connect_timeout: 8,
    ...(idleTimeout === undefined ? {} : { idle_timeout: idleTimeout })
  });

  const burst = () =>
    Promise.all(Array.from({ length: 6 }, () => client`select count(*)::int as n from public.customers`));

  steps.push(await timed(`${label}-burst1`, 8000, burst));
  await sleep(3500);
  steps.push(await timed(`${label}-burst2-after-3.5s-idle`, 8000, burst));
  await sleep(3500);
  steps.push(await timed(`${label}-burst3-after-3.5s-idle`, 8000, burst));

  try {
    await client.end({ timeout: 3 });
  } catch {
    // ignore
  }
}

export async function GET(): Promise<NextResponse> {
  const started = Date.now();
  const steps: unknown[] = [];

  await trial('idle2', 2, steps);
  await trial('idle-default', undefined, steps);

  return NextResponse.json(
    { totalMs: Date.now() - started, uptimeS: Math.round(process.uptime()), steps },
    { headers: { 'Cache-Control': 'no-store' } }
  );
}
