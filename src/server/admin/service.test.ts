import { beforeEach, describe, expect, it } from 'vitest';

import type { CrmContext } from '../auth/context';
import { createRpcRegistry } from '../rpc/registry';
import {
  RENAME_TARGETS,
  renameArray,
  renamePipe,
  renameScalar,
  type RenameTarget
} from '../settings/config-targets';
import { registerAdminRpcs } from './rpc';
import { createAdminService, type AdminRepository } from './service';

type UserRow = Awaited<ReturnType<AdminRepository['listUsers']>>[number];
type CustomerRow = Awaited<ReturnType<AdminRepository['listCustomers']>>[number];
type ContactRow = Awaited<ReturnType<AdminRepository['listContactsByCustomer']>>[number];
type HandlerRow = Awaited<ReturnType<AdminRepository['listHandlers']>>[number];
type SettingRow = Awaited<ReturnType<AdminRepository['listSettings']>>[number];
type ImportCustomerRow = Awaited<ReturnType<AdminRepository['listImportCustomers']>>[number];
type ImportContactRow = Awaited<ReturnType<AdminRepository['listImportContacts']>>[number];
type RecycleRow = Awaited<ReturnType<AdminRepository['listRecycleCustomers']>>[number];

const admin: CrmContext = {
  email: 'admin@automationsystems.org',
  name: 'Admin User',
  role: 'L6',
  allowedTags: ['*'],
  active: true
};

const manager: CrmContext = {
  email: 'manager@automationsystems.org',
  name: 'Manager User',
  role: 'L5',
  allowedTags: ['*'],
  active: true
};

type FakeState = {
  users: UserRow[];
  customers: CustomerRow[];
  contacts: ContactRow[];
  handlers: HandlerRow[];
  settings: SettingRow[];
  importCustomers: ImportCustomerRow[];
  importContacts: ImportContactRow[];
  recycle: RecycleRow[];
  logs: Array<{ action: string; entity: string; customerId: string; details: string; who: string }>;
  tableRows: Record<string, Array<Record<string, string | string[]>>>;
  renames: Array<{ table: string; column: string; from: string; to: string }>;
};

function clone<T>(value: T): T {
  const copy: T = JSON.parse(JSON.stringify(value));
  return copy;
}

class FakeAdminRepository implements AdminRepository {
  users: UserRow[] = [];
  customers: CustomerRow[] = [];
  contacts: ContactRow[] = [];
  handlers: HandlerRow[] = [];
  settings: SettingRow[] = [];
  importCustomers: ImportCustomerRow[] = [];
  importContacts: ImportContactRow[] = [];
  recycle: RecycleRow[] = [];
  logs: Array<{ action: string; entity: string; customerId: string; details: string; who: string }> = [];
  lockedNames: string[] = [];
  customerSeq = 1;
  contactSeq = 1;

  /**
   * Raw rows keyed by table and database column name, used only by
   * renameConfigValue. A rename is the one operation that reaches columns this
   * repository has no typed accessor for - users.allowed_tags and
   * cases.won_categories among them - so it is modelled at the column level,
   * exactly as the SQL sees it, applying the shared semantics in
   * settings/config-targets.ts.
   */
  tableRows: Record<string, Array<Record<string, string | string[]>>> = {};
  renames: Array<{ table: string; column: string; from: string; to: string }> = [];
  /** Set to a table name to make its rewrite throw, standing in for a database error. */
  failRenameOn: string | null = null;
  committed = false;
  /** Ordered trace of writes inside the current transaction, for ordering assertions. */
  ops: string[] = [];

  /**
   * A real transaction, not just a callback runner: a rollback test is worthless
   * if the fake keeps every partial write the failed callback made.
   */
  async withTransaction<T>(fn: (repo?: AdminRepository) => Promise<T>): Promise<T> {
    const snapshot = this.snapshot();
    try {
      const result = await fn(this);
      this.committed = true;
      return result;
    } catch (error) {
      this.restore(snapshot);
      throw error;
    }
  }

  private snapshot(): FakeState {
    return clone({
      users: this.users,
      customers: this.customers,
      contacts: this.contacts,
      handlers: this.handlers,
      settings: this.settings,
      importCustomers: this.importCustomers,
      importContacts: this.importContacts,
      recycle: this.recycle,
      logs: this.logs,
      tableRows: this.tableRows,
      renames: this.renames
    });
  }

  private restore(state: FakeState): void {
    this.users = state.users;
    this.customers = state.customers;
    this.contacts = state.contacts;
    this.handlers = state.handlers;
    this.settings = state.settings;
    this.importCustomers = state.importCustomers;
    this.importContacts = state.importContacts;
    this.recycle = state.recycle;
    this.logs = state.logs;
    this.tableRows = state.tableRows;
    this.renames = state.renames;
  }

  async renameConfigValue(target: RenameTarget, oldValue: string, newValue: string): Promise<void> {
    this.ops.push(`rename:${target.table}.${target.column}`);
    if (this.failRenameOn === target.table) {
      throw new Error(`simulated database failure rewriting ${target.table}`);
    }
    this.renames.push({ table: target.table, column: target.column, from: oldValue, to: newValue });

    for (const row of this.tableRows[target.table] ?? []) {
      const stored = row[target.column];
      if (target.kind === 'array') {
        row[target.column] = renameArray(Array.isArray(stored) ? stored : [], oldValue, newValue);
      } else if (target.kind === 'pipe') {
        row[target.column] = renamePipe(typeof stored === 'string' ? stored : '', oldValue, newValue);
      } else {
        row[target.column] = renameScalar(typeof stored === 'string' ? stored : '', oldValue, newValue);
      }
    }
  }

  async lockCustomerName(name: string): Promise<void> {
    this.lockedNames.push(name.trim().toLowerCase().replace(/\s+/g, ' '));
  }

  async listUsers(): Promise<UserRow[]> {
    return this.users;
  }

  async getUser(email: string): Promise<UserRow | null> {
    return this.users.find((user) => user.email === email) ?? null;
  }

  async createUser(user: UserRow): Promise<void> {
    this.users.push(user);
  }

  async updateUser(email: string, fields: Partial<UserRow>): Promise<void> {
    const user = await this.getUser(email);
    if (!user) throw new Error('missing test user');
    Object.assign(user, fields);
  }

  async listSettings(): Promise<SettingRow[]> {
    return this.settings;
  }

  async setSetting(key: SettingRow['key'], value: string): Promise<void> {
    this.ops.push(`setSetting:${key}`);
    const existing = this.settings.find((setting) => setting.key === key);
    if (existing) existing.value = value;
    else this.settings.push({ key, value });
  }

  async nextCustomerId(): Promise<string> {
    return `CUST-${String(this.customerSeq++).padStart(4, '0')}`;
  }

  async nextContactId(): Promise<string> {
    return `CT-${String(this.contactSeq++).padStart(4, '0')}`;
  }

  async listCustomers(): Promise<CustomerRow[]> {
    return this.customers;
  }

  async getCustomer(id: string): Promise<CustomerRow | null> {
    return this.customers.find((customer) => customer.id === id) ?? null;
  }

  async findCustomerByName(name: string): Promise<CustomerRow | null> {
    const key = name.trim().toLowerCase().replace(/\s+/g, ' ');
    return this.customers.find((customer) => customer.name.trim().toLowerCase().replace(/\s+/g, ' ') === key) ?? null;
  }

  async createCustomer(customer: CustomerRow): Promise<void> {
    this.customers.push(customer);
  }

  async listContactsByCustomer(customerId: string): Promise<ContactRow[]> {
    return this.contacts.filter((contact) => contact.customerId === customerId);
  }

  async createContact(contact: ContactRow): Promise<void> {
    this.contacts.push(contact);
  }

  async listHandlers(): Promise<HandlerRow[]> {
    return this.handlers;
  }

  async addHandler(handler: HandlerRow): Promise<void> {
    this.handlers.push(handler);
  }

  async listImportCustomers(): Promise<ImportCustomerRow[]> {
    return this.importCustomers;
  }

  async deleteImportCustomers(ids: string[]): Promise<void> {
    this.importCustomers = this.importCustomers.filter((row) => !ids.includes(row.id));
  }

  async listImportContacts(): Promise<ImportContactRow[]> {
    return this.importContacts;
  }

  async deleteImportContacts(ids: string[]): Promise<void> {
    this.importContacts = this.importContacts.filter((row) => !ids.includes(row.id));
  }

  async listRecycleCustomers(): Promise<RecycleRow[]> {
    return this.recycle;
  }

  async getRecycleCustomer(id: string): Promise<RecycleRow | null> {
    return this.recycle.find((customer) => customer.id === id) ?? null;
  }

  async deleteRecycleCustomer(id: string): Promise<void> {
    this.recycle = this.recycle.filter((customer) => customer.id !== id);
  }

  async logActivity(entry: { action: string; entity: string; customerId: string; details: string; who: string }): Promise<void> {
    this.ops.push(`log:${entry.action}`);
    this.logs.push(entry);
  }
}

function user(overrides: Partial<UserRow> = {}): UserRow {
  return {
    email: 'sales@automationsystems.org',
    name: 'Sales User',
    role: 'L2',
    allowedTags: ['Punjab'],
    active: true,
    addedOn: '2026-07-29T00:00:00.000Z',
    addedBy: 'admin@automationsystems.org',
    ...overrides
  };
}

function customer(overrides: Partial<CustomerRow> = {}): CustomerRow {
  return {
    id: 'CUST-0001',
    name: 'Alpha Panels',
    tags: ['Punjab'],
    type: 'OEM',
    priority: 'High',
    area: 'Ludhiana',
    address: '',
    gstin: '',
    website: '',
    notes: '',
    sei: [],
    remarks: '',
    status: 'Active',
    createdBy: 'admin@automationsystems.org',
    createdAt: '2026-07-29T00:00:00.000Z',
    updatedAt: '2026-07-29T00:00:00.000Z',
    ...overrides
  };
}

function makeService(repo = new FakeAdminRepository()) {
  repo.users = [
    user({ email: 'admin@automationsystems.org', name: 'Admin User', role: 'L6', allowedTags: ['*'] }),
    user({ email: 'manager@automationsystems.org', name: 'Manager User', role: 'L5', allowedTags: ['*'] }),
    user()
  ];

  return { repo, service: createAdminService(repo) };
}

describe('admin service access and users', () => {
  it('requires L6 for every admin operation', async () => {
    const { service } = makeService();

    await expect(service.listUsers(manager)).rejects.toThrow('Admin access requires L6');
    await expect(service.saveUser(manager, { email: 'new@automationsystems.org' })).rejects.toThrow('Admin access requires L6');
    await expect(service.saveSettings(manager, { tags: ['Punjab'] })).rejects.toThrow('Admin access requires L6');
    await expect(service.links(manager)).rejects.toThrow('Admin access requires L6');
    await expect(service.runImport(manager)).rejects.toThrow('Admin access requires L6');
    await expect(service.runImportContacts(manager)).rejects.toThrow('Admin access requires L6');
    await expect(service.listRecycle(manager)).rejects.toThrow('Admin access requires L6');
    await expect(service.restoreCustomer(manager, 'CUST-0001')).rejects.toThrow('Admin access requires L6');
    await expect(service.purgeCustomer(manager, 'CUST-0001')).rejects.toThrow('Admin access requires L6');
  });

  it('lists active and inactive users with normalized allowed tags', async () => {
    const { repo, service } = makeService();
    repo.users.push(user({ email: 'inactive@automationsystems.org', active: false, allowedTags: ['NCR'] }));

    const users = await service.listUsers(admin);

    expect(users).toEqual([
      expect.objectContaining({ email: 'admin@automationsystems.org', allowedTags: ['*'], active: true }),
      expect.objectContaining({ email: 'inactive@automationsystems.org', allowedTags: ['NCR'], active: false }),
      expect.objectContaining({ email: 'manager@automationsystems.org', active: true }),
      expect.objectContaining({ email: 'sales@automationsystems.org', active: true }),
      // P9: Direct is synthesised, never a public.users row.
      { email: 'direct', name: 'Direct', role: 'L2', allowedTags: ['*'], active: true, addedOn: '', hasLogin: false }
    ]);
    expect(users.filter((row) => row.hasLogin === false)).toHaveLength(1);
  });

  it('P9: refuses to create or edit the virtual Direct account', async () => {
    const { repo, service } = makeService();

    await expect(service.saveUser(admin, { email: 'direct', name: 'Direct' })).rejects.toThrow();
    expect(repo.users.map((row) => row.email)).not.toContain('direct');
  });

  it('normalizes saved users, defaults invalid roles, preserves inactive users, and logs add/edit', async () => {
    const { repo, service } = makeService();

    await service.saveUser(admin, {
      email: ' NEW.USER@AutomationSystems.Org ',
      name: '  New User  ',
      role: 'Bad',
      allowedTags: ['Punjab', '*', 'NCR'],
      active: false
    });
    await service.saveUser(admin, {
      email: 'sales@automationsystems.org',
      name: '',
      role: 'L3',
      allowedTags: ['NCR', ''],
      active: true
    });

    expect(await repo.getUser('new.user@automationsystems.org')).toMatchObject({
      name: 'New User',
      role: 'L2',
      allowedTags: ['*'],
      active: false,
      addedBy: 'admin@automationsystems.org'
    });
    expect(await repo.getUser('sales@automationsystems.org')).toMatchObject({
      name: 'Sales User',
      role: 'L3',
      allowedTags: ['NCR'],
      active: true
    });
    expect(repo.logs.map((log) => log.action)).toEqual(['USER_ADD', 'USER_EDIT']);
  });

  it('blocks self deactivation and self demotion below L6', async () => {
    const { service } = makeService();

    await expect(service.saveUser(admin, { email: admin.email, active: false })).rejects.toThrow('deactivate your own');
    await expect(service.saveUser(admin, { email: admin.email, role: 'L5' })).rejects.toThrow('lower your own level');
  });
});

describe('admin service settings and links', () => {
  const oldEnv = { ...process.env };

  beforeEach(() => {
    process.env = { ...oldEnv };
    delete process.env.DATABASE_URL;
    delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  });

  it('persists normalized settings and keeps comma-bearing categories pipe-delimited', async () => {
    const { repo, service } = makeService();

    await service.saveSettings(admin, {
      tags: [' Punjab ', '', 'NCR'],
      types: ['OEM'],
      priorities: ['High', 'Low'],
      categories: ['Lighting, Switches, Wires', 'Service'],
      sources: ['Direct Enquiry'],
      taxPct: '18.5',
      currency: '',
      company: ' Automation Systems '
    });

    expect(repo.settings).toEqual([
      { key: 'TAGS', value: 'Punjab | NCR' },
      { key: 'TYPES', value: 'OEM' },
      { key: 'PRIORITIES', value: 'High | Low' },
      { key: 'CATEGORIES', value: 'Lighting, Switches, Wires | Service' },
      { key: 'SOURCES', value: 'Direct Enquiry' },
      { key: 'TAX_PCT', value: '18.5' },
      { key: 'CURRENCY', value: 'INR' },
      { key: 'COMPANY', value: 'Automation Systems' }
    ]);
    expect(repo.logs).toEqual([expect.objectContaining({ action: 'SETTINGS', details: 'Settings updated' })]);
    await expect(service.saveSettings(admin, { tags: [] })).rejects.toThrow('Keep at least one tag');
  });

  it('P8: an L6 can edit the SEI_NAMES list through the existing settings RPC', async () => {
    const { repo, service } = makeService();

    await service.saveSettings(admin, { seiNames: [' Ravi Kumar ', '', 'Anita Rao'] });
    expect(repo.settings).toEqual([{ key: 'SEI_NAMES', value: 'Ravi Kumar | Anita Rao' }]);

    // Clearing it back to empty is allowed - SEI is optional and ships empty.
    await service.saveSettings(admin, { seiNames: [] });
    expect(repo.settings).toEqual([{ key: 'SEI_NAMES', value: '' }]);
  });

  it('returns stack metadata links without leaking secrets or Google Drive storage', async () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://project.supabase.co';
    process.env.DATABASE_URL = 'postgres://secret-user:secret-pass@db.supabase.co:5432/postgres';
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-secret';
    const { service } = makeService();

    const links = await service.links(admin);

    expect(links).toEqual({
      app: 'AS CRM',
      database: 'Supabase Postgres',
      admin: 'Supabase dashboard',
      supabaseUrl: 'https://project.supabase.co',
      tables: ['users', 'customers', 'contacts', 'handlers', 'cases', 'quotations', 'recycle_bin', 'settings', 'import_customers', 'import_contacts']
    });
    expect(JSON.stringify(links)).not.toContain('secret');
    expect(JSON.stringify(links).toLowerCase()).not.toContain('drive');
  });
});

describe('admin service imports', () => {
  it('imports customers, skips duplicates, caps runs at 500, assigns active handlers, defaults to admin, clears rows, and logs', async () => {
    const { repo, service } = makeService();
    repo.customers = [customer({ name: 'Existing Co' })];
    repo.customerSeq = 2;
    repo.users.push(user({ email: 'other@automationsystems.org', name: 'Other User', role: 'L2', active: true }));
    repo.users.push(user({ email: 'inactive@automationsystems.org', name: 'Inactive User', active: false }));

    repo.importCustomers = Array.from({ length: 501 }, (_, index) => ({
      id: `imp-${index}`,
      rowNo: index + 1,
      name: `Cap ${index}`,
      tag: 'Punjab',
      type: 'OEM',
      priority: 'High',
      area: '',
      address: '',
      gstin: '',
      contactName: '',
      contactDesignation: '',
      contactPhone: '',
      contactEmail: '',
      handlers: ''
    }));
    await expect(service.runImport(admin)).rejects.toThrow('at most 500');

    repo.importCustomers = [
      {
        id: 'imp-1',
        rowNo: 1,
        name: ' existing co ',
        tag: 'Punjab',
        type: 'OEM',
        priority: 'High',
        area: '',
        address: '',
        gstin: '',
        contactName: '',
        contactDesignation: '',
        contactPhone: '',
        contactEmail: '',
        handlers: ''
      },
      {
        id: 'imp-2',
        rowNo: 2,
        name: 'New Co',
        tag: 'Punjab',
        type: 'OEM',
        priority: 'High',
        area: 'Mohali',
        address: 'Plot 1',
        gstin: 'GSTIN',
        contactName: 'Buyer',
        contactDesignation: 'GM',
        contactPhone: '123',
        contactEmail: 'buyer@example.com',
        handlers: 'other@automationsystems.org, inactive@automationsystems.org'
      },
      {
        id: 'imp-3',
        rowNo: 3,
        name: 'Fallback Co',
        tag: 'Bad',
        type: 'Bad',
        priority: 'Bad',
        area: '',
        address: '',
        gstin: '',
        contactName: '',
        contactDesignation: '',
        contactPhone: '',
        contactEmail: '',
        handlers: 'missing@automationsystems.org'
      }
    ];

    const result = await service.runImport(admin);

    expect(result).toEqual({ created: 2, skipped: ['existing co (exists as CUST-0001)'] });
    expect(repo.customers).toEqual([
      expect.objectContaining({ id: 'CUST-0001', name: 'Existing Co' }),
      expect.objectContaining({ id: 'CUST-0002', name: 'New Co', tags: ['Punjab'], type: 'OEM', priority: 'High' }),
      expect.objectContaining({ id: 'CUST-0003', name: 'Fallback Co', tags: [], type: '', priority: '' })
    ]);
    expect(repo.contacts).toEqual([expect.objectContaining({ customerId: 'CUST-0002', name: 'Buyer' })]);
    expect(repo.handlers).toEqual([
      expect.objectContaining({ customerId: 'CUST-0002', email: 'other@automationsystems.org', assignedBy: 'import' }),
      // P1: the L6 admin running the import must not become an account handler, so the
      // handler-less row falls back to the virtual Direct account instead.
      expect.objectContaining({ customerId: 'CUST-0003', email: 'direct', assignedBy: 'import (default)' })
    ]);
    expect(repo.importCustomers).toEqual([]);
    expect(repo.logs).toEqual([expect.objectContaining({ action: 'IMPORT', details: '2 customers imported, 1 skipped' })]);
    expect(repo.lockedNames).toEqual(['existing co', 'new co', 'fallback co']);
  });

  it('imports contacts, skips unmatched and blank contacts, caps runs at 500, clears rows, and logs', async () => {
    const { repo, service } = makeService();
    repo.customers = [customer({ id: 'CUST-0005', name: 'Alpha Panels' })];
    repo.importContacts = Array.from({ length: 501 }, (_, index) => ({
      id: `contact-imp-${index}`,
      rowNo: index + 1,
      customerName: 'Alpha Panels',
      contactName: `Contact ${index}`,
      designation: '',
      phone: '',
      email: '',
      notes: ''
    }));
    await expect(service.runImportContacts(admin)).rejects.toThrow('at most 500');

    repo.importContacts = [
      { id: 'contact-imp-1', rowNo: 1, customerName: 'Alpha Panels', contactName: 'Buyer', designation: 'GM', phone: '123', email: 'buyer@example.com', notes: 'VIP' },
      { id: 'contact-imp-2', rowNo: 2, customerName: 'Missing Co', contactName: 'No Match', designation: '', phone: '', email: '', notes: '' },
      { id: 'contact-imp-3', rowNo: 3, customerName: 'Alpha Panels', contactName: ' ', designation: '', phone: '', email: '', notes: '' }
    ];

    const result = await service.runImportContacts(admin);

    expect(result).toEqual({
      created: 1,
      skipped: ['Missing Co - no matching customer', 'Alpha Panels - blank contact name']
    });
    expect(repo.contacts).toEqual([expect.objectContaining({ id: 'CT-0001', customerId: 'CUST-0005', name: 'Buyer' })]);
    expect(repo.importContacts).toEqual([]);
    expect(repo.logs).toEqual([expect.objectContaining({ action: 'IMPORT_CONTACTS', details: '1 contacts imported, 2 skipped' })]);
  });

  it('returns empty import messages', async () => {
    const { service } = makeService();

    await expect(service.runImport(admin)).resolves.toEqual({
      created: 0,
      skipped: [],
      message: 'The import_customers table has no pending rows.'
    });
    await expect(service.runImportContacts(admin)).resolves.toEqual({
      created: 0,
      skipped: [],
      message: 'The import_contacts table has no pending rows.'
    });
  });
});

describe('admin service recycle bin', () => {
  it('lists, restores, purges recycle customers, and logs activity', async () => {
    const { repo, service } = makeService();
    repo.recycle = [
      {
        ...customer({ id: 'CUST-0099', name: 'Deleted Co', status: 'Archived' }),
        deletedBy: 'manager@automationsystems.org',
        deletedAt: '2026-07-29T12:00:00.000Z'
      }
    ];

    await expect(service.listRecycle(admin)).resolves.toEqual({
      customers: [
        {
          id: 'CUST-0099',
          name: 'Deleted Co',
          tags: ['Punjab'],
          type: 'OEM',
          priority: 'High',
          area: 'Ludhiana',
          deletedBy: 'manager@automationsystems.org',
          deletedOn: '2026-07-29T12:00:00.000Z'
        }
      ]
    });

    await expect(service.restoreCustomer(admin, 'CUST-0099')).resolves.toEqual({ ok: true });
    expect(repo.customers).toEqual([expect.objectContaining({ id: 'CUST-0099', name: 'Deleted Co', status: 'Active' })]);
    expect(repo.recycle).toEqual([]);

    repo.recycle = [
      {
        ...customer({ id: 'CUST-0100', name: 'Purge Co', status: 'Archived' }),
        deletedBy: 'manager@automationsystems.org',
        deletedAt: '2026-07-29T12:00:00.000Z'
      }
    ];
    await expect(service.purgeCustomer(admin, 'CUST-0100')).resolves.toEqual({ ok: true });
    await expect(service.restoreCustomer(admin, 'CUST-0100')).rejects.toThrow('not in the recycle bin');
    expect(repo.logs.map((log) => log.action)).toEqual(['CUSTOMER_RESTORE', 'CUSTOMER_PURGE']);
  });

  it('blocks restore when the live customer ID already exists', async () => {
    const { repo, service } = makeService();
    repo.customers = [customer({ id: 'CUST-0099' })];
    repo.recycle = [
      {
        ...customer({ id: 'CUST-0099', status: 'Archived' }),
        deletedBy: 'manager@automationsystems.org',
        deletedAt: '2026-07-29T12:00:00.000Z'
      }
    ];

    await expect(service.restoreCustomer(admin, 'CUST-0099')).rejects.toThrow('already exists');
  });
});

describe('admin service config items', () => {
  it('adds an item to the stored list', async () => {
    const { repo, service } = makeService();
    repo.settings = [{ key: 'TYPES', value: 'Alpha' }];

    await service.addConfigItem(admin, 'TYPES', 'Beta');

    expect(repo.settings).toContainEqual({ key: 'TYPES', value: 'Alpha | Beta' });
  });

  it('refuses a duplicate, case-insensitively', async () => {
    const { repo, service } = makeService();
    repo.settings = [{ key: 'TYPES', value: 'Alpha' }];

    await expect(service.addConfigItem(admin, 'TYPES', 'alpha')).rejects.toThrow(/already/i);
  });

  it('refuses a value containing a pipe or a comma', async () => {
    const { service } = makeService();

    await expect(service.addConfigItem(admin, 'TYPES', 'A | B')).rejects.toThrow(/cannot contain/i);
    await expect(service.addConfigItem(admin, 'TAGS', 'A, B')).rejects.toThrow(/cannot contain/i);
  });

  it('refuses an empty value and a value of only spaces', async () => {
    const { service } = makeService();

    await expect(service.addConfigItem(admin, 'TYPES', '   ')).rejects.toThrow();
  });

  it('refuses an unknown config key', async () => {
    const { service } = makeService();

    await expect(service.addConfigItem(admin, 'STAGES', 'Nope')).rejects.toThrow(/not configurable/i);
  });

  it('deletes an item from the stored list and touches no record', async () => {
    const { repo, service } = makeService();
    repo.settings = [{ key: 'TAGS', value: 'Punjab | NCR' }];
    repo.customers = [customer({ tags: ['Punjab'] })];
    const before = JSON.stringify(repo.customers);

    await service.deleteConfigItem(admin, 'TAGS', 'Punjab');

    expect(repo.settings).toContainEqual({ key: 'TAGS', value: 'NCR' });
    expect(JSON.stringify(repo.customers)).toBe(before);
  });

  it('refuses to delete the last remaining tag', async () => {
    const { repo, service } = makeService();
    repo.settings = [{ key: 'TAGS', value: 'Punjab' }];

    await expect(service.deleteConfigItem(admin, 'TAGS', 'Punjab')).rejects.toThrow(/at least one/i);
  });

  it('refuses to touch the location backfill placeholder', async () => {
    const { repo, service } = makeService();
    repo.settings = [{ key: 'TAGS', value: 'Punjab | TO BE FILLED' }];

    await expect(service.deleteConfigItem(admin, 'TAGS', 'TO BE FILLED')).rejects.toThrow();
  });

  it('refuses a non-admin', async () => {
    const { service } = makeService();

    await expect(service.addConfigItem(manager, 'TYPES', 'Beta')).rejects.toThrow();
    await expect(service.deleteConfigItem(manager, 'TYPES', 'Beta')).rejects.toThrow();
  });

  it('checks admin access before inspecting the key or value, so a non-admin gets the same access error regardless', async () => {
    const { service } = makeService();

    await expect(service.addConfigItem(manager, 'NOT_A_REAL_KEY', 'Whatever')).rejects.toThrow(
      'Admin access requires L6'
    );
    await expect(service.deleteConfigItem(manager, 'NOT_A_REAL_KEY', 'Whatever')).rejects.toThrow(
      'Admin access requires L6'
    );
  });

  it('logs distinct actions for add and delete', async () => {
    const { repo, service } = makeService();
    repo.settings = [{ key: 'TYPES', value: 'Alpha' }];

    await service.addConfigItem(admin, 'TYPES', 'Beta');
    await service.deleteConfigItem(admin, 'TYPES', 'Beta');

    expect(repo.logs.map((log) => log.action)).toEqual(['CONFIG_ADD', 'CONFIG_DELETE']);
  });
});

describe('admin service config rename', () => {
  /** A stored value in this column's shape, holding the value being renamed plus a neighbour. */
  function seed(target: RenameTarget): string | string[] {
    if (target.kind === 'array') return ['Old', 'Keep'];
    if (target.kind === 'pipe') return 'Old | Keep';
    return 'Old';
  }

  function expected(target: RenameTarget): string | string[] {
    if (target.kind === 'array') return ['New', 'Keep'];
    if (target.kind === 'pipe') return 'New | Keep';
    return 'New';
  }

  const CONFIG_KEYS = ['TAGS', 'TYPES', 'PRIORITIES', 'CATEGORIES', 'SEI_NAMES'] as const;

  it('renames the item in the stored list', async () => {
    const { repo, service } = makeService();
    repo.settings = [{ key: 'TAGS', value: 'Punjab | NCR' }];

    await service.renameConfigItem(admin, 'TAGS', 'Punjab', 'PUN');

    expect(repo.settings).toContainEqual({ key: 'TAGS', value: 'PUN | NCR' });
  });

  // One test per target column. Derived from the map rather than hand-listed, so a
  // column added to RENAME_TARGETS cannot ship without a test proving it is rewritten.
  for (const key of CONFIG_KEYS) {
    for (const target of RENAME_TARGETS[key]) {
      it(`rewrites ${target.table}.${target.column} when a ${key} value is renamed`, async () => {
        const { repo, service } = makeService();
        repo.settings = [{ key, value: 'Old | Keep' }];
        repo.tableRows = { [target.table]: [{ [target.column]: seed(target) }] };

        await service.renameConfigItem(admin, key, 'Old', 'New');

        expect(repo.tableRows[target.table][0][target.column]).toEqual(expected(target));
        expect(repo.renames).toContainEqual({
          table: target.table,
          column: target.column,
          from: 'Old',
          to: 'New'
        });
      });
    }
  }

  it('rewrites every record holding the old location, including user access', async () => {
    const { repo, service } = makeService();
    repo.settings = [{ key: 'TAGS', value: 'Punjab | NCR' }];

    await service.renameConfigItem(admin, 'TAGS', 'Punjab', 'PUN');

    expect(repo.renames).toContainEqual({ table: 'customers', column: 'tags', from: 'Punjab', to: 'PUN' });
    expect(repo.renames).toContainEqual({
      table: 'users',
      column: 'allowed_tags',
      from: 'Punjab',
      to: 'PUN'
    });
    expect(repo.renames).toContainEqual({ table: 'recycle_bin', column: 'tags', from: 'Punjab', to: 'PUN' });
  });

  it('rewrites users.allowed_tags, so nobody silently loses sight of those customers', async () => {
    const { repo, service } = makeService();
    repo.settings = [{ key: 'TAGS', value: 'Punjab | NCR' }];
    repo.tableRows = {
      users: [{ allowed_tags: ['Punjab'] }, { allowed_tags: ['NCR'] }],
      customers: [{ tags: ['Punjab'] }]
    };

    await service.renameConfigItem(admin, 'TAGS', 'Punjab', 'PUN');

    expect(repo.tableRows.users[0].allowed_tags).toEqual(['PUN']);
    expect(repo.tableRows.users[1].allowed_tags).toEqual(['NCR']);
    expect(repo.tableRows.customers[0].tags).toEqual(['PUN']);
  });

  it('leaves the "*" wildcard in allowed_tags untouched', async () => {
    // users_star_tag_check (0001_initial_schema.sql:15) forbids '*' beside any
    // other tag, so a rewrite that grew or altered a wildcard row would both
    // change access and break the constraint.
    const { repo, service } = makeService();
    repo.settings = [{ key: 'TAGS', value: 'Punjab | NCR' }];
    repo.tableRows = { users: [{ allowed_tags: ['*'] }, { allowed_tags: ['Punjab'] }] };

    await service.renameConfigItem(admin, 'TAGS', 'Punjab', 'PUN');

    expect(repo.tableRows.users[0].allowed_tags).toEqual(['*']);
    expect(repo.tableRows.users[1].allowed_tags).toEqual(['PUN']);
  });

  it('refuses to rename the "*" wildcard itself', async () => {
    const { repo, service } = makeService();
    repo.settings = [{ key: 'TAGS', value: 'Punjab | NCR' }];

    await expect(service.renameConfigItem(admin, 'TAGS', '*', 'PUN')).rejects.toThrow(/reserved/i);
    expect(repo.renames).toEqual([]);
  });

  it('refuses to rename the location backfill placeholder', async () => {
    const { repo, service } = makeService();
    repo.settings = [{ key: 'TAGS', value: 'Punjab | TO BE FILLED' }];

    await expect(service.renameConfigItem(admin, 'TAGS', 'TO BE FILLED', 'PUN')).rejects.toThrow(
      /reserved/i
    );
    expect(repo.renames).toEqual([]);
  });

  it('refuses to rename onto the reserved placeholder', async () => {
    const { service } = makeService();

    await expect(service.renameConfigItem(admin, 'TAGS', 'Punjab', 'TO BE FILLED')).rejects.toThrow(
      /reserved/i
    );
  });

  it('rewrites a won-category without corrupting a name it is a prefix of', async () => {
    // The live CATEGORIES list holds both 'Other' and 'Others'. A substring
    // replace would turn 'Others' into 'Miscs'.
    const { repo, service } = makeService();
    repo.settings = [{ key: 'CATEGORIES', value: 'VFDs | Other | Others' }];
    repo.tableRows = { cases: [{ won_categories: 'VFDs | Other | Others' }] };

    await service.renameConfigItem(admin, 'CATEGORIES', 'Other', 'Misc');

    expect(repo.tableRows.cases[0].won_categories).toBe('VFDs | Misc | Others');
    expect(repo.settings).toContainEqual({ key: 'CATEGORIES', value: 'VFDs | Misc | Others' });
  });

  it('preserves the order of a won-category list', async () => {
    const { repo, service } = makeService();
    repo.settings = [{ key: 'CATEGORIES', value: 'Panels | VFDs | PLC | SCADA | Switchgear' }];
    repo.tableRows = { cases: [{ won_categories: 'Panels | VFDs | PLC | SCADA | Switchgear' }] };

    await service.renameConfigItem(admin, 'CATEGORIES', 'PLC', 'PLCs');

    expect(repo.tableRows.cases[0].won_categories).toBe('Panels | VFDs | PLCs | SCADA | Switchgear');
  });

  it('matches a pipe element after trimming, since the stored format has spaces', async () => {
    const { repo, service } = makeService();
    repo.settings = [{ key: 'CATEGORIES', value: 'VFDs | PLC' }];
    repo.tableRows = { cases: [{ won_categories: 'VFDs | PLC' }] };

    await service.renameConfigItem(admin, 'CATEGORIES', 'PLC', 'PLCs');

    expect(repo.tableRows.cases[0].won_categories).toBe('VFDs | PLCs');
  });

  it('refuses to rename to a value that already exists', async () => {
    const { repo, service } = makeService();
    repo.settings = [{ key: 'TAGS', value: 'Punjab | NCR' }];

    await expect(service.renameConfigItem(admin, 'TAGS', 'Punjab', 'NCR')).rejects.toThrow(/already/i);
    await expect(service.renameConfigItem(admin, 'TAGS', 'Punjab', 'ncr')).rejects.toThrow(/already/i);
    expect(repo.renames).toEqual([]);
  });

  it('refuses to rename a value that is not in the list', async () => {
    const { repo, service } = makeService();
    repo.settings = [{ key: 'TAGS', value: 'Punjab' }];

    await expect(service.renameConfigItem(admin, 'TAGS', 'Nowhere', 'PUN')).rejects.toThrow(/not found/i);
    expect(repo.renames).toEqual([]);
  });

  it('is case-sensitive about which value it renames', async () => {
    const { repo, service } = makeService();
    repo.settings = [{ key: 'TAGS', value: 'Punjab | NCR' }];

    await expect(service.renameConfigItem(admin, 'TAGS', 'punjab', 'PUN')).rejects.toThrow(/not found/i);
    expect(repo.renames).toEqual([]);
  });

  it('writes the settings row only after every record has been rewritten', async () => {
    // The other order would let a failed rewrite leave the list advertising a
    // rename that never reached the data.
    const { repo, service } = makeService();
    repo.settings = [{ key: 'TAGS', value: 'Punjab | NCR' }];

    await service.renameConfigItem(admin, 'TAGS', 'Punjab', 'PUN');

    expect(repo.ops).toEqual([
      'rename:customers.tags',
      'rename:users.allowed_tags',
      'rename:recycle_bin.tags',
      'setSetting:TAGS',
      'log:CONFIG_RENAME'
    ]);
  });

  it('rolls back every column when one rewrite fails', async () => {
    const { repo, service } = makeService();
    repo.settings = [{ key: 'TAGS', value: 'Punjab | NCR' }];
    repo.tableRows = {
      customers: [{ tags: ['Punjab'] }],
      users: [{ allowed_tags: ['Punjab'] }],
      recycle_bin: [{ tags: ['Punjab'] }]
    };
    repo.failRenameOn = 'users';

    await expect(service.renameConfigItem(admin, 'TAGS', 'Punjab', 'PUN')).rejects.toThrow();

    expect(repo.settings).toContainEqual({ key: 'TAGS', value: 'Punjab | NCR' });
    expect(repo.committed).toBe(false);
    expect(repo.renames).toEqual([]);
    expect(repo.tableRows.customers[0].tags).toEqual(['Punjab']);
    expect(repo.tableRows.users[0].allowed_tags).toEqual(['Punjab']);
    expect(repo.tableRows.recycle_bin[0].tags).toEqual(['Punjab']);
    expect(repo.logs).toEqual([]);
  });

  it('logs CONFIG_RENAME with the old and new value', async () => {
    const { repo, service } = makeService();
    repo.settings = [{ key: 'TAGS', value: 'Punjab | NCR' }];

    await service.renameConfigItem(admin, 'TAGS', 'Punjab', 'PUN');

    expect(repo.logs).toContainEqual({
      action: 'CONFIG_RENAME',
      entity: 'TAGS',
      customerId: '',
      details: 'Punjab -> PUN',
      who: 'admin@automationsystems.org'
    });
  });

  it('refuses a non-admin', async () => {
    const { repo, service } = makeService();
    repo.settings = [{ key: 'TAGS', value: 'Punjab | NCR' }];

    await expect(service.renameConfigItem(manager, 'TAGS', 'Punjab', 'PUN')).rejects.toThrow();
    expect(repo.renames).toEqual([]);
  });

  it('checks admin access before inspecting the key or either value', async () => {
    const { service } = makeService();

    await expect(service.renameConfigItem(manager, 'NOT_A_REAL_KEY', '', '')).rejects.toThrow(
      'Admin access requires L6'
    );
  });

  it('refuses an unknown config key', async () => {
    const { service } = makeService();

    await expect(service.renameConfigItem(admin, 'STAGES', 'Lead', 'Leads')).rejects.toThrow(
      /not configurable/i
    );
  });

  it('refuses a new value containing a pipe or a comma', async () => {
    const { repo, service } = makeService();
    repo.settings = [{ key: 'TAGS', value: 'Punjab | NCR' }];

    await expect(service.renameConfigItem(admin, 'TAGS', 'Punjab', 'A | B')).rejects.toThrow(
      /cannot contain/i
    );
    await expect(service.renameConfigItem(admin, 'TAGS', 'Punjab', 'A, B')).rejects.toThrow(
      /cannot contain/i
    );
  });

  it('refuses an empty new value', async () => {
    const { repo, service } = makeService();
    repo.settings = [{ key: 'TAGS', value: 'Punjab | NCR' }];

    await expect(service.renameConfigItem(admin, 'TAGS', 'Punjab', '   ')).rejects.toThrow();
  });
});

describe('admin RPC registration', () => {
  it('registers the exact legacy admin RPC names', () => {
    const registry = createRpcRegistry();
    const { service } = makeService();

    registerAdminRpcs(registry, service);

    expect([
      'api_admin_listUsers',
      'api_admin_saveUser',
      'api_admin_saveSettings',
      'api_admin_links',
      'api_admin_runImport',
      'api_admin_runImportContacts',
      'api_admin_listRecycle',
      'api_admin_restoreCustomer',
      'api_admin_purgeCustomer'
    ].every((name) => registry.hasRpc(name))).toBe(true);
  });

  it('registers the rename RPC as a write, so the client cache is busted', async () => {
    const registry = createRpcRegistry();
    const { repo, service } = makeService();
    repo.settings = [{ key: 'TAGS', value: 'Punjab | NCR' }];

    registerAdminRpcs(registry, service);

    expect(registry.hasRpc('api_admin_renameConfigItem')).toBe(true);

    const result = await registry.callRpc(
      'api_admin_renameConfigItem',
      ['TAGS', 'Punjab', 'PUN'],
      new Request('https://crm.test/api'),
      admin
    );

    expect(result.metadata).toEqual({ bustClientCache: true });
    expect(repo.settings).toContainEqual({ key: 'TAGS', value: 'PUN | NCR' });
  });
});
