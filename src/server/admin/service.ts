import type { Sql, TransactionSql } from 'postgres';

import { ensureAdmin } from '../auth/access';
import type { CrmContext } from '../auth/context';
import { sql, withTransaction } from '../db/client';
import { nextCrmId } from '../db/ids';
import { CRM_ID_FORMATS, CRM_ROLES, CRM_TABLES, type CrmRole } from '../db/schema';
import { joinPipe, normalizeEmail, parseList, parsePipe } from '../domain/lists';
import { DEFAULT_SETTINGS, type DefaultSettingKey } from '../settings/defaults';

const IMPORT_CAP = 500;

export type AdminUserRow = {
  email: string;
  name: string;
  role: CrmRole;
  allowedTags: string[];
  active: boolean;
  addedOn: string;
  addedBy: string;
};

export type AdminCustomerRow = {
  id: string;
  name: string;
  tags: string[];
  type: string;
  priority: string;
  area: string;
  address: string;
  gstin: string;
  website: string;
  notes: string;
  sei: string;
  remarks: string;
  status: 'Active' | 'Archived';
  createdBy: string;
  createdAt: string;
  updatedAt: string;
};

export type AdminContactRow = {
  id: string;
  customerId: string;
  name: string;
  designation: string;
  phone: string;
  email: string;
  notes: string;
  createdBy?: string;
  createdAt?: string;
  updatedAt?: string;
};

export type AdminHandlerRow = {
  customerId: string;
  email: string;
  assignedBy: string;
  assignedAt: string;
};

export type AdminSettingRow = {
  key: DefaultSettingKey;
  value: string;
};

export type AdminImportCustomerRow = {
  id: string;
  rowNo: number;
  name: string;
  tag: string;
  type: string;
  priority: string;
  area: string;
  address: string;
  gstin: string;
  contactName: string;
  contactDesignation: string;
  contactPhone: string;
  contactEmail: string;
  handlers: string;
};

export type AdminImportContactRow = {
  id: string;
  rowNo: number;
  customerName: string;
  contactName: string;
  designation: string;
  phone: string;
  email: string;
  notes: string;
};

export type AdminRecycleCustomerRow = AdminCustomerRow & {
  deletedBy: string;
  deletedAt: string;
};

export type AdminActivityLogEntry = {
  action: string;
  entity: string;
  customerId: string;
  details: string;
  who: string;
};

export type AdminRepository = {
  withTransaction<T>(fn: (repo?: AdminRepository) => Promise<T>): Promise<T>;
  listUsers(): Promise<AdminUserRow[]>;
  getUser(email: string): Promise<AdminUserRow | null>;
  createUser(user: AdminUserRow): Promise<void>;
  updateUser(email: string, fields: Partial<AdminUserRow>): Promise<void>;
  listSettings(): Promise<AdminSettingRow[]>;
  setSetting(key: AdminSettingRow['key'], value: string): Promise<void>;
  nextCustomerId(): Promise<string>;
  nextContactId(): Promise<string>;
  listCustomers(): Promise<AdminCustomerRow[]>;
  getCustomer(id: string): Promise<AdminCustomerRow | null>;
  createCustomer(customer: AdminCustomerRow): Promise<void>;
  listContactsByCustomer(customerId: string): Promise<AdminContactRow[]>;
  createContact(contact: AdminContactRow): Promise<void>;
  listHandlers(): Promise<AdminHandlerRow[]>;
  addHandler(handler: AdminHandlerRow): Promise<void>;
  listImportCustomers(): Promise<AdminImportCustomerRow[]>;
  deleteImportCustomers(ids: string[]): Promise<void>;
  listImportContacts(): Promise<AdminImportContactRow[]>;
  deleteImportContacts(ids: string[]): Promise<void>;
  listRecycleCustomers(): Promise<AdminRecycleCustomerRow[]>;
  getRecycleCustomer(id: string): Promise<AdminRecycleCustomerRow | null>;
  deleteRecycleCustomer(id: string): Promise<void>;
  logActivity(entry: AdminActivityLogEntry): Promise<void>;
};

export type SaveUserInput = Partial<{
  email: unknown;
  name: unknown;
  role: unknown;
  allowedTags: unknown;
  active: unknown;
}>;

export type SaveSettingsInput = Partial<{
  tags: unknown;
  types: unknown;
  priorities: unknown;
  categories: unknown;
  sources: unknown;
  taxPct: unknown;
  currency: unknown;
  company: unknown;
}>;

type ResolvedSettings = {
  tags: string[];
  types: string[];
  priorities: string[];
};

type DbExecutor = Sql | TransactionSql;

type UserDbRow = {
  email: string;
  name: string;
  role: CrmRole;
  allowed_tags: string[] | null;
  active: boolean;
  added_at: string | Date;
  added_by: string | null;
};

type SettingDbRow = {
  key: string;
  value: string;
};

type CustomerDbRow = {
  customer_id: string;
  name: string;
  tags: string[] | null;
  type: string | null;
  priority: string | null;
  area: string | null;
  address: string | null;
  gstin: string | null;
  website: string | null;
  notes: string | null;
  sei: string | null;
  remarks: string | null;
  status: 'Active' | 'Archived';
  created_by: string | null;
  created_at: string | Date | null;
  updated_at: string | Date | null;
};

type ContactDbRow = {
  contact_id: string;
  customer_id: string;
  name: string;
  designation: string | null;
  phone: string | null;
  email: string | null;
  notes: string | null;
  created_by: string | null;
  created_at: string | Date | null;
  updated_at: string | Date | null;
};

type HandlerDbRow = {
  customer_id: string;
  user_email: string;
  assigned_by: string | null;
  assigned_at: string | Date;
};

type ImportCustomerDbRow = {
  id: string;
  row_no: number;
  name: string | null;
  tag: string | null;
  type: string | null;
  priority: string | null;
  area: string | null;
  address: string | null;
  gstin: string | null;
  contact_name: string | null;
  contact_designation: string | null;
  contact_phone: string | null;
  contact_email: string | null;
  handlers: string | null;
};

type ImportContactDbRow = {
  id: string;
  row_no: number;
  customer_name: string | null;
  contact_name: string | null;
  designation: string | null;
  phone: string | null;
  email: string | null;
  notes: string | null;
};

type RecycleDbRow = CustomerDbRow & {
  deleted_by: string | null;
  deleted_at: string | Date;
};

function nowIso(): string {
  return new Date().toISOString();
}

function asText(value: unknown): string {
  return String(value ?? '').trim();
}

function lower(value: unknown): string {
  return asText(value).toLowerCase();
}

function dateString(value: string | Date | null | undefined): string {
  if (!value) return '';
  return value instanceof Date ? value.toISOString() : String(value);
}

function normalizeImportList(value: unknown): string[] {
  const list = Array.isArray(value) ? value.map(String) : parseList(String(value ?? ''));
  return Array.from(new Set(list.map((item) => item.trim()).filter(Boolean)));
}

function normalizeAllowedTags(value: unknown): string[] {
  const tags = normalizeImportList(value);
  return tags.includes('*') ? ['*'] : tags;
}

function normalizeRole(value: unknown): CrmRole {
  const role = asText(value);
  return (CRM_ROLES as readonly string[]).includes(role) ? (role as CrmRole) : 'L2';
}

function assertEmail(email: string): void {
  if (!email || !email.includes('@')) {
    throw new Error('Enter a valid email address.');
  }
}

function validOne(value: unknown, allowed: readonly string[]): string {
  const text = asText(value);
  return allowed.includes(text) ? text : '';
}

function validTags(value: unknown, allowed: readonly string[]): string[] {
  return parseList(Array.isArray(value) ? value.map(String) : String(value ?? '')).filter((tag) =>
    allowed.includes(tag)
  );
}

function cleanList(value: unknown): string[] {
  return (Array.isArray(value) ? value : [])
    .map((item) => String(item ?? '').trim())
    .filter(Boolean);
}

function localName(email: string): string {
  return email.split('@')[0] || email;
}

function customerKey(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, ' ');
}

function settingsFromRows(rows: readonly AdminSettingRow[]): ResolvedSettings {
  const byKey = new Map(rows.map((row) => [row.key, row.value]));
  return {
    tags: parsePipe(byKey.get('TAGS') ?? DEFAULT_SETTINGS.TAGS.join(' | ')),
    types: parsePipe(byKey.get('TYPES') ?? DEFAULT_SETTINGS.TYPES.join(' | ')),
    priorities: parsePipe(byKey.get('PRIORITIES') ?? DEFAULT_SETTINGS.PRIORITIES.join(' | '))
  };
}

function sortUsers(users: readonly AdminUserRow[]): AdminUserRow[] {
  return [...users]
    .map((user) => ({
      ...user,
      email: normalizeEmail(user.email),
      allowedTags: normalizeAllowedTags(user.allowedTags)
    }))
    .sort((a, b) => a.email.localeCompare(b.email));
}

function toUser(row: UserDbRow): AdminUserRow {
  return {
    email: normalizeEmail(row.email),
    name: row.name,
    role: row.role,
    allowedTags: row.allowed_tags ?? [],
    active: row.active,
    addedOn: dateString(row.added_at),
    addedBy: normalizeEmail(row.added_by)
  };
}

function toCustomer(row: CustomerDbRow): AdminCustomerRow {
  return {
    id: row.customer_id,
    name: row.name,
    tags: row.tags ?? [],
    type: row.type ?? '',
    priority: row.priority ?? '',
    area: row.area ?? '',
    address: row.address ?? '',
    gstin: row.gstin ?? '',
    website: row.website ?? '',
    notes: row.notes ?? '',
    sei: row.sei ?? '',
    remarks: row.remarks ?? '',
    status: row.status,
    createdBy: normalizeEmail(row.created_by),
    createdAt: dateString(row.created_at),
    updatedAt: dateString(row.updated_at)
  };
}

function toContact(row: ContactDbRow): AdminContactRow {
  return {
    id: row.contact_id,
    customerId: row.customer_id,
    name: row.name,
    designation: row.designation ?? '',
    phone: row.phone ?? '',
    email: row.email ?? '',
    notes: row.notes ?? '',
    createdBy: normalizeEmail(row.created_by),
    createdAt: dateString(row.created_at),
    updatedAt: dateString(row.updated_at)
  };
}

function toHandler(row: HandlerDbRow): AdminHandlerRow {
  return {
    customerId: row.customer_id,
    email: normalizeEmail(row.user_email),
    assignedBy: row.assigned_by ?? '',
    assignedAt: dateString(row.assigned_at)
  };
}

function toImportCustomer(row: ImportCustomerDbRow): AdminImportCustomerRow {
  return {
    id: row.id,
    rowNo: row.row_no,
    name: row.name ?? '',
    tag: row.tag ?? '',
    type: row.type ?? '',
    priority: row.priority ?? '',
    area: row.area ?? '',
    address: row.address ?? '',
    gstin: row.gstin ?? '',
    contactName: row.contact_name ?? '',
    contactDesignation: row.contact_designation ?? '',
    contactPhone: row.contact_phone ?? '',
    contactEmail: row.contact_email ?? '',
    handlers: row.handlers ?? ''
  };
}

function toImportContact(row: ImportContactDbRow): AdminImportContactRow {
  return {
    id: row.id,
    rowNo: row.row_no,
    customerName: row.customer_name ?? '',
    contactName: row.contact_name ?? '',
    designation: row.designation ?? '',
    phone: row.phone ?? '',
    email: row.email ?? '',
    notes: row.notes ?? ''
  };
}

function toRecycleCustomer(row: RecycleDbRow): AdminRecycleCustomerRow {
  return {
    ...toCustomer(row),
    deletedBy: normalizeEmail(row.deleted_by),
    deletedAt: dateString(row.deleted_at)
  };
}

export function createAdminService(repo: AdminRepository) {
  return {
    async listUsers(user: CrmContext) {
      ensureAdmin(user);
      return sortUsers(await repo.listUsers()).map((row) => ({
        email: row.email,
        name: row.name,
        role: row.role,
        allowedTags: row.allowedTags,
        active: row.active,
        addedOn: row.addedOn
      }));
    },

    async saveUser(user: CrmContext, input: SaveUserInput) {
      ensureAdmin(user);
      const email = normalizeEmail(asText(input?.email));
      assertEmail(email);

      const existing = await repo.getUser(email);
      const role = normalizeRole(input?.role);
      const active = input?.active !== false;
      const name = asText(input?.name) || existing?.name || localName(email);
      const allowedTags = normalizeAllowedTags(input?.allowedTags ?? []);
      const actor = normalizeEmail(user.email);

      if (email === actor && !active) throw new Error('You cannot deactivate your own account.');
      if (email === actor && role !== 'L6') throw new Error('You cannot lower your own level below L6.');

      await repo.withTransaction(async (tx) => {
        const trx = tx ?? repo;
        if (existing) {
          await trx.updateUser(email, { name, role, allowedTags, active });
          await trx.logActivity({
            action: 'USER_EDIT',
            entity: email,
            customerId: '',
            details: `${role}${active ? '' : ' (deactivated)'}`,
            who: actor
          });
        } else {
          await trx.createUser({
            email,
            name,
            role,
            allowedTags,
            active,
            addedOn: nowIso(),
            addedBy: actor
          });
          await trx.logActivity({
            action: 'USER_ADD',
            entity: email,
            customerId: '',
            details: role,
            who: actor
          });
        }
        return undefined;
      });

      return { ok: true };
    },

    async saveSettings(user: CrmContext, input: SaveSettingsInput) {
      ensureAdmin(user);
      const writes: AdminSettingRow[] = [];

      if (input.tags !== undefined) {
        const tags = cleanList(input.tags);
        if (!tags.length) throw new Error('Keep at least one tag.');
        writes.push({ key: 'TAGS', value: joinPipe(tags) });
      }
      if (input.types !== undefined) writes.push({ key: 'TYPES', value: joinPipe(cleanList(input.types)) });
      if (input.priorities !== undefined) {
        writes.push({ key: 'PRIORITIES', value: joinPipe(cleanList(input.priorities)) });
      }
      if (input.categories !== undefined) {
        writes.push({ key: 'CATEGORIES', value: joinPipe(cleanList(input.categories)) });
      }
      if (input.sources !== undefined) writes.push({ key: 'SOURCES', value: joinPipe(cleanList(input.sources)) });
      if (input.taxPct !== undefined) {
        const taxPct = Number(input.taxPct) || 0;
        writes.push({ key: 'TAX_PCT', value: String(taxPct) });
      }
      if (input.currency !== undefined) writes.push({ key: 'CURRENCY', value: asText(input.currency) || 'INR' });
      if (input.company !== undefined) writes.push({ key: 'COMPANY', value: asText(input.company) });

      await repo.withTransaction(async (tx) => {
        const trx = tx ?? repo;
        for (const setting of writes) {
          await trx.setSetting(setting.key, setting.value);
        }
        await trx.logActivity({
          action: 'SETTINGS',
          entity: '',
          customerId: '',
          details: 'Settings updated',
          who: normalizeEmail(user.email)
        });
        return undefined;
      });

      return { ok: true };
    },

    async links(user: CrmContext) {
      ensureAdmin(user);
      const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || '';

      return {
        app: 'AS CRM',
        database: 'Supabase Postgres',
        admin: 'Supabase dashboard',
        supabaseUrl,
        tables: [
          'users',
          'customers',
          'contacts',
          'handlers',
          'cases',
          'quotations',
          'recycle_bin',
          'settings',
          'import_customers',
          'import_contacts'
        ]
      };
    },

    async runImport(user: CrmContext) {
      ensureAdmin(user);
      const rows = await repo.listImportCustomers();
      if (!rows.length) {
        return { created: 0, skipped: [], message: 'The import_customers table has no pending rows.' };
      }
      if (rows.length > IMPORT_CAP) throw new Error('Please import at most 500 customers at a time.');

      return repo.withTransaction(async (tx) => {
        const trx = tx ?? repo;
        const [customers, users, settings] = await Promise.all([
          trx.listCustomers(),
          trx.listUsers(),
          trx.listSettings()
        ]);
        const allowed = settingsFromRows(settings);
        const existingNames = new Map(customers.map((customer) => [customerKey(customer.name), customer.id]));
        const activeUsers = new Set(
          users.filter((row) => row.active).map((row) => normalizeEmail(row.email))
        );

        let created = 0;
        const skipped: string[] = [];
        const now = nowIso();
        const actor = normalizeEmail(user.email);

        for (const row of rows) {
          const name = asText(row.name);
          if (!name) continue;

          const key = customerKey(name);
          const existingId = existingNames.get(key);
          if (existingId) {
            skipped.push(`${name} (exists as ${existingId})`);
            continue;
          }

          const customerId = await trx.nextCustomerId();
          await trx.createCustomer({
            id: customerId,
            name,
            tags: validTags(row.tag, allowed.tags),
            type: validOne(row.type, allowed.types),
            priority: validOne(row.priority, allowed.priorities),
            area: asText(row.area),
            address: asText(row.address),
            gstin: asText(row.gstin),
            website: '',
            notes: '',
            sei: '',
            remarks: '',
            status: 'Active',
            createdBy: actor,
            createdAt: now,
            updatedAt: now
          });
          existingNames.set(key, customerId);

          if (asText(row.contactName)) {
            const contactId = await trx.nextContactId();
            await trx.createContact({
              id: contactId,
              customerId,
              name: asText(row.contactName),
              designation: asText(row.contactDesignation),
              phone: String(row.contactPhone ?? ''),
              email: asText(row.contactEmail),
              notes: '',
              createdBy: actor,
              createdAt: now,
              updatedAt: now
            });
          }

          const handlerEmails = parseList(row.handlers).map(normalizeEmail).filter((email) => activeUsers.has(email));
          const assignedHandlers = handlerEmails.length ? handlerEmails : [actor];
          for (const handlerEmail of assignedHandlers) {
            await trx.addHandler({
              customerId,
              email: handlerEmail,
              assignedBy: handlerEmails.length ? 'import' : 'import (default)',
              assignedAt: now
            });
          }
          created++;
        }

        await trx.deleteImportCustomers(rows.map((row) => row.id));
        await trx.logActivity({
          action: 'IMPORT',
          entity: '',
          customerId: '',
          details: `${created} customers imported, ${skipped.length} skipped`,
          who: actor
        });

        return { created, skipped };
      });
    },

    async runImportContacts(user: CrmContext) {
      ensureAdmin(user);
      const rows = await repo.listImportContacts();
      if (!rows.length) {
        return { created: 0, skipped: [], message: 'The import_contacts table has no pending rows.' };
      }
      if (rows.length > IMPORT_CAP) throw new Error('Please import at most 500 contacts at a time.');

      return repo.withTransaction(async (tx) => {
        const trx = tx ?? repo;
        const customers = await trx.listCustomers();
        const byName = new Map(customers.map((customer) => [customerKey(customer.name), customer.id]));
        let created = 0;
        const skipped: string[] = [];
        const now = nowIso();
        const actor = normalizeEmail(user.email);

        for (const row of rows) {
          const customerName = asText(row.customerName);
          const contactName = asText(row.contactName);
          if (!customerName && !contactName) continue;

          const customerId = byName.get(customerKey(customerName));
          if (!customerId) {
            skipped.push(`${customerName || '(blank)'} - no matching customer`);
            continue;
          }
          if (!contactName) {
            skipped.push(`${customerName} - blank contact name`);
            continue;
          }

          const contactId = await trx.nextContactId();
          await trx.createContact({
            id: contactId,
            customerId,
            name: contactName,
            designation: asText(row.designation),
            phone: String(row.phone ?? ''),
            email: asText(row.email),
            notes: asText(row.notes),
            createdBy: actor,
            createdAt: now,
            updatedAt: now
          });
          created++;
        }

        await trx.deleteImportContacts(rows.map((row) => row.id));
        await trx.logActivity({
          action: 'IMPORT_CONTACTS',
          entity: '',
          customerId: '',
          details: `${created} contacts imported, ${skipped.length} skipped`,
          who: actor
        });

        return { created, skipped };
      });
    },

    async listRecycle(user: CrmContext) {
      ensureAdmin(user);
      const customers = await repo.listRecycleCustomers();
      return {
        customers: customers.map((customer) => ({
          id: customer.id,
          name: customer.name,
          tags: customer.tags,
          type: customer.type,
          priority: customer.priority,
          area: customer.area,
          deletedBy: customer.deletedBy,
          deletedOn: customer.deletedAt
        }))
      };
    },

    async restoreCustomer(user: CrmContext, id: string) {
      ensureAdmin(user);
      return repo.withTransaction(async (tx) => {
        const trx = tx ?? repo;
        const rec = await trx.getRecycleCustomer(id);
        if (!rec) throw new Error('That customer is not in the recycle bin.');
        if (await trx.getCustomer(id)) throw new Error('A customer with this ID already exists.');

        await trx.createCustomer({
          ...rec,
          status: 'Active',
          updatedAt: nowIso()
        });
        await trx.deleteRecycleCustomer(id);
        await trx.logActivity({
          action: 'CUSTOMER_RESTORE',
          entity: id,
          customerId: id,
          details: rec.name,
          who: normalizeEmail(user.email)
        });

        return { ok: true };
      });
    },

    async purgeCustomer(user: CrmContext, id: string) {
      ensureAdmin(user);
      return repo.withTransaction(async (tx) => {
        const trx = tx ?? repo;
        const rec = await trx.getRecycleCustomer(id);
        if (!rec) throw new Error('That customer is not in the recycle bin.');

        await trx.deleteRecycleCustomer(id);
        await trx.logActivity({
          action: 'CUSTOMER_PURGE',
          entity: id,
          customerId: id,
          details: '',
          who: normalizeEmail(user.email)
        });

        return { ok: true };
      });
    }
  };
}

export type AdminService = ReturnType<typeof createAdminService>;

export class PostgresAdminRepository implements AdminRepository {
  constructor(private readonly db: DbExecutor = sql) {}

  async withTransaction<T>(fn: (repo?: AdminRepository) => Promise<T>): Promise<T> {
    return withTransaction((tx) => fn(new PostgresAdminRepository(tx)));
  }

  async listUsers(): Promise<AdminUserRow[]> {
    const rows = (await this.db`
      select email, name, role, allowed_tags, active, added_at, added_by
      from public.users
    `) as UserDbRow[];
    return rows.map(toUser);
  }

  async getUser(email: string): Promise<AdminUserRow | null> {
    const rows = (await this.db`
      select email, name, role, allowed_tags, active, added_at, added_by
      from public.users
      where email = ${normalizeEmail(email)}
      limit 1
    `) as UserDbRow[];
    return rows[0] ? toUser(rows[0]) : null;
  }

  async createUser(user: AdminUserRow): Promise<void> {
    await this.db`
      insert into public.users (email, name, role, allowed_tags, active, added_at, added_by)
      values (
        ${user.email}, ${user.name}, ${user.role}, ${user.allowedTags}, ${user.active},
        ${user.addedOn}, ${user.addedBy || null}
      )
    `;
  }

  async updateUser(email: string, fields: Partial<AdminUserRow>): Promise<void> {
    await this.db`
      update public.users
      set
        name = coalesce(${fields.name ?? null}, name),
        role = coalesce(${fields.role ?? null}, role),
        allowed_tags = coalesce(${fields.allowedTags ?? null}, allowed_tags),
        active = coalesce(${fields.active ?? null}, active),
        updated_at = now()
      where email = ${normalizeEmail(email)}
    `;
  }

  async listSettings(): Promise<AdminSettingRow[]> {
    const rows = (await this.db`
      select key, value
      from public.settings
    `) as SettingDbRow[];
    return rows
      .filter((row): row is AdminSettingRow => (DEFAULT_SETTINGS as Record<string, unknown>)[row.key] !== undefined)
      .map((row) => ({ key: row.key, value: row.value }));
  }

  async setSetting(key: AdminSettingRow['key'], value: string): Promise<void> {
    await this.db`
      insert into public.settings (key, value)
      values (${key}, ${value})
      on conflict (key) do update set value = excluded.value
    `;
  }

  async nextCustomerId(): Promise<string> {
    const format = CRM_ID_FORMATS.customers;
    return nextCrmId(this.db, format.key, format.prefix, format.width);
  }

  async nextContactId(): Promise<string> {
    const format = CRM_ID_FORMATS.contacts;
    return nextCrmId(this.db, format.key, format.prefix, format.width);
  }

  async listCustomers(): Promise<AdminCustomerRow[]> {
    const rows = (await this.db`
      select customer_id, name, tags, type, priority, area, address, gstin, website, notes,
             sei, remarks, status, created_by, created_at, updated_at
      from public.customers
    `) as CustomerDbRow[];
    return rows.map(toCustomer);
  }

  async getCustomer(id: string): Promise<AdminCustomerRow | null> {
    const rows = (await this.db`
      select customer_id, name, tags, type, priority, area, address, gstin, website, notes,
             sei, remarks, status, created_by, created_at, updated_at
      from public.customers
      where customer_id = ${id}
      limit 1
    `) as CustomerDbRow[];
    return rows[0] ? toCustomer(rows[0]) : null;
  }

  async createCustomer(customer: AdminCustomerRow): Promise<void> {
    await this.db`
      insert into public.customers (
        customer_id, name, tags, type, priority, area, address, gstin, website, notes,
        sei, remarks, status, created_by, created_at, updated_at
      )
      values (
        ${customer.id}, ${customer.name}, ${customer.tags}, ${customer.type}, ${customer.priority},
        ${customer.area}, ${customer.address}, ${customer.gstin}, ${customer.website}, ${customer.notes},
        ${customer.sei}, ${customer.remarks}, ${customer.status}, ${customer.createdBy || null},
        ${customer.createdAt || null}, ${customer.updatedAt || null}
      )
    `;
  }

  async listContactsByCustomer(customerId: string): Promise<AdminContactRow[]> {
    const rows = (await this.db`
      select contact_id, customer_id, name, designation, phone, email, notes, created_by, created_at, updated_at
      from public.contacts
      where customer_id = ${customerId}
    `) as ContactDbRow[];
    return rows.map(toContact);
  }

  async createContact(contact: AdminContactRow): Promise<void> {
    await this.db`
      insert into public.contacts (
        contact_id, customer_id, name, designation, phone, email, notes, created_by, created_at, updated_at
      )
      values (
        ${contact.id}, ${contact.customerId}, ${contact.name}, ${contact.designation}, ${contact.phone},
        ${contact.email}, ${contact.notes}, ${contact.createdBy ?? null}, ${contact.createdAt ?? null},
        ${contact.updatedAt ?? null}
      )
    `;
  }

  async listHandlers(): Promise<AdminHandlerRow[]> {
    const rows = (await this.db`
      select customer_id, user_email, assigned_by, assigned_at
      from public.handlers
    `) as HandlerDbRow[];
    return rows.map(toHandler);
  }

  async addHandler(handler: AdminHandlerRow): Promise<void> {
    await this.db`
      insert into public.handlers (customer_id, user_email, assigned_by, assigned_at)
      values (${handler.customerId}, ${handler.email}, ${handler.assignedBy}, ${handler.assignedAt})
      on conflict (customer_id, user_email) do nothing
    `;
  }

  async listImportCustomers(): Promise<AdminImportCustomerRow[]> {
    const rows = (await this.db`
      select id::text as id, row_no, name, tag, type, priority, area, address, gstin,
             contact_name, contact_designation, contact_phone, contact_email, handlers
      from public.import_customers
      where status = 'Pending'
      order by row_no asc
    `) as ImportCustomerDbRow[];
    return rows.map(toImportCustomer);
  }

  async deleteImportCustomers(ids: string[]): Promise<void> {
    for (const id of ids) {
      await this.db`delete from public.import_customers where id = ${id}::uuid`;
    }
  }

  async listImportContacts(): Promise<AdminImportContactRow[]> {
    const rows = (await this.db`
      select id::text as id, row_no, customer_name, contact_name, designation, phone, email, notes
      from public.import_contacts
      where status = 'Pending'
      order by row_no asc
    `) as ImportContactDbRow[];
    return rows.map(toImportContact);
  }

  async deleteImportContacts(ids: string[]): Promise<void> {
    for (const id of ids) {
      await this.db`delete from public.import_contacts where id = ${id}::uuid`;
    }
  }

  async listRecycleCustomers(): Promise<AdminRecycleCustomerRow[]> {
    const rows = (await this.db`
      select customer_id, name, tags, type, priority, area, address, gstin, website, notes,
             sei, remarks, status, created_by, created_at, updated_at, deleted_by, deleted_at
      from public.recycle_bin
      order by deleted_at desc
    `) as RecycleDbRow[];
    return rows.map(toRecycleCustomer);
  }

  async getRecycleCustomer(id: string): Promise<AdminRecycleCustomerRow | null> {
    const rows = (await this.db`
      select customer_id, name, tags, type, priority, area, address, gstin, website, notes,
             sei, remarks, status, created_by, created_at, updated_at, deleted_by, deleted_at
      from public.recycle_bin
      where customer_id = ${id}
      limit 1
    `) as RecycleDbRow[];
    return rows[0] ? toRecycleCustomer(rows[0]) : null;
  }

  async deleteRecycleCustomer(id: string): Promise<void> {
    await this.db`delete from public.recycle_bin where customer_id = ${id}`;
  }

  async logActivity(entry: AdminActivityLogEntry): Promise<void> {
    await this.db`
      insert into public.activity_log (who, action, entity, customer_id, details)
      values (${entry.who}, ${entry.action}, ${entry.entity}, ${entry.customerId || null}, ${entry.details})
    `;
  }
}

export const adminRepository = new PostgresAdminRepository();

export const ADMIN_METADATA_TABLES = CRM_TABLES.filter((table) =>
  [
    'users',
    'customers',
    'contacts',
    'handlers',
    'cases',
    'quotations',
    'recycle_bin',
    'settings',
    'import_customers',
    'import_contacts'
  ].includes(table)
);
