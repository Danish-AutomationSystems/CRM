import { describe, expect, it } from 'vitest';

import { nextCrmId } from './ids';

type CounterRow = { last: number };
type CounterTx = {
  (strings: TemplateStringsArray, ...values: unknown[]): Promise<CounterRow[]>;
  counters: Map<string, number>;
};

function createCounterTx(): CounterTx {
  const counters = new Map<string, number>();
  let queue = Promise.resolve();

  const tx = (async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const statement = strings.join('$');
    if (!statement.includes('insert into counters')) {
      throw new Error(`Unexpected SQL in fake transaction: ${statement}`);
    }

    const [counterKey, initialLast] = values;
    if (typeof counterKey !== 'string' || typeof initialLast !== 'number') {
      throw new Error('Counter allocation must provide a string key and numeric initial value.');
    }

    const next = queue.then(async () => {
      const current = counters.get(counterKey) ?? initialLast - 1;
      const last = current + 1;
      counters.set(counterKey, last);
      return [{ last }];
    });

    queue = next.then(
      () => undefined,
      () => undefined
    );

    return next;
  }) as CounterTx;

  tx.counters = counters;
  return tx;
}

describe('nextCrmId', () => {
  it('allocates customer, contact, and action IDs from zero', async () => {
    const tx = createCounterTx();

    await expect(nextCrmId(tx, 'customers', 'CUST', 4)).resolves.toBe('CUST-0001');
    await expect(nextCrmId(tx, 'contacts', 'CT', 4)).resolves.toBe('CT-0001');
    await expect(nextCrmId(tx, 'actions', 'ACT', 5)).resolves.toBe('ACT-00001');
  });

  it('includes the year in case and quotation IDs', async () => {
    const tx = createCounterTx();

    await expect(nextCrmId(tx, 'cases', 'CASE', 4, 2026)).resolves.toBe('CASE-2026-0001');
    await expect(nextCrmId(tx, 'quotations', 'QTN', 4, 2026)).resolves.toBe('QTN-2026-0001');
  });

  it('uses separate yearly counters', async () => {
    const tx = createCounterTx();

    await expect(nextCrmId(tx, 'cases', 'CASE', 4, 2026)).resolves.toBe('CASE-2026-0001');
    await expect(nextCrmId(tx, 'cases', 'CASE', 4, 2027)).resolves.toBe('CASE-2027-0001');
  });

  it('does not return duplicate IDs for concurrent allocations', async () => {
    const tx = createCounterTx();

    const ids = await Promise.all(
      Array.from({ length: 25 }, () => nextCrmId(tx, 'customers', 'CUST', 4))
    );

    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain('CUST-0001');
    expect(ids).toContain('CUST-0025');
  });
});
