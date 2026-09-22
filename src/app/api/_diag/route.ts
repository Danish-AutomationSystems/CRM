import { NextResponse } from 'next/server';
import postgres from 'postgres';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

function describeUrl(raw: string | undefined) {
  if (!raw) return { present: false };
  try {
    const u = new URL(raw);
    return { present: true, host: u.hostname, port: u.port, user: u.username, db: u.pathname };
  } catch {
    return { present: true, parse: 'failed' };
  }
}

export async function GET(): Promise<NextResponse> {
  const started = Date.now();
  const steps: Record<string, unknown> = {
    env: describeUrl(process.env.DATABASE_URL)
  };

  const sql = postgres(process.env.DATABASE_URL!, {
    prepare: false,
    max: 1,
    connect_timeout: 8,
    idle_timeout: 5
  });

  try {
    const t = Date.now();
    const rows = await sql`select 1 as ok`;
    steps.query = { ok: true, ms: Date.now() - t, rows: rows.length };
  } catch (error) {
    steps.query = { ok: false, error: (error as Error).message, ms: Date.now() - started };
  }

  try {
    const t = Date.now();
    const rows = await sql`select count(*)::int as n from public.users`;
    steps.users = { ok: true, ms: Date.now() - t, n: rows[0]?.n };
  } catch (error) {
    steps.users = { ok: false, error: (error as Error).message };
  }

  try {
    await sql.end({ timeout: 3 });
  } catch {
    // ignore teardown errors
  }

  return NextResponse.json({ totalMs: Date.now() - started, ...steps }, {
    headers: { 'Cache-Control': 'no-store' }
  });
}
