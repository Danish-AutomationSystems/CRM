import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { CaseRow } from '../cases/service';
import { PostgresCaseRepository } from '../cases/repository';
import { PostgresQuoteRepository } from '../quotes/repository';
import { allCasesColumns } from './cases-columns.test-helpers';

// The SQL executor is the external boundary; the real repositories and patch
// builder run unchanged. No client, credentials or database connection is used.
vi.mock('./client', () => ({ sql: undefined, withTransaction: vi.fn() }));

type Mutable = Exclude<keyof CaseRow, 'id' | 'createdBy' | 'createdAt'>;
// Literal fixtures cover every legal CaseRow write. `satisfies` makes newly
// added mutable CaseRow properties require an explicit fixture at typecheck.
const mappings = {
  customerId: { column: 'customer_id', input: 'CUST-2', stored: 'CUST-2' },
  title: { column: 'title', input: "O'Brien $1; --", stored: "O'Brien $1; --" },
  details: { column: 'details', input: 'Line one\nLine two', stored: 'Line one\nLine two' },
  source: { column: 'source', input: 'Referral', stored: 'Referral' },
  priority: { column: 'priority', input: 'High', stored: 'High' },
  stage: { column: 'stage', input: 'Revision', stored: 'Revision' },
  outcome: { column: 'outcome', input: 'Won', stored: 'Won' },
  orderValue: { column: 'order_value', input: 1234.5, stored: 1234.5 },
  wonCategories: { column: 'won_categories', input: ['PLC', 'VFD'], stored: 'PLC | VFD' },
  outcomeNote: { column: 'outcome_note', input: 'PO received', stored: 'PO received' },
  owner: { column: 'owner', input: ' OWNER@EXAMPLE.COM ', stored: 'owner@example.com' },
  extraOwners: { column: 'extra_owners', input: ['a@example.com', 'b@example.com'], stored: 'a@example.com | b@example.com' },
  assignee: { column: 'assignee', input: ' WORKER@EXAMPLE.COM ', stored: 'worker@example.com' },
  closedOn: { column: 'closed_on', input: '2026-09-07', stored: '2026-09-07' },
  updatedAt: { column: 'updated_at', input: '2026-09-07T12:00:00Z', stored: '2026-09-07T12:00:00Z' }
} satisfies { [K in Mutable]: { column: string; input: CaseRow[K]; stored: unknown } };

const factories = [['cases', PostgresCaseRepository], ['quotes', PostgresQuoteRepository]] as const;
describe.each(factories)('%s case SQL boundary', (_name, Repository) => {
  // A dropped/incorrect map or serializer must change the emitted column/value.
  it.each(Object.entries(mappings))('atomically maps %s without reading or writing other case fields', async (field, fixture) => {
    const unsafe = vi.fn().mockResolvedValue([]);
    const db = Object.assign(vi.fn(() => { throw new Error('updateCase must not fetch a stale row'); }), { unsafe });
    await new Repository(db as never).updateCase('CASE-1', { [field]: fixture.input });
    expect(unsafe.mock.calls).toEqual([[
      `update public.cases set ${fixture.column} = $1, version = version + 1 where case_id = $2`,
      [fixture.stored, 'CASE-1']
    ]]);
  });

  it('preserves blank/null, zero and pipe-array semantics while excluding immutable and undefined fields', async () => {
    const unsafe = vi.fn().mockResolvedValue([]);
    const repo = new Repository({ unsafe } as never);
    await repo.updateCase('CASE-1', {
      outcome: '', orderValue: '', wonCategories: [], owner: '', extraOwners: [], assignee: '', closedOn: '',
      title: undefined, id: 'OTHER', createdBy: 'other@example.com', createdAt: 'yesterday', version: 99,
      'title = null; drop table cases; --': 'ignored'
    } as Partial<CaseRow>);
    expect(unsafe.mock.calls).toEqual([[
      'update public.cases set outcome = $1, order_value = $2, won_categories = $3, owner = $4, extra_owners = $5, assignee = $6, closed_on = $7, version = version + 1 where case_id = $8',
      [null, null, '', null, '', null, null, 'CASE-1']
    ]]);
    unsafe.mockClear();
    await repo.updateCase('CASE-1', { orderValue: 0 });
    expect(unsafe.mock.calls[0][1]).toEqual([0, 'CASE-1']);
    await expect(repo.updateCase('CASE-1', { title: undefined })).rejects.toThrow('No mutable case fields');
    expect(unsafe).toHaveBeenCalledTimes(1);
  });

  it('locks the requested row and returns its latest mapped workflow state', async () => {
    const db = vi.fn().mockResolvedValue([{
      case_id: 'CASE-1', customer_id: 'CUST-2', title: 'Latest', details: '', source: '', priority: 'High',
      stage: 'Revision', outcome: null, order_value: null, won_categories: 'PLC|VFD', outcome_note: '',
      owner: 'owner@example.com', extra_owners: 'a@example.com|b@example.com', assignee: 'worker@example.com',
      closed_on: null, created_by: 'owner@example.com', created_at: '2026-09-01', updated_at: '2026-09-07'
    }]);
    const repo = new Repository(db as never);
    expect(await repo.lockCase('CASE-1')).toMatchObject({ id: 'CASE-1', stage: 'Revision', assignee: 'worker@example.com', outcome: '', orderValue: '', wonCategories: ['PLC', 'VFD'], extraOwners: ['a@example.com', 'b@example.com'] });
    const [parts, ...values] = db.mock.calls[0] as unknown as [TemplateStringsArray, ...unknown[]];
    expect(parts.join('?').replace(/\s+/g, ' ').trim()).toMatch(/from public\.cases where case_id = \? for update$/);
    expect(values).toEqual(['CASE-1']);
    db.mockResolvedValueOnce([]);
    expect(await repo.lockCase('missing')).toBeNull();
  });
});

it('covers every persisted mutable column, including columns introduced by migrations', () => {
  const immutable = ['case_id', 'created_by', 'created_at', 'version'];
  const columns = allCasesColumns(join(__dirname, '../../../supabase/migrations')).filter((column) => !immutable.includes(column));
  expect(Object.values(mappings).map(({ column }) => column).sort()).toEqual(columns.sort());
});

describe.each(factories)('%s nullable case SQL boundary', (_name, Repository) => {
  it('serializes empty customer IDs as NULL in inserts and updates, and reads NULL as empty', async () => {
    const db = Object.assign(vi.fn().mockResolvedValue([]), { unsafe: vi.fn().mockResolvedValue([]) });
    const repo = new Repository(db as never);
    const row: CaseRow = { id: 'CASE-1', customerId: '', title: 'Unmapped', details: '', source: '', priority: '', stage: 'Lead', outcome: '', orderValue: '', wonCategories: [], outcomeNote: '', owner: '', extraOwners: [], assignee: '', closedOn: '', createdBy: '', createdAt: '2026-09-07', updatedAt: '2026-09-07' };
    await repo.createCase(row);
    const [, ...values] = db.mock.calls[0] as unknown as [TemplateStringsArray, ...unknown[]];
    expect(values[1]).toBeNull();
    await repo.updateCase(row.id, { customerId: '' });
    expect(db.unsafe.mock.calls[0][1]).toEqual([null, row.id]);
    db.mockResolvedValue([{ case_id: row.id, customer_id: null, stage: 'Lead', extra_owners: '', won_categories: '' }]);
    expect((await repo.getCase(row.id))?.customerId).toBe('');
    expect((await repo.lockCase(row.id))?.customerId).toBe('');
  });
});
