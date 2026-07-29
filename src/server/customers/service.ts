import type { CrmContext } from '../auth/context';
import { accessLevel, ensureFull } from '../auth/access';
import type { CrmRole } from '../db/schema';
import { DEFAULT_SETTINGS } from '../settings/defaults';
import { normalizeEmail, parseList } from '../domain/lists';

export type CustomerRow = {
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
  deletedBy?: string;
  deletedAt?: string;
};

export type ContactRow = {
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

export type HandlerRow = {
  customerId: string;
  email: string;
  assignedBy: string;
  assignedAt: string;
};

export type CustomerUserRow = {
  email: string;
  name: string;
  role: CrmRole;
  allowedTags: string[];
  active: boolean;
};

export type ActivityLogEntry = {
  action: string;
  entity: string;
  customerId: string;
  details: string;
  who: string;
};

export type CustomerCaseSummary = {
  id: string;
  customerId: string;
  title: string;
  stage: string;
  outcome: string;
  orderValue: number | '';
  quotedValue: number | '';
  owners: string[];
  assignee: string;
  updatedAt: string;
};

export type CustomerQuoteSummary = {
  quoteNo: string;
  rev: number;
  caseId: string;
  customerId: string;
  title: string;
  source: 'Generated' | 'External';
  status: 'Draft' | 'Sent' | 'Superseded';
  total: number | '';
  currency: string;
  fileName: string;
  doc: string;
  pdf: string;
  createdAt: string;
};

export type CustomerRepository = {
  withTransaction<T>(fn: (repo?: CustomerRepository) => Promise<T>): Promise<T>;
  lockCustomerName(name: string): Promise<void>;
  nextCustomerId(): Promise<string>;
  nextContactId(): Promise<string>;
  listCustomers(): Promise<CustomerRow[]>;
  getCustomer(id: string): Promise<CustomerRow | null>;
  findCustomerByName(name: string): Promise<CustomerRow | null>;
  createCustomer(customer: CustomerRow): Promise<void>;
  updateCustomer(id: string, fields: Partial<CustomerRow>): Promise<void>;
  deleteCustomer(id: string): Promise<void>;
  moveCustomerToRecycleBin(customer: CustomerRow, deletedBy: string): Promise<void>;
  listContactsByCustomer(customerId: string): Promise<ContactRow[]>;
  listCasesByCustomer(customerId: string): Promise<CustomerCaseSummary[]>;
  listQuotesByCustomer(customerId: string): Promise<CustomerQuoteSummary[]>;
  countContactsByCustomer(): Promise<Record<string, number>>;
  getContact(contactId: string): Promise<ContactRow | null>;
  createContact(contact: ContactRow): Promise<void>;
  updateContact(contactId: string, fields: Partial<ContactRow>): Promise<void>;
  deleteContact(contactId: string): Promise<void>;
  listHandlers(): Promise<HandlerRow[]>;
  addHandler(handler: HandlerRow): Promise<void>;
  removeHandler(customerId: string, email: string): Promise<void>;
  removeDirectHandlers(customerId: string): Promise<void>;
  listUsers(): Promise<CustomerUserRow[]>;
  hasCases(customerId: string): Promise<boolean>;
  hasQuotations(customerId: string): Promise<boolean>;
  logActivity(entry: ActivityLogEntry): Promise<void>;
};

export type CustomerInput = Partial<{
  name: unknown;
  tags: unknown;
  tag: unknown;
  type: unknown;
  priority: unknown;
  area: unknown;
  address: unknown;
  gstin: unknown;
  website: unknown;
  notes: unknown;
  sei: unknown;
  remarks: unknown;
  status: unknown;
  force: unknown;
  contact: ContactInput;
}>;

export type ContactInput = Partial<{
  name: unknown;
  designation: unknown;
  phone: unknown;
  email: unknown;
  notes: unknown;
}>;

export type BulkCustomerInput = Partial<{
  name: unknown;
  tag: unknown;
  tags: unknown;
  type: unknown;
  priority: unknown;
  area: unknown;
  address: unknown;
  gstin: unknown;
}>;

export type CustomerCellPatch = {
  id: string;
  fields: CustomerInput;
};

export type SearchCustomerResult = {
  id: string;
  name: string;
  tags: string[];
  type: string;
  priority: string;
  handlers: string[];
  access: 'FULL' | 'NAME';
  area?: string;
};

type Ownership = {
  handlersByCustomerId: Record<string, string[]>;
};

function nowIso(): string {
  return new Date().toISOString();
}

function roleLevel(user: Pick<CrmContext, 'role'>): number {
  return Number(user.role.slice(1));
}

function requireLevel(user: CrmContext, minimum: number): void {
  const level = roleLevel(user);
  if (level < minimum) {
    throw new Error(`Your access level (L${level}) does not allow this. It needs L${minimum} or higher.`);
  }
}

function asText(value: unknown): string {
  return String(value ?? '').trim();
}

function lower(value: unknown): string {
  return asText(value).toLowerCase();
}

function validOne(value: unknown, allowed: readonly string[]): string {
  const text = asText(value);
  return allowed.includes(text) ? text : '';
}

function validTags(value: unknown): string[] {
  return parseList(Array.isArray(value) ? value.map(String) : String(value ?? '')).filter((tag) =>
    (DEFAULT_SETTINGS.TAGS as readonly string[]).includes(tag)
  );
}

function activeRows(customers: readonly CustomerRow[]): CustomerRow[] {
  return customers.filter((customer) => customer.status !== 'Archived');
}

function customerForAccess(customer: CustomerRow) {
  return {
    id: customer.id,
    name: customer.name,
    tags: customer.tags,
    type: customer.type
  };
}

function ownershipFor(handlers: readonly HandlerRow[]): Ownership {
  return {
    handlersByCustomerId: handlers.reduce<Record<string, string[]>>((map, handler) => {
      const email = normalizeEmail(handler.email);
      (map[handler.customerId] = map[handler.customerId] ?? []).push(email);
      return map;
    }, {})
  };
}

function accessOwnership(ownership: Ownership) {
  return {
    handlerEmailsByCustomerId: ownership.handlersByCustomerId
  };
}

function userIndex(users: readonly CustomerUserRow[]): Record<string, CustomerUserRow> {
  return users.reduce<Record<string, CustomerUserRow>>((index, user) => {
    index[normalizeEmail(user.email)] = { ...user, email: normalizeEmail(user.email) };
    return index;
  }, {});
}

function nameOf(users: Record<string, CustomerUserRow>, email: string): string {
  const normalized = normalizeEmail(email);
  if (normalized === 'direct') return 'Direct';
  return users[normalized]?.name || email;
}

function handlerSummaries(
  customerId: string,
  ownership: Ownership,
  users: Record<string, CustomerUserRow>
): Array<{ email: string; name: string }> {
  return (ownership.handlersByCustomerId[customerId] ?? []).map((email) => ({
    email,
    name: nameOf(users, email)
  }));
}

function gridRow(
  customer: CustomerRow,
  contactCounts: Record<string, number>,
  ownership: Ownership,
  users: Record<string, CustomerUserRow>
) {
  return {
    id: customer.id,
    name: customer.name,
    tags: customer.tags,
    type: customer.type,
    priority: customer.priority,
    area: customer.area,
    sei: customer.sei,
    remarks: customer.remarks,
    contacts: contactCounts[customer.id] ?? 0,
    handlers: handlerSummaries(customer.id, ownership, users)
  };
}

function customerMeta(user: CrmContext) {
  return {
    canEditPriority: roleLevel(user) >= 2,
    canEditClass: roleLevel(user) >= 3,
    canDelete: roleLevel(user) >= 3,
    tags: [...DEFAULT_SETTINGS.TAGS],
    types: [...DEFAULT_SETTINGS.TYPES],
    priorities: [...DEFAULT_SETTINGS.PRIORITIES]
  };
}

function expandEmail(value: unknown): string {
  const text = lower(value);
  if (!text) return '';
  return text.includes('@') ? text : `${text}@automationsystems.org`;
}

function normalizeContact(input: ContactInput, fallback: ContactRow | null = null): Partial<ContactRow> {
  return {
    name: input.name !== undefined ? asText(input.name) : fallback?.name,
    designation: input.designation !== undefined ? asText(input.designation) : fallback?.designation,
    phone: input.phone !== undefined ? String(input.phone ?? '') : fallback?.phone,
    email: input.email !== undefined ? asText(input.email) : fallback?.email,
    notes: input.notes !== undefined ? asText(input.notes) : fallback?.notes
  };
}

function customerUpdateFields(user: CrmContext, input: CustomerInput): Partial<CustomerRow> {
  const fields: Partial<CustomerRow> = {
    updatedAt: nowIso()
  };

  if (input.area !== undefined) fields.area = asText(input.area);
  if (input.address !== undefined) fields.address = asText(input.address);
  if (input.gstin !== undefined) fields.gstin = asText(input.gstin);
  if (input.website !== undefined) fields.website = asText(input.website);
  if (input.notes !== undefined) fields.notes = asText(input.notes);
  if (input.sei !== undefined) fields.sei = asText(input.sei);
  if (input.remarks !== undefined) fields.remarks = asText(input.remarks);

  if (input.name !== undefined) {
    const name = asText(input.name);
    if (!name) throw new Error('Customer name cannot be empty.');
    fields.name = name;
  }

  if (input.priority !== undefined) {
    requireLevel(user, 2);
    fields.priority = validOne(input.priority, DEFAULT_SETTINGS.PRIORITIES);
  }

  const wantsClass = input.tags !== undefined || input.type !== undefined || input.status !== undefined;
  if (wantsClass) {
    if (roleLevel(user) < 3) {
      throw new Error('Tags, type and archive status can only be changed at L3 or higher.');
    }
    if (input.tags !== undefined) fields.tags = validTags(input.tags);
    if (input.type !== undefined) fields.type = validOne(input.type, DEFAULT_SETTINGS.TYPES);
    if (input.status !== undefined) fields.status = asText(input.status) === 'Archived' ? 'Archived' : 'Active';
  }

  return fields;
}

async function ensureFullCustomer(
  repo: CustomerRepository,
  user: CrmContext,
  customerId: string
): Promise<CustomerRow> {
  const customer = await repo.getCustomer(customerId);
  if (!customer) throw new Error(`Customer ${customerId} was not found.`);

  const ownership = ownershipFor(await repo.listHandlers());
  ensureFull(user, customerForAccess(customer), accessOwnership(ownership));
  return customer;
}

export function createCustomerService(repo: CustomerRepository) {
  return {
    async searchCustomers(user: CrmContext, query: unknown) {
      requireLevel(user, 2);
      const q = lower(query);
      if ((!q && roleLevel(user) < 4) || (q && q.length < 2)) {
        throw new Error('Type at least 2 characters to search customers.');
      }

      const [customers, handlers, users] = await Promise.all([
        repo.listCustomers(),
        repo.listHandlers(),
        repo.listUsers()
      ]);
      const ownership = ownershipFor(handlers);
      const idx = userIndex(users);
      const matches = (q
        ? activeRows(customers).filter((customer) => {
            const haystack = lower(
              `${customer.name} ${customer.tags.join(' ')} ${customer.area} ${customer.type}`
            );
            return haystack.includes(q);
          })
        : activeRows(customers)
      ).sort((a, b) => lower(a.name).localeCompare(lower(b.name)));

      const visible: SearchCustomerResult[] = [];
      for (const customer of matches) {
        if (visible.length >= 80) break;
        const access = accessLevel(user, customerForAccess(customer), accessOwnership(ownership));
        if (access === 'NONE') continue;

        const result: SearchCustomerResult = {
          id: customer.id,
          name: customer.name,
          tags: customer.tags,
          type: customer.type,
          priority: customer.priority,
          handlers: handlerSummaries(customer.id, ownership, idx).map((handler) => handler.name),
          access
        };
        if (access === 'FULL') result.area = customer.area;
        visible.push(result);
      }

      return visible;
    },

    async myCustomers(user: CrmContext) {
      const [customers, handlers, users, contactCounts] = await Promise.all([
        repo.listCustomers(),
        repo.listHandlers(),
        repo.listUsers(),
        repo.countContactsByCustomer()
      ]);
      const ownership = ownershipFor(handlers);
      const idx = userIndex(users);
      const mine = activeRows(customers)
        .filter((customer) => (ownership.handlersByCustomerId[customer.id] ?? []).includes(normalizeEmail(user.email)))
        .sort((a, b) => lower(a.name).localeCompare(lower(b.name)));

      return {
        ...customerMeta(user),
        customers: mine.slice(0, 400).map((customer) => gridRow(customer, contactCounts, ownership, idx)),
        total: mine.length,
        scope: 'mine' as const
      };
    },

    async allCustomers(user: CrmContext) {
      requireLevel(user, 4);
      const [customers, handlers, users, contactCounts] = await Promise.all([
        repo.listCustomers(),
        repo.listHandlers(),
        repo.listUsers(),
        repo.countContactsByCustomer()
      ]);
      const ownership = ownershipFor(handlers);
      const idx = userIndex(users);
      const active = activeRows(customers).sort((a, b) => lower(a.name).localeCompare(lower(b.name)));

      return {
        ...customerMeta(user),
        customers: active.map((customer) => gridRow(customer, contactCounts, ownership, idx)),
        total: active.length,
        scope: 'all' as const
      };
    },

    async getCustomer(user: CrmContext, id: string) {
      const [customer, handlers, users] = await Promise.all([
        repo.getCustomer(id),
        repo.listHandlers(),
        repo.listUsers()
      ]);
      if (!customer) throw new Error(`Customer ${id} was not found.`);

      const ownership = ownershipFor(handlers);
      const idx = userIndex(users);
      const access = accessLevel(user, customerForAccess(customer), accessOwnership(ownership));
      if (access === 'NONE') throw new Error('You do not have access to this customer.');

      const handlerList = handlerSummaries(customer.id, ownership, idx);
      if (access === 'NAME') {
        return {
          access: 'NAME' as const,
          customer: {
            id: customer.id,
            name: customer.name,
            tags: customer.tags,
            type: customer.type,
            priority: customer.priority
          },
          handlers: handlerList
        };
      }

      const [contacts, cases, quotes] = await Promise.all([
        repo.listContactsByCustomer(customer.id),
        repo.listCasesByCustomer(customer.id),
        repo.listQuotesByCustomer(customer.id)
      ]);
      return {
        access: 'FULL' as const,
        canEditTags: roleLevel(user) >= 3,
        canEditPriority: roleLevel(user) >= 2,
        customer,
        handlers: handlerList,
        contacts,
        cases,
        quotes
      };
    },

    async createCustomer(user: CrmContext, input: CustomerInput) {
      requireLevel(user, 2);
      const name = asText(input?.name);
      if (!name) throw new Error('Customer name is required.');

      return repo.withTransaction(async (tx) => {
        const trx = tx ?? repo;
        if (!input.force) {
          await trx.lockCustomerName(name);
          const duplicate = await trx.findCustomerByName(name);
          if (duplicate) {
            throw new Error(
              `DUPLICATE: A customer named "${duplicate.name}" already exists (${duplicate.id}). Save again to create anyway.`
            );
          }
        }

        const id = await trx.nextCustomerId();
        const now = nowIso();
        await trx.createCustomer({
          id,
          name,
          tags: validTags(input.tags ?? input.tag),
          type: validOne(input.type, DEFAULT_SETTINGS.TYPES),
          priority: validOne(input.priority, DEFAULT_SETTINGS.PRIORITIES),
          area: asText(input.area),
          address: asText(input.address),
          gstin: asText(input.gstin),
          website: asText(input.website),
          notes: asText(input.notes),
          sei: asText(input.sei),
          remarks: asText(input.remarks),
          status: 'Active',
          createdBy: normalizeEmail(user.email),
          createdAt: now,
          updatedAt: now
        });

        await trx.addHandler({
          customerId: id,
          email: roleLevel(user) >= 5 ? 'direct' : normalizeEmail(user.email),
          assignedBy: normalizeEmail(user.email),
          assignedAt: now
        });

        if (input.contact && asText(input.contact.name)) {
          const contactId = await trx.nextContactId();
          const contact = normalizeContact(input.contact);
          await trx.createContact({
            id: contactId,
            customerId: id,
            name: contact.name ?? '',
            designation: contact.designation ?? '',
            phone: contact.phone ?? '',
            email: contact.email ?? '',
            notes: contact.notes ?? '',
            createdBy: normalizeEmail(user.email),
            createdAt: now,
            updatedAt: now
          });
        }

        await trx.logActivity({
          action: 'CUSTOMER_NEW',
          entity: id,
          customerId: id,
          details: name,
          who: normalizeEmail(user.email)
        });

        return { id };
      });
    },

    async updateCustomer(user: CrmContext, id: string, input: CustomerInput) {
      await ensureFullCustomer(repo, user, id);
      const fields = customerUpdateFields(user, input);
      await repo.updateCustomer(id, fields);
      await repo.logActivity({
        action: 'CUSTOMER_EDIT',
        entity: id,
        customerId: id,
        details: fields.name ?? id,
        who: normalizeEmail(user.email)
      });
      return { ok: true };
    },

    async saveCustomerCells(user: CrmContext, patches: CustomerCellPatch[]) {
      const saved: string[] = [];
      const failed: Array<{ id: string; error: string }> = [];

      for (const patch of patches ?? []) {
        try {
          await this.updateCustomer(user, patch.id, patch.fields ?? {});
          saved.push(patch.id);
        } catch (error) {
          failed.push({
            id: patch.id,
            error: error instanceof Error ? error.message : 'Something went wrong.'
          });
        }
      }

      return { saved, failed };
    },

    async bulkCustomers(user: CrmContext, rows: BulkCustomerInput[]) {
      requireLevel(user, 2);
      if (!rows?.length) throw new Error('Nothing to import - add at least one row.');
      if (rows.length > 500) throw new Error('Please import at most 500 customers at a time.');

      return repo.withTransaction(async (tx) => {
        const trx = tx ?? repo;
        let created = 0;
        const skipped: string[] = [];

        for (const row of rows) {
          const name = asText(row.name);
          if (!name) continue;
          await trx.lockCustomerName(name);
          const duplicate = await trx.findCustomerByName(name);
          if (duplicate) {
            skipped.push(name);
            continue;
          }

          const id = await trx.nextCustomerId();
          const now = nowIso();
          await trx.createCustomer({
            id,
            name,
            tags: validTags(row.tags ?? row.tag),
            type: validOne(row.type, DEFAULT_SETTINGS.TYPES),
            priority: validOne(row.priority, DEFAULT_SETTINGS.PRIORITIES),
            area: asText(row.area),
            address: asText(row.address),
            gstin: asText(row.gstin),
            website: '',
            notes: '',
            sei: '',
            remarks: '',
            status: 'Active',
            createdBy: normalizeEmail(user.email),
            createdAt: now,
            updatedAt: now
          });
          await trx.addHandler({
            customerId: id,
            email: normalizeEmail(user.email),
            assignedBy: normalizeEmail(user.email),
            assignedAt: now
          });
          created++;
        }

        await trx.logActivity({
          action: 'BULK_CUSTOMERS',
          entity: '',
          customerId: '',
          details: `${created} created, ${skipped.length} skipped`,
          who: normalizeEmail(user.email)
        });

        return { created, skipped };
      });
    },

    async addContact(user: CrmContext, customerId: string, input: ContactInput) {
      await ensureFullCustomer(repo, user, customerId);
      const contact = normalizeContact(input);
      if (!contact.name) throw new Error('Contact name is required.');

      const id = await repo.nextContactId();
      const now = nowIso();
      await repo.createContact({
        id,
        customerId,
        name: contact.name,
        designation: contact.designation ?? '',
        phone: contact.phone ?? '',
        email: contact.email ?? '',
        notes: contact.notes ?? '',
        createdBy: normalizeEmail(user.email),
        createdAt: now,
        updatedAt: now
      });
      await repo.logActivity({
        action: 'CONTACT_NEW',
        entity: id,
        customerId,
        details: contact.name,
        who: normalizeEmail(user.email)
      });
      return { id };
    },

    async updateContact(user: CrmContext, contactId: string, input: ContactInput) {
      const existing = await repo.getContact(contactId);
      if (!existing) throw new Error('Contact not found.');
      await ensureFullCustomer(repo, user, existing.customerId);

      const fields = normalizeContact(input, existing);
      await repo.updateContact(contactId, fields);
      await repo.logActivity({
        action: 'CONTACT_EDIT',
        entity: contactId,
        customerId: existing.customerId,
        details: fields.name ?? existing.name,
        who: normalizeEmail(user.email)
      });
      return { ok: true };
    },

    async deleteContact(user: CrmContext, contactId: string) {
      const existing = await repo.getContact(contactId);
      if (!existing) throw new Error('Contact not found.');
      await ensureFullCustomer(repo, user, existing.customerId);
      await repo.deleteContact(contactId);
      await repo.logActivity({
        action: 'CONTACT_DELETE',
        entity: contactId,
        customerId: existing.customerId,
        details: existing.name,
        who: normalizeEmail(user.email)
      });
      return { ok: true };
    },

    async bulkContacts(user: CrmContext, customerId: string, rows: ContactInput[]) {
      await ensureFullCustomer(repo, user, customerId);
      if (!rows?.length) throw new Error('Nothing to add - paste at least one contact.');

      return repo.withTransaction(async (tx) => {
        const trx = tx ?? repo;
        let created = 0;
        for (const row of rows) {
          const contact = normalizeContact(row);
          if (!contact.name) continue;
          const id = await trx.nextContactId();
          const now = nowIso();
          await trx.createContact({
            id,
            customerId,
            name: contact.name,
            designation: contact.designation ?? '',
            phone: contact.phone ?? '',
            email: contact.email ?? '',
            notes: contact.notes ?? '',
            createdBy: normalizeEmail(user.email),
            createdAt: now,
            updatedAt: now
          });
          created++;
        }

        await trx.logActivity({
          action: 'BULK_CONTACTS',
          entity: customerId,
          customerId,
          details: `${created} contacts added`,
          who: normalizeEmail(user.email)
        });

        return { created };
      });
    },

    async addHandler(user: CrmContext, customerId: string, emailInput: unknown) {
      const [customer, handlers, users] = await Promise.all([
        repo.getCustomer(customerId),
        repo.listHandlers(),
        repo.listUsers()
      ]);
      if (!customer) throw new Error(`Customer ${customerId} was not found.`);

      const currentHandlers = ownershipFor(handlers).handlersByCustomerId[customerId] ?? [];
      if (roleLevel(user) < 3 && !currentHandlers.includes(normalizeEmail(user.email))) {
        throw new Error('Only an existing handler, or L3+, can add account handlers.');
      }

      const idx = userIndex(users);
      const email = expandEmail(emailInput);
      if (!email || !idx[email]?.active) {
        throw new Error('That email is not an active CRM user. Add them under Admin > Users first.');
      }
      if (currentHandlers.includes(email)) {
        throw new Error(`${nameOf(idx, email)} is already a handler for this customer.`);
      }

      await repo.withTransaction(async (tx) => {
        const trx = tx ?? repo;
        await trx.removeDirectHandlers(customerId);
        await trx.addHandler({
          customerId,
          email,
          assignedBy: normalizeEmail(user.email),
          assignedAt: nowIso()
        });
        await trx.logActivity({
          action: 'HANDLER_ADD',
          entity: customerId,
          customerId,
          details: `${nameOf(idx, email)} added to ${customer.name}`,
          who: normalizeEmail(user.email)
        });
        return undefined;
      });

      return { ok: true };
    },

    async removeHandler(user: CrmContext, customerId: string, emailInput: unknown) {
      const handlers = await repo.listHandlers();
      const currentHandlers = ownershipFor(handlers).handlersByCustomerId[customerId] ?? [];
      if (roleLevel(user) < 3 && !currentHandlers.includes(normalizeEmail(user.email))) {
        throw new Error('Only an existing handler, or L3+, can remove account handlers.');
      }

      const email = expandEmail(emailInput);
      if (!currentHandlers.includes(email)) {
        throw new Error('That user is not a handler for this customer.');
      }

      await repo.removeHandler(customerId, email);
      await repo.logActivity({
        action: 'HANDLER_REMOVE',
        entity: customerId,
        customerId,
        details: email,
        who: normalizeEmail(user.email)
      });
      return { ok: true };
    },

    async deleteCustomers(user: CrmContext, ids: string[]) {
      requireLevel(user, 3);
      let deleted = 0;
      const skipped: Array<{ name: string; reason: string }> = [];

      await repo.withTransaction(async (tx) => {
        const trx = tx ?? repo;
        for (const id of (ids ?? []).map(String)) {
          const customer = await trx.getCustomer(id);
          if (!customer) {
            skipped.push({ name: id, reason: 'not found' });
            continue;
          }

          try {
            const ownership = ownershipFor(await trx.listHandlers());
            ensureFull(user, customerForAccess(customer), accessOwnership(ownership));
          } catch {
            skipped.push({ name: customer.name, reason: 'no access' });
            continue;
          }

          if ((await trx.hasCases(id)) || (await trx.hasQuotations(id))) {
            skipped.push({ name: customer.name, reason: 'has cases/quotations' });
            continue;
          }

          await trx.moveCustomerToRecycleBin(customer, normalizeEmail(user.email));
          await trx.deleteCustomer(id);
          await trx.logActivity({
            action: 'CUSTOMER_DELETE',
            entity: id,
            customerId: id,
            details: customer.name,
            who: normalizeEmail(user.email)
          });
          deleted++;
        }
        return undefined;
      });

      return { deleted, skipped };
    }
  };
}

export type CustomerService = ReturnType<typeof createCustomerService>;
