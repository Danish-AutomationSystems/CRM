import { NextResponse } from 'next/server';

import { caseRepository } from '../../../server/cases/repository';

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

// bootstrap's three parallel reads, run twice, to name the repository call
// that stalls on repeat.
export async function GET(): Promise<NextResponse> {
  const started = Date.now();
  const steps: unknown[] = [];

  for (const round of ['r1', 'r2', 'r3']) {
    steps.push(await timed(`${round}-listUsers`, 5000, () => caseRepository.listUsers()));
    steps.push(await timed(`${round}-listHandlers`, 5000, () => caseRepository.listHandlers()));
    steps.push(await timed(`${round}-listActivity250`, 5000, () => caseRepository.listActivity(250)));
    steps.push(await timed(`${round}-listSettings`, 5000, () => caseRepository.listSettings()));
    steps.push(
      await timed(`${round}-parallel-all4`, 8000, () =>
        Promise.all([
          caseRepository.listUsers(),
          caseRepository.listHandlers(),
          caseRepository.listActivity(250),
          caseRepository.listSettings()
        ])
      )
    );
  }

  return NextResponse.json(
    { totalMs: Date.now() - started, uptimeS: Math.round(process.uptime()), steps },
    { headers: { 'Cache-Control': 'no-store' } }
  );
}
