import postgres, { type TransactionSql } from 'postgres';

// max stays at postgres.js's default of 10: transaction callbacks here can
// check out a second connection while holding the first (see
// settings/no-live-settings-in-transaction.test.ts), so a small pool
// deadlocks instead of merely queueing. connect_timeout keeps an exhausted
// pool failing fast rather than stalling to the function limit.
// idle_timeout/max_lifetime matter on Vercel: a frozen lambda's idle sockets
// die silently, and reusing one stalls until the function limit. Retiring
// connections proactively keeps a thawed instance from picking up a dead one.
export const sql = postgres(process.env.DATABASE_URL!, {
  prepare: false,
  connect_timeout: 10,
  // Retires idle connections so a frozen instance is less likely to thaw and
  // reuse a socket nobody drains, which strands the query in ClientWrite for
  // minutes of TCP retransmits. Dropping this to 2s was measured against 30s
  // under load and made no difference, so it stays at the less churny value.
  idle_timeout: 30,
  max_lifetime: 60 * 5
});

export async function withTransaction<T>(fn: (tx: TransactionSql) => T | Promise<T>): Promise<T> {
  return sql.begin((tx) => fn(tx)) as Promise<T>;
}
