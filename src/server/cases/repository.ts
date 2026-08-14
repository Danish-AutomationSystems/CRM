import type { Sql, TransactionSql } from 'postgres';

import { sql, withTransaction } from '../db/client';
import { nextCrmId } from '../db/ids';
import { CRM_ID_FORMATS } from '../db/schema';
import { joinPipe, normalizeEmail, parsePipe } from '../domain/lists';
import type {
  CaseActivityLogEntry,
  CaseActivityRow,
  CaseCustomerRow,
  CaseHandlerRow,
  CaseQuoteRow,
  CaseRepository,
  CaseRow,
  CaseUserRow
} from './service';
import type { DashboardActivityRow } from '../dashboard/service';

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

type HandlerDbRow = {
  customer_id: string;
  user_email: string;
  assigned_by: string | null;
  assigned_at: string | Date;
};

type UserDbRow = {
  email: string;
  name: string;
  role: CaseUserRow['role'];
  allowed_tags: string[] | null;
  active: boolean;
};

type CaseDbRow = {
  case_id: string;
  customer_id: string;
  title: string;
  details: string | null;
  source: string | null;
  stage: string;
  outcome: 'Won' | 'Lost' | 'Hold' | null;
  order_value: string | number | null;
  won_categories: string | null;
  outcome_note: string | null;
  owner: string | null;
  extra_owners: string | null;
  assignee: string | null;
  closed_on: string | Date | null;
  created_by: string | null;
  created_at: string | Date;
  updated_at: string | Date;
};

type QuoteDbRow = {
  quote_no: string;
  rev: number;
  case_id: string;
  title: string;
  total: string | number | null;
  currency: string;
  status: string;
  created_at: string | Date;
  created_by: string | null;
  doc_link: string | null;
  pdf_link: string | null;
};

function dateString(value: string | Date | null | undefined): string {
  if (!value) return '';
  return value instanceof Date ? value.toISOString() : String(value);
}

function numberOrBlank(value: string | number | null | undefined): number | '' {
  if (value === null || value === undefined || value === '') return '';
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : '';
}

function toCustomer(row: CustomerDbRow): CaseCustomerRow {
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

function toHandler(row: HandlerDbRow): CaseHandlerRow {
  return {
    customerId: row.customer_id,
    email: normalizeEmail(row.user_email),
    assignedBy: row.assigned_by ?? '',
    assignedAt: dateString(row.assigned_at)
  };
}

function toUser(row: UserDbRow): CaseUserRow {
  return {
    email: normalizeEmail(row.email),
    name: row.name,
    role: row.role,
    allowedTags: row.allowed_tags ?? [],
    active: row.active
  };
}

function toCase(row: CaseDbRow): CaseRow {
  return {
    id: row.case_id,
    customerId: row.customer_id,
    title: row.title,
    details: row.details ?? '',
    source: row.source ?? '',
    stage: row.stage,
    outcome: row.outcome ?? '',
    orderValue: numberOrBlank(row.order_value),
    wonCategories: parsePipe(row.won_categories),
    outcomeNote: row.outcome_note ?? '',
    owner: normalizeEmail(row.owner),
    extraOwners: parsePipe(row.extra_owners).map(normalizeEmail),
    assignee: normalizeEmail(row.assignee),
    closedOn: dateString(row.closed_on),
    createdBy: normalizeEmail(row.created_by),
    createdAt: dateString(row.created_at),
    updatedAt: dateString(row.updated_at)
  };
}

function toQuote(row: QuoteDbRow): CaseQuoteRow {
  return {
    caseId: row.case_id,
    quoteNo: row.quote_no,
    rev: Number(row.rev),
    title: row.title,
    total: Number(row.total ?? 0),
    currency: row.currency,
    status: row.status,
    createdAt: dateString(row.created_at),
    createdBy: normalizeEmail(row.created_by),
    doc: row.doc_link ?? '',
    pdf: row.pdf_link ?? ''
  };
}

function dbOutcome(value: CaseRow['outcome']): 'Won' | 'Lost' | 'Hold' | null {
  return value || null;
}

function dbNumber(value: number | ''): number | null {
  return value === '' ? null : value;
}

function dbDate(value: string): string | null {
  return value || null;
}

function dbEmail(value: string): string | null {
  return normalizeEmail(value) || null;
}

function customerNameLockKey(name: string): string {
  return `customer-name:${name.trim().toLowerCase().replace(/\s+/g, ' ')}`;
}

export class PostgresCaseRepository implements CaseRepository {
  constructor(private readonly db: DbExecutor = sql) {}

  async withTransaction<T>(fn: (repo?: CaseRepository) => Promise<T>): Promise<T> {
    return withTransaction((tx) => fn(new PostgresCaseRepository(tx)));
  }

  async lockCustomerName(name: string): Promise<void> {
    await this.db`select pg_advisory_xact_lock(hashtext(${customerNameLockKey(name)}))`;
  }

  async nextCustomerId(): Promise<string> {
    const format = CRM_ID_FORMATS.customers;
    return nextCrmId(this.db, format.key, format.prefix, format.width);
  }

  async nextCaseId(): Promise<string> {
    const format = CRM_ID_FORMATS.cases;
    return nextCrmId(this.db, format.key, format.prefix, format.width, new Date().getFullYear());
  }

  async getCustomer(id: string): Promise<CaseCustomerRow | null> {
    const rows = (await this.db`
      select customer_id, name, tags, type, priority, area, address, gstin, website, notes,
             sei, remarks, status, created_by, created_at, updated_at
      from public.customers
      where customer_id = ${id}
      limit 1
    `) as CustomerDbRow[];

    return rows[0] ? toCustomer(rows[0]) : null;
  }

  async getCustomersByIds(ids: string[]): Promise<CaseCustomerRow[]> {
    if (ids.length === 0) return [];
    const rows = (await this.db`
      select customer_id, name, tags, type, priority, area, address, gstin, website, notes,
             sei, remarks, status, created_by, created_at, updated_at
      from public.customers
      where customer_id in ${this.db(ids)}
    `) as CustomerDbRow[];

    return rows.map(toCustomer);
  }

  async findCustomerByName(name: string): Promise<CaseCustomerRow | null> {
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

  async createCustomer(customer: CaseCustomerRow): Promise<void> {
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

  async addHandler(handler: CaseHandlerRow): Promise<void> {
    await this.db`
      insert into public.handlers (customer_id, user_email, assigned_by, assigned_at)
      values (${handler.customerId}, ${handler.email}, ${handler.assignedBy}, ${handler.assignedAt})
    `;
  }

  async listHandlers(): Promise<CaseHandlerRow[]> {
    const rows = (await this.db`
      select customer_id, user_email, assigned_by, assigned_at
      from public.handlers
    `) as HandlerDbRow[];

    return rows.map(toHandler);
  }

  async listUsers(): Promise<CaseUserRow[]> {
    const rows = (await this.db`
      select email, name, role, allowed_tags, active
      from public.users
    `) as UserDbRow[];

    return rows.map(toUser);
  }

  async getCase(id: string): Promise<CaseRow | null> {
    const rows = (await this.db`
      select case_id, customer_id, title, details, source, stage, outcome, order_value,
             won_categories, outcome_note, owner, extra_owners, assignee, closed_on,
             created_by, created_at, updated_at
      from public.cases
      where case_id = ${id}
      limit 1
    `) as CaseDbRow[];

    return rows[0] ? toCase(rows[0]) : null;
  }

  async listCases(): Promise<CaseRow[]> {
    const rows = (await this.db`
      select case_id, customer_id, title, details, source, stage, outcome, order_value,
             won_categories, outcome_note, owner, extra_owners, assignee, closed_on,
             created_by, created_at, updated_at
      from public.cases
    `) as CaseDbRow[];

    return rows.map(toCase);
  }

  async createCase(row: CaseRow): Promise<void> {
    await this.db`
      insert into public.cases (
        case_id, customer_id, title, details, source, stage, outcome, order_value,
        won_categories, outcome_note, owner, extra_owners, assignee, closed_on,
        created_by, created_at, updated_at
      )
      values (
        ${row.id}, ${row.customerId}, ${row.title}, ${row.details}, ${row.source}, ${row.stage},
        ${dbOutcome(row.outcome)}, ${dbNumber(row.orderValue)}, ${joinPipe(row.wonCategories)},
        ${row.outcomeNote}, ${dbEmail(row.owner)}, ${joinPipe(row.extraOwners)}, ${dbEmail(row.assignee)},
        ${dbDate(row.closedOn)}, ${dbEmail(row.createdBy)}, ${row.createdAt}, ${row.updatedAt}
      )
    `;
  }

  async updateCase(id: string, fields: Partial<CaseRow>): Promise<void> {
    const existing = await this.getCase(id);
    if (!existing) throw new Error(`Case ${id} was not found.`);
    const row = { ...existing, ...fields };
    await this.db`
      update public.cases
      set
        title = ${row.title},
        details = ${row.details},
        source = ${row.source},
        stage = ${row.stage},
        outcome = ${dbOutcome(row.outcome)},
        order_value = ${dbNumber(row.orderValue)},
        won_categories = ${joinPipe(row.wonCategories)},
        outcome_note = ${row.outcomeNote},
        owner = ${dbEmail(row.owner)},
        extra_owners = ${joinPipe(row.extraOwners)},
        assignee = ${dbEmail(row.assignee)},
        closed_on = ${dbDate(row.closedOn)},
        updated_at = ${row.updatedAt},
        version = version + 1
      where case_id = ${id}
    `;
  }

  async listQuotesByCase(caseId: string): Promise<CaseQuoteRow[]> {
    const rows = (await this.db`
      select quote_no, rev, case_id, title, total, currency, status, created_at, created_by, doc_link, pdf_link
      from public.quotations
      where case_id = ${caseId}
    `) as QuoteDbRow[];

    return rows.map(toQuote);
  }

  async listActivityByEntity(entity: string): Promise<CaseActivityRow[]> {
    const rows = (await this.db`
      select created_at as when, who, action, details, note
      from public.activity_log
      where entity = ${entity}
      order by created_at desc
      limit 40
    `) as Array<{ when: string | Date; who: string; action: string; details: string; note: string | null }>;

    return rows.map((row) => ({
      when: dateString(row.when),
      who: normalizeEmail(row.who),
      action: row.action,
      details: row.details,
      note: row.note ?? ''
    }));
  }

  async listActivity(limit = 250): Promise<DashboardActivityRow[]> {
    const rows = (await this.db`
      select created_at as when, who, action, entity, customer_id, details
      from public.activity_log
      order by created_at desc
      limit ${limit}
    `) as Array<{
      when: string | Date;
      who: string;
      action: string;
      entity: string;
      customer_id: string | null;
      details: string;
    }>;

    return rows.map((row) => ({
      when: dateString(row.when),
      who: normalizeEmail(row.who),
      action: row.action,
      entity: row.entity,
      customerId: row.customer_id ?? '',
      details: row.details
    }));
  }

  async latestQuotedValueByCase(): Promise<Record<string, number>> {
    const rows = (await this.db`
      select distinct on (case_id) case_id, total
      from public.quotations
      where case_id is not null
        and status <> 'Superseded'
      order by case_id, quote_no desc, rev desc
    `) as Array<{ case_id: string; total: string | number | null }>;

    return rows.reduce<Record<string, number>>((map, row) => {
      map[row.case_id] = Number(row.total ?? 0);
      return map;
    }, {});
  }

  async logActivity(entry: CaseActivityLogEntry): Promise<void> {
    await this.db`
      insert into public.activity_log (who, action, entity, customer_id, details, note)
      values (${entry.who}, ${entry.action}, ${entry.entity}, ${entry.customerId || null}, ${entry.details}, ${entry.note ?? ''})
    `;
  }

  async latestHandoverNote(caseId: string): Promise<string> {
    const rows = (await this.db`
      select note
      from public.activity_log
      where entity = ${caseId}
        and action = 'CASE_ASSIGN'
        and note <> ''
      order by created_at desc
      limit 1
    `) as Array<{ note: string }>;

    return rows[0]?.note ?? '';
  }
}

export const caseRepository = new PostgresCaseRepository();
