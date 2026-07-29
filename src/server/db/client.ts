import postgres, { type TransactionSql } from 'postgres';

export const sql = postgres(process.env.DATABASE_URL!, { prepare: false });

export async function withTransaction<T>(fn: (tx: TransactionSql) => T | Promise<T>): Promise<T> {
  return sql.begin((tx) => fn(tx)) as Promise<T>;
}
