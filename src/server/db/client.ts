import postgres, { type TransactionSql } from 'postgres';

export const sql = postgres(process.env.DATABASE_URL!, {
  prepare: false,
  max: 1,
  idle_timeout: 20,
  connect_timeout: 10
});

export async function withTransaction<T>(fn: (tx: TransactionSql) => T | Promise<T>): Promise<T> {
  return sql.begin((tx) => fn(tx)) as Promise<T>;
}
