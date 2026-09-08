import { describe, expect, it, vi } from 'vitest';
import { withTransaction } from './client';
import { PostgresQuoteRepository } from '../quotes/repository';
import { createQuoteService } from '../quotes/service';

vi.mock('./client', () => ({ sql: undefined, withTransaction: vi.fn() }));

// Run the service and the actual SQL repository, mocking only the database/Drive
// transport. A root executor write, missing FOR UPDATE, or detached audit insert
// fails this test even if an in-memory repository would accept that workflow.
describe.each(['generated', 'uploaded'] as const)('%s first-quotation SQL transaction', (mode) => {
  it.each([false, true])('keeps locking, mapping, audit and quote persistence on the transaction executor (insert failure: %s)', async (failInsert) => {
    const actor = { email: 'sales@example.com', name: 'Sales', role: 'L2' as const, allowedTags: ['Punjab'], active: true };
    const calls: Array<{ query: string; values: unknown[]; transaction: boolean }> = [];
    function executor(transaction: boolean) {
      async function execute(query: string, values: unknown[]) {
        calls.push({ query, values, transaction });
        if (/from public\.customers\b/.test(query)) return [{ customer_id: 'CUST-1', name: 'Target', tags: ['Punjab'], status: 'Active' }];
        if (/from public\.handlers\b/.test(query)) return [{ customer_id: 'CUST-1', user_email: actor.email }];
        if (/from public\.cases\b/.test(query)) return [{ case_id: 'CASE-1', customer_id: null, title: 'Lead', stage: 'Lead', owner: actor.email, extra_owners: '', assignee: actor.email }];
        if (/insert into counters/.test(query)) return [{ last: 1 }];
        if (failInsert && /insert into public\.quotations\b/.test(query)) throw new Error('SQL quote failure');
        return [];
      }
      return Object.assign((parts: TemplateStringsArray, ...values: unknown[]) => execute(parts.join('?').replace(/\s+/g, ' ').trim(), values), { unsafe: execute });
    }
    const root = executor(false);
    const tx = executor(true);
    vi.mocked(withTransaction).mockImplementation(async (fn) => fn(tx as never));
    const remove = vi.fn();
    const service = createQuoteService(new PostgresQuoteRepository(root as never), {
      getDriveClient: () => ({ uploadFile: async () => ({ id: 'upload-1' }), deleteFile: remove, renameFile: async () => {} }) as never,
      getQuotationsFolderId: async () => 'quotes'
    });
    const input = { customerId: 'CUST-1', caseId: 'CASE-1', blocks: [{ headers: ['Item'], rows: [['PLC']] }], fileName: 'quote.pdf', dataB64: 'cGRm' };
    const operation = mode === 'generated' ? service.createQuotation(actor, input) : service.uploadQuotation(actor, input);
    if (failInsert) await expect(operation).rejects.toThrow('SQL quote failure');
    else await operation;
    const writes = calls.filter(({ query }) => /^(insert|update)/.test(query));
    expect(writes.length).toBeGreaterThan(2);
    expect(writes.every(({ transaction }) => transaction)).toBe(true);
    const lock = calls.findIndex(({ query, transaction }) => transaction && /from public\.cases.*for update$/.test(query));
    const mapping = calls.findIndex(({ query }) => /^update public\.cases set customer_id = \$1, updated_at = \$2, version = version \+ 1 where case_id = \$3$/.test(query));
    const audit = calls.findIndex(({ query, values }) => /insert into public\.activity_log/.test(query) && values[1] === 'CASE_CUSTOMER_MAP');
    const quote = calls.findIndex(({ query }) => /insert into public\.quotations/.test(query));
    expect(lock).toBeGreaterThanOrEqual(0);
    expect(mapping).toBeGreaterThan(lock);
    expect(audit).toBeGreaterThan(mapping);
    expect(quote).toBeGreaterThan(audit);
    expect(calls[mapping].values).toEqual(['CUST-1', expect.any(String), 'CASE-1']);
    expect(calls[audit].values.slice(0, 4)).toEqual([actor.email, 'CASE_CUSTOMER_MAP', 'CASE-1', 'CUST-1']);
    expect(calls[quote].values.slice(2, 4)).toEqual(['CASE-1', 'CUST-1']);
    if (failInsert && mode === 'uploaded') expect(remove).toHaveBeenCalledWith('upload-1');
  });
});
