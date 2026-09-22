import { describe, expect, it } from 'vitest';

import { memoizeRepository } from './memoize-repository';

function makeRepo() {
  const calls: string[] = [];
  let users = ['a'];
  return {
    calls,
    async listUsers() {
      calls.push('listUsers');
      return [...users];
    },
    async getCustomer(id: string) {
      calls.push(`getCustomer:${id}`);
      return { id };
    },
    async addUser(name: string) {
      calls.push(`addUser:${name}`);
      users = [...users, name];
    },
    async boom() {
      calls.push('boom');
      throw new Error('nope');
    }
  };
}

const READS = ['listUsers', 'getCustomer', 'boom'] as const;

describe('memoizeRepository', () => {
  it('runs an identical read once per request', async () => {
    const repo = makeRepo();
    const memo = memoizeRepository(repo, READS);

    await memo.listUsers();
    await memo.listUsers();

    expect(repo.calls.filter((c) => c === 'listUsers')).toHaveLength(1);
  });

  it('shares one query between concurrent identical reads', async () => {
    const repo = makeRepo();
    const memo = memoizeRepository(repo, READS);

    await Promise.all([memo.listUsers(), memo.listUsers(), memo.listUsers()]);

    expect(repo.calls.filter((c) => c === 'listUsers')).toHaveLength(1);
  });

  it('treats different arguments as different reads', async () => {
    const repo = makeRepo();
    const memo = memoizeRepository(repo, READS);

    await memo.getCustomer('CUST-1');
    await memo.getCustomer('CUST-2');
    await memo.getCustomer('CUST-1');

    expect(repo.calls).toEqual(['getCustomer:CUST-1', 'getCustomer:CUST-2']);
  });

  it('clears the cache on a write so later reads see it', async () => {
    const repo = makeRepo();
    const memo = memoizeRepository(repo, READS);

    const before = await memo.listUsers();
    await memo.addUser('b');
    const after = await memo.listUsers();

    expect(before).toEqual(['a']);
    expect(after).toEqual(['a', 'b']);
    expect(repo.calls.filter((c) => c === 'listUsers')).toHaveLength(2);
  });

  it('does not share cached data between two wrappers', async () => {
    const repo = makeRepo();
    const first = memoizeRepository(repo, READS);
    const second = memoizeRepository(repo, READS);

    await first.listUsers();
    await second.listUsers();

    expect(repo.calls.filter((c) => c === 'listUsers')).toHaveLength(2);
  });

  it('re-runs a read whose previous attempt rejected', async () => {
    const repo = makeRepo();
    const memo = memoizeRepository(repo, READS);

    await expect(memo.boom()).rejects.toThrow('nope');
    await expect(memo.boom()).rejects.toThrow('nope');

    expect(repo.calls.filter((c) => c === 'boom')).toHaveLength(2);
  });

  it('never caches a transaction, and clears the cache around it', async () => {
    const repo = Object.assign(makeRepo(), {
      async withTransaction<T>(fn: () => Promise<T>): Promise<T> {
        repo.calls.push('withTransaction');
        return fn();
      }
    });
    const memo = memoizeRepository(repo, READS);

    await memo.listUsers();
    await memo.withTransaction(async () => 'done');
    await memo.withTransaction(async () => 'done');
    await memo.listUsers();

    expect(repo.calls.filter((c) => c === 'withTransaction')).toHaveLength(2);
    expect(repo.calls.filter((c) => c === 'listUsers')).toHaveLength(2);
  });

  it('passes through non-function properties untouched', () => {
    const repo = Object.assign(makeRepo(), { label: 'cases' });
    const memo = memoizeRepository(repo, READS);

    expect(memo.label).toBe('cases');
  });
});
