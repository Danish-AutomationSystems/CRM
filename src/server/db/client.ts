import postgres, { type TransactionSql } from 'postgres';

// max stays at postgres.js's default of 10: transaction callbacks here can
// check out a second connection while holding the first (see
// settings/no-live-settings-in-transaction.test.ts), so a small pool
// deadlocks instead of merely queueing. connect_timeout keeps an exhausted
// pool failing fast rather than stalling to the function limit.
export const sql = postgres(process.env.DATABASE_URL!, {
  prepare: false,
  connect_timeout: 10
});

export async function withTransaction<T>(fn: (tx: TransactionSql) => T | Promise<T>): Promise<T> {
  return sql.begin((tx) => fn(tx)) as Promise<T>;
}
