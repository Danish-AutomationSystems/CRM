import type { Sql, TransactionSql } from 'postgres';

import { sql, withTransaction } from '../db/client';
import { nextCrmId } from '../db/ids';
import { CRM_ID_FORMATS } from '../db/schema';
import { joinPipe, normalizeEmail, parsePipe } from '../domain/lists';
import type {
  ActivityLogEntry,
  CaseOwnerRow,
  CustomerCaseSummary,
  ContactRow,
  CustomerQuoteSummary,
  CustomerRepository,
  CustomerRow,
  CustomerUserRow,
  HandlerRow
} from './service';

type DbExecutor = Sql | TransactionSql;

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
  sei: string[] | null;
  remarks: string | null;
  status: 'Active' | 'Archived';
  created_by: string | null;
  created_at: string | Date;
  updated_at: string | Date;
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
  created_at: string | Date;
  updated_at: string | Date;
};

type HandlerDbRow = {
  customer_id: string;
  user_email: string;
  assigned_by: string | null;
  assigned_at: string | Date;
};

type CustomerCaseDbRow = {
  case_id: string;
  customer_id: string;
  title: string;
  stage: string;
  priority: string | null;
  outcome: string | null;
  order_value: string | number | null;
  quoted_value: string | number | null;
  owners: string[] | null;
  assignee: string | null;
  updated_at: string | Date;
};

type CustomerQuoteDbRow = {
  quote_no: string;
  rev: number;
  case_id: string | null;
  customer_id: string;
  title: string;
  source: 'Generated' | 'External';
  status: 'Draft' | 'Sent' | 'Superseded';
  total: string | number | null;
  currency: string;
  file_name: string | null;
  doc_link: string | null;
  pdf_link: string | null;
  created_at: string | Date;
};

type UserDbRow = {
  email: string;
  name: string;
  role: CustomerUserRow['role'];
  allowed_tags: string[] | null;
  active: boolean;
};

function dateString(value: string | Date | null | undefined): string {
  if (!value) return '';
  return value instanceof Date ? value.toISOString() : String(value);
}

function toCustomer(row: CustomerDbRow): CustomerRow {
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
    sei: row.sei ?? [],
    remarks: row.remarks ?? '',
    status: row.status,
    createdBy: row.created_by ?? '',
    createdAt: dateString(row.created_at),
    updatedAt: dateString(row.updated_at)
  };
}

function toContact(row: ContactDbRow): ContactRow {
  return {
    id: row.contact_id,
    customerId: row.customer_id,
    name: row.name,
    designation: row.designation ?? '',
    phone: row.phone ?? '',
    email: row.email ?? '',
    notes: row.notes ?? '',
    createdBy: row.created_by ?? '',
    createdAt: dateString(row.created_at),
    updatedAt: dateString(row.updated_at)
  };
}

function toHandler(row: HandlerDbRow): HandlerRow {
  return {
    customerId: row.customer_id,
    email: normalizeEmail(row.user_email),
    assignedBy: row.assigned_by ?? '',
    assignedAt: dateString(row.assigned_at)
  };
}

function toUser(row: UserDbRow): CustomerUserRow {
  return {
    email: normalizeEmail(row.email),
    name: row.name,
    role: row.role,
    allowedTags: row.allowed_tags ?? [],
    active: row.active
  };
}

function numberOrBlank(value: string | number | null | undefined): number | '' {
  if (value === null || value === undefined || value === '') return '';
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : '';
}

function toCustomerCase(row: CustomerCaseDbRow): CustomerCaseSummary {
  return {
    id: row.case_id,
    customerId: row.customer_id,
    title: row.title,
    stage: row.stage,
    priority: row.priority ?? '',
    outcome: row.outcome ?? '',
    orderValue: numberOrBlank(row.order_value),
    quotedValue: numberOrBlank(row.quoted_value),
    owners: row.owners ?? [],
    assignee: normalizeEmail(row.assignee),
    updatedAt: dateString(row.updated_at)
  };
}

function toCustomerQuote(row: CustomerQuoteDbRow): CustomerQuoteSummary {
  return {
    quoteNo: row.quote_no,
    rev: Number(row.rev),
    caseId: row.case_id ?? '',
    customerId: row.customer_id,
    title: row.title,
    source: row.source,
    status: row.status,
    total: numberOrBlank(row.total),
    currency: row.currency,
    fileName: row.file_name ?? '',
    doc: row.doc_link ?? '',
    pdf: row.pdf_link ?? '',
    createdAt: dateString(row.created_at)
  };
}

function customerNameLockKey(name: string): string {
  return `customer-name:${name.trim().toLowerCase().replace(/\s+/g, ' ')}`;
}

export class PostgresCustomerRepository implements CustomerRepository {
  constructor(private readonly db: DbExecutor = sql) {}

  async withTransaction<T>(fn: (repo?: CustomerRepository) => Promise<T>): Promise<T> {
    return withTransaction((tx) => fn(new PostgresCustomerRepository(tx)));
  }

  async lockCustomerName(name: string): Promise<void> {
    await this.db`select pg_advisory_xact_lock(hashtext(${customerNameLockKey(name)}))`;
  }

  async nextCustomerId(): Promise<string> {
    const format = CRM_ID_FORMATS.customers;
    return nextCrmId(this.db, format.key, format.prefix, format.width);
  }

  async nextContactId(): Promise<string> {
    const format = CRM_ID_FORMATS.contacts;
    return nextCrmId(this.db, format.key, format.prefix, format.width);
  }

  async listCustomers(): Promise<CustomerRow[]> {
    const rows = (await this.db`
      select customer_id, name, tags, type, priority, area, address, gstin, website, notes,
             sei, remarks, status, created_by, created_at, updated_at
      from public.customers
    `) as CustomerDbRow[];

    return rows.map(toCustomer);
  }

  async getCustomer(id: string): Promise<CustomerRow | null> {
    const rows = (await this.db`
      select customer_id, name, tags, type, priority, area, address, gstin, website, notes,
             sei, remarks, status, created_by, created_at, updated_at
      from public.customers
      where customer_id = ${id}
      limit 1
    `) as CustomerDbRow[];

    return rows[0] ? toCustomer(rows[0]) : null;
  }

  async findCustomerByName(name: string): Promise<CustomerRow | null> {
    const key = name.trim().toLowerCase().replace(/\s+/g, ' ');
    const rows = (await this.db`
      select customer_id, name, tags, type, priority, area, address, gstin, website, notes,
             sei, remarks, status, created_by, created_at, updated_at
      from public.customers
      where name_key = ${key}
      limit 1
    `) as CustomerDbRow[];

    return rows[0] ? toCustomer(rows[0]) : null;
  }

  async createCustomer(customer: CustomerRow): Promise<void> {
    await this.db`
      insert into public.customers (
        customer_id, name, tags, type, priority, area, address, gstin, website, notes,
        sei, remarks, status, created_by, created_at, updated_at
      )
      values (
        ${customer.id}, ${customer.name}, ${customer.tags}, ${customer.type}, ${customer.priority},
        ${customer.area}, ${customer.address}, ${customer.gstin}, ${customer.website}, ${customer.notes},
        ${customer.sei}, ${customer.remarks}, ${customer.status}, ${customer.createdBy},
        ${customer.createdAt}, ${customer.updatedAt}
      )
    `;
  }

  async updateCustomer(id: string, fields: Partial<CustomerRow>): Promise<void> {
    await this.db`
      update public.customers
      set
        name = coalesce(${fields.name ?? null}, name),
        tags = coalesce(${fields.tags ?? null}, tags),
        type = coalesce(${fields.type ?? null}, type),
        priority = coalesce(${fields.priority ?? null}, priority),
        area = coalesce(${fields.area ?? null}, area),
        address = coalesce(${fields.address ?? null}, address),
        gstin = coalesce(${fields.gstin ?? null}, gstin),
        website = coalesce(${fields.website ?? null}, website),
        notes = coalesce(${fields.notes ?? null}, notes),
        sei = coalesce(${fields.sei ?? null}, sei),
        remarks = coalesce(${fields.remarks ?? null}, remarks),
        status = coalesce(${fields.status ?? null}, status),
        updated_at = now(),
        version = version + 1
      where customer_id = ${id}
    `;
  }

  async deleteCustomer(id: string): Promise<void> {
    await this.db`delete from public.contacts where customer_id = ${id}`;
    await this.db`delete from public.handlers where customer_id = ${id}`;
    await this.db`delete from public.customers where customer_id = ${id}`;
  }

  async moveCustomerToRecycleBin(customer: CustomerRow, deletedBy: string): Promise<void> {
    await this.db`
      insert into public.recycle_bin (
        customer_id, name, tags, type, priority, area, address, gstin, website, notes,
        sei, remarks, status, created_by, created_at, updated_at, deleted_by, snapshot
      )
      values (
        ${customer.id}, ${customer.name}, ${customer.tags}, ${customer.type}, ${customer.priority},
        ${customer.area}, ${customer.address}, ${customer.gstin}, ${customer.website}, ${customer.notes},
        ${customer.sei}, ${customer.remarks}, 'Archived', ${customer.createdBy}, ${customer.createdAt},
        ${customer.updatedAt}, ${deletedBy}, ${JSON.stringify(customer)}
      )
    `;
  }

  async listContactsByCustomer(customerId: string): Promise<ContactRow[]> {
    const rows = (await this.db`
      select contact_id, customer_id, name, designation, phone, email, notes, created_by, created_at, updated_at
      from public.contacts
      where customer_id = ${customerId}
      order by name asc
    `) as ContactDbRow[];

    return rows.map(toContact);
  }

  async listCasesByCustomer(customerId: string): Promise<CustomerCaseSummary[]> {
    const rows = (await this.db`
      with latest_quotes as (
        select distinct on (case_id)
          case_id,
          total as quoted_value
        from public.quotations
        where customer_id = ${customerId}
          and status <> 'Superseded'
          and case_id is not null
        order by case_id, rev desc
      )
      -- P11: owners are materialised on the case, never derived from public.handlers.
      select c.case_id, c.customer_id, c.title, c.stage, c.priority, c.outcome, c.order_value,
             lq.quoted_value,
             case
               when cardinality(so.owners) > 0 then so.owners
               when lower(btrim(coalesce(c.owner, ''))) in ('', 'direct') then '{}'::text[]
               else array[lower(btrim(c.owner))]
             end as owners,
             c.assignee, c.updated_at
      from public.cases c
      left join lateral (
        select coalesce(
          (
            select array_agg(distinct lower(btrim(t)))
            from unnest(string_to_array(coalesce(c.extra_owners, ''), '|')) as t
            where btrim(t) <> ''
          ),
          '{}'::text[]
        ) as owners
      ) so on true
      left join latest_quotes lq on lq.case_id = c.case_id
      where c.customer_id = ${customerId}
      order by c.updated_at desc
    `) as CustomerCaseDbRow[];

    return rows.map(toCustomerCase);
  }

  async listQuotesByCustomer(customerId: string): Promise<CustomerQuoteSummary[]> {
    const rows = (await this.db`
      select quote_no, rev, case_id, customer_id, title, source, status, total,
             currency, file_name, doc_link, pdf_link, created_at
      from public.quotations
      where customer_id = ${customerId}
      order by quote_no desc, rev desc
    `) as CustomerQuoteDbRow[];

    return rows.map(toCustomerQuote);
  }

  async countContactsByCustomer(): Promise<Record<string, number>> {
    const rows = (await this.db`
      select customer_id, count(*)::int as count
      from public.contacts
      group by customer_id
    `) as Array<{ customer_id: string; count: number }>;

    return rows.reduce<Record<string, number>>((counts, row) => {
      counts[row.customer_id] = row.count;
      return counts;
    }, {});
  }

  async getContact(contactId: string): Promise<ContactRow | null> {
    const rows = (await this.db`
      select contact_id, customer_id, name, designation, phone, email, notes, created_by, created_at, updated_at
      from public.contacts
      where contact_id = ${contactId}
      limit 1
    `) as ContactDbRow[];

    return rows[0] ? toContact(rows[0]) : null;
  }

  async createContact(contact: ContactRow): Promise<void> {
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

  async updateContact(contactId: string, fields: Partial<ContactRow>): Promise<void> {
    await this.db`
      update public.contacts
      set
        name = coalesce(${fields.name ?? null}, name),
        designation = coalesce(${fields.designation ?? null}, designation),
        phone = coalesce(${fields.phone ?? null}, phone),
        email = coalesce(${fields.email ?? null}, email),
        notes = coalesce(${fields.notes ?? null}, notes),
        updated_at = now()
      where contact_id = ${contactId}
    `;
  }

  async deleteContact(contactId: string): Promise<void> {
    await this.db`delete from public.contacts where contact_id = ${contactId}`;
  }

  async listHandlers(): Promise<HandlerRow[]> {
    const rows = (await this.db`
      select customer_id, user_email, assigned_by, assigned_at
      from public.handlers
    `) as HandlerDbRow[];

    return rows.map(toHandler);
  }

  async addHandler(handler: HandlerRow): Promise<void> {
    await this.db`
      insert into public.handlers (customer_id, user_email, assigned_by, assigned_at)
      values (${handler.customerId}, ${handler.email}, ${handler.assignedBy}, ${handler.assignedAt})
    `;
  }

  async removeHandler(customerId: string, email: string): Promise<void> {
    await this.db`
      delete from public.handlers
      where customer_id = ${customerId}
        and user_email = ${normalizeEmail(email)}
    `;
  }

  async removeDirectHandlers(customerId: string): Promise<void> {
    await this.db`
      delete from public.handlers
      where customer_id = ${customerId}
        and user_email = 'direct'
    `;
  }

  async listCaseOwnerRows(customerId: string): Promise<CaseOwnerRow[]> {
    const rows = (await this.db`
      select case_id, customer_id, outcome, extra_owners
      from public.cases
      where customer_id = ${customerId}
    `) as Array<{ case_id: string; customer_id: string; outcome: string | null; extra_owners: string | null }>;

    return rows.map((row) => ({
      id: row.case_id,
      customerId: row.customer_id,
      outcome: row.outcome ?? '',
      extraOwners: parsePipe(row.extra_owners).map(normalizeEmail)
    }));
  }

  async setCaseExtraOwners(caseId: string, extraOwners: string[]): Promise<void> {
    await this.db`
      update public.cases
      set extra_owners = ${joinPipe(extraOwners)},
          updated_at = now(),
          version = version + 1
      where case_id = ${caseId}
    `;
  }

  async getSetting(key: string): Promise<string | null> {
    const rows = (await this.db`
      select value
      from public.settings
      where key = ${key}
      limit 1
    `) as Array<{ value: string | null }>;

    return rows[0]?.value ?? null;
  }

  async listUsers(): Promise<CustomerUserRow[]> {
    const rows = (await this.db`
      select email, name, role, allowed_tags, active
      from public.users
    `) as UserDbRow[];

    return rows.map(toUser);
  }

  async hasCases(customerId: string): Promise<boolean> {
    const rows = (await this.db`
      select 1
      from public.cases
      where customer_id = ${customerId}
      limit 1
    `) as Array<{ '?column?': number }>;

    return rows.length > 0;
  }

  async hasQuotations(customerId: string): Promise<boolean> {
    const rows = (await this.db`
      select 1
      from public.quotations
      where customer_id = ${customerId}
      limit 1
    `) as Array<{ '?column?': number }>;

    return rows.length > 0;
  }

  async logActivity(entry: ActivityLogEntry): Promise<void> {
    await this.db`
      insert into public.activity_log (who, action, entity, customer_id, details)
      values (${entry.who}, ${entry.action}, ${entry.entity}, ${entry.customerId || null}, ${entry.details})
    `;
  }
}

export const customerRepository = new PostgresCustomerRepository();
