import { type Sql, type TransactionSql } from 'postgres';

type CounterRow = { last: number | string | bigint };
type CounterExecutor = (
  strings: TemplateStringsArray,
  ...values: unknown[]
) => PromiseLike<CounterRow[]> | CounterRow[];

function counterKeyFor(key: string, year?: number): string {
  return year === undefined ? key : `${key}:${year}`;
}

function formatCrmId(prefix: string, width: number, last: number | string | bigint, year?: number): string {
  const sequence = String(last).padStart(width, '0');
  return year === undefined ? `${prefix}-${sequence}` : `${prefix}-${year}-${sequence}`;
}

export async function nextCrmId(
  tx: Sql | TransactionSql | CounterExecutor,
  key: string,
  prefix: string,
  width: number,
  year?: number
): Promise<string> {
  if (!key.trim()) throw new Error('Counter key is required.');
  if (!prefix.trim()) throw new Error('CRM ID prefix is required.');
  if (!Number.isInteger(width) || width < 1) throw new Error('CRM ID width must be a positive integer.');
  if (year !== undefined && (!Number.isInteger(year) || year < 1)) {
    throw new Error('CRM ID year must be a positive integer.');
  }

  const runCounterQuery = tx as CounterExecutor;
  const [row] = await runCounterQuery`
    insert into counters (key, last)
    values (${counterKeyFor(key, year)}, ${1})
    on conflict (key)
    do update set last = counters.last + 1
    returning last
  `;

  if (!row) throw new Error('Counter allocation failed.');

  return formatCrmId(prefix, width, row.last, year);
}
