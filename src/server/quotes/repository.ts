import type { Sql, TransactionSql } from 'postgres';

import { sql, withTransaction } from '../db/client';
import { nextCrmId } from '../db/ids';
import { CRM_ID_FORMATS } from '../db/schema';
import { joinPipe, normalizeEmail, parsePipe } from '../domain/lists';
import type {
  QuoteActivityLogEntry,
  QuoteBoqBlock,
  QuoteCaseRow,
  QuoteCustomerRow,
  QuoteHandlerRow,
  QuoteRepository,
  QuoteRow,
  QuoteUserRow
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

type UserDbRow = {
  email: string;
  name: string;
  role: QuoteUserRow['role'];
  allowed_tags: string[] | null;
  active: boolean;
};

type HandlerDbRow = {
  customer_id: string;
  user_email: string;
  assigned_by: string | null;
  assigned_at: string | Date;
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
  case_id: string | null;
  customer_id: string;
  title: string;
  source: QuoteRow['source'];
  file_name: string | null;
  upload_mime_type: string | null;
  upload_data_b64: string | null;
  template_id: string | null;
  template_name: string | null;
  status: QuoteRow['status'];
  subtotal: string | number | null;
  tax_pct: string | number | null;
  tax_amount: string | number | null;
  total: string | number | null;
  currency: string;
  valid_until: string | Date | null;
  notes: string | null;
  doc_link: string | null;
  pdf_link: string | null;
  drive_file_id: string | null;
  drive_view_link: string | null;
  drive_saved_at: string | Date | null;
  drive_saved_by: string | null;
  created_by: string | null;
  created_at: string | Date;
  updated_at: string | Date;
};

type BoqDbRow = {
  quote_no: string;
  rev: number;
  block: number;
  title: string | null;
  headers: unknown;
  rows: unknown;
};

function dateString(value: string | Date | null | undefined): string {
  if (!value) return '';
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

function dateOnly(value: string | Date | null | undefined): string {
  const text = dateString(value);
  return text.includes('T') ? text.slice(0, 10) : text;
}

function numberOrBlank(value: string | number | null | undefined): number | '' {
  if (value === null || value === undefined || value === '') return '';
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : '';
}

function dbNumber(value: number | ''): number | null {
  return value === '' ? null : value;
}

function dbDate(value: string): string | null {
  return value || null;
}

function dbBytes(value: string): Buffer | null {
  return value ? Buffer.from(value, 'base64') : null;
}

function dbEmail(value: string): string | null {
  return normalizeEmail(value) || null;
}

function jsonArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String) : [];
}

function jsonRows(value: unknown): string[][] {
  return Array.isArray(value)
    ? value.map((row) => (Array.isArray(row) ? row.map(String) : [])).filter((row) => row.length > 0)
    : [];
}

function toCustomer(row: CustomerDbRow): QuoteCustomerRow {
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

function toUser(row: UserDbRow): QuoteUserRow {
  return {
    email: normalizeEmail(row.email),
    name: row.name,
    role: row.role,
    allowedTags: row.allowed_tags ?? [],
    active: row.active
  };
}

function toHandler(row: HandlerDbRow): QuoteHandlerRow {
  return {
    customerId: row.customer_id,
    email: normalizeEmail(row.user_email),
    assignedBy: row.assigned_by ?? '',
    assignedAt: dateString(row.assigned_at)
  };
}

function toCase(row: CaseDbRow): QuoteCaseRow {
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

function toQuote(row: QuoteDbRow): QuoteRow {
  return {
    quoteNo: row.quote_no,
    rev: Number(row.rev),
    caseId: row.case_id ?? '',
    customerId: row.customer_id,
    title: row.title,
    source: row.source,
    fileName: row.file_name ?? '',
    uploadMimeType: row.upload_mime_type ?? '',
    uploadDataB64: row.upload_data_b64 ?? '',
    templateId: row.template_id ?? '',
    templateName: row.template_name ?? '',
    status: row.status,
    subtotal: numberOrBlank(row.subtotal),
    taxPct: numberOrBlank(row.tax_pct),
    taxAmount: numberOrBlank(row.tax_amount),
    total: numberOrBlank(row.total),
    currency: row.currency,
    validUntil: dateOnly(row.valid_until),
    notes: row.notes ?? '',
    doc: row.doc_link ?? '',
    pdf: row.pdf_link ?? '',
    driveFileId: row.drive_file_id ?? '',
    driveViewLink: row.drive_view_link ?? '',
    driveSavedAt: dateString(row.drive_saved_at),
    driveSavedBy: normalizeEmail(row.drive_saved_by ?? ''),
    createdBy: normalizeEmail(row.created_by),
    createdAt: dateString(row.created_at),
    updatedAt: dateString(row.updated_at)
  };
}

function toBoqBlock(row: BoqDbRow): QuoteBoqBlock {
  return {
    quoteNo: row.quote_no,
    rev: Number(row.rev),
    block: Number(row.block),
    title: row.title ?? '',
    headers: jsonArray(row.headers),
    rows: jsonRows(row.rows)
  };
}

function dbOutcome(value: QuoteCaseRow['outcome']): 'Won' | 'Lost' | 'Hold' | null {
  return value || null;
}

function quoteFamilyLockKey(quoteNo: string): string {
  return `quote-family:${quoteNo.trim().toUpperCase()}`;
}

export class PostgresQuoteRepository implements QuoteRepository {
  constructor(private readonly db: DbExecutor = sql) {}

  async withTransaction<T>(fn: (repo?: QuoteRepository) => Promise<T>): Promise<T> {
    return withTransaction((tx) => fn(new PostgresQuoteRepository(tx)));
  }

  async lockQuoteFamily(quoteNo: string): Promise<void> {
    await this.db`select pg_advisory_xact_lock(hashtext(${quoteFamilyLockKey(quoteNo)}))`;
  }

  async nextQuoteNo(): Promise<string> {
    const format = CRM_ID_FORMATS.quotations;
    return nextCrmId(this.db, format.key, format.prefix, format.width, new Date().getFullYear());
  }

  async nextCaseId(): Promise<string> {
    const format = CRM_ID_FORMATS.cases;
    return nextCrmId(this.db, format.key, format.prefix, format.width, new Date().getFullYear());
  }

  async listContacts(customerId: string): Promise<Array<{ name: string; designation: string }>> {
    const rows = (await this.db`
      select name, designation
      from public.contacts
      where customer_id = ${customerId}
      order by name asc
    `) as Array<{ name: string; designation: string | null }>;

    return rows.map((row) => ({ name: row.name, designation: row.designation ?? '' }));
  }

  async getCustomer(id: string): Promise<QuoteCustomerRow | null> {
    const rows = (await this.db`
      select customer_id, name, tags, type, priority, area, address, gstin, website, notes,
             sei, remarks, status, created_by, created_at, updated_at
      from public.customers
      where customer_id = ${id}
      limit 1
    `) as CustomerDbRow[];

    return rows[0] ? toCustomer(rows[0]) : null;
  }

  async listUsers(): Promise<QuoteUserRow[]> {
    const rows = (await this.db`
      select email, name, role, allowed_tags, active
      from public.users
    `) as UserDbRow[];

    return rows.map(toUser);
  }

  async listHandlers(): Promise<QuoteHandlerRow[]> {
    const rows = (await this.db`
      select customer_id, user_email, assigned_by, assigned_at
      from public.handlers
    `) as HandlerDbRow[];

    return rows.map(toHandler);
  }

  async getCase(id: string): Promise<QuoteCaseRow | null> {
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

  async createCase(row: QuoteCaseRow): Promise<void> {
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

  async updateCase(id: string, fields: Partial<QuoteCaseRow>): Promise<void> {
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

  async getQuote(quoteNo: string, rev: number): Promise<QuoteRow | null> {
    const rows = (await this.db`
      select quote_no, rev, case_id, customer_id, title, source, file_name,
             upload_mime_type, coalesce(encode(upload_data, 'base64'), '') as upload_data_b64,
             template_id,
             template_name, status, subtotal, tax_pct, tax_amount, total, currency,
             valid_until, notes, doc_link, pdf_link, drive_file_id, drive_view_link,
             drive_saved_at, drive_saved_by, created_by, created_at, updated_at
      from public.quotations
      where quote_no = ${quoteNo}
        and rev = ${rev}
      limit 1
    `) as QuoteDbRow[];

    return rows[0] ? toQuote(rows[0]) : null;
  }

  async listQuotesByQuoteNo(quoteNo: string): Promise<QuoteRow[]> {
    const rows = (await this.db`
      select quote_no, rev, case_id, customer_id, title, source, file_name,
             upload_mime_type, coalesce(encode(upload_data, 'base64'), '') as upload_data_b64,
             template_id,
             template_name, status, subtotal, tax_pct, tax_amount, total, currency,
             valid_until, notes, doc_link, pdf_link, drive_file_id, drive_view_link,
             drive_saved_at, drive_saved_by, created_by, created_at, updated_at
      from public.quotations
      where quote_no = ${quoteNo}
    `) as QuoteDbRow[];

    return rows.map(toQuote);
  }

  async createQuote(row: QuoteRow): Promise<void> {
    await this.db`
      insert into public.quotations (
        quote_no, rev, case_id, customer_id, title, source, file_name, upload_mime_type,
        upload_data, template_id, template_name, status, subtotal, tax_pct, tax_amount, total, currency,
        valid_until, notes, doc_link, pdf_link, drive_file_id, drive_view_link, drive_saved_at,
        drive_saved_by, created_by, created_at, updated_at
      )
      values (
        ${row.quoteNo}, ${row.rev}, ${row.caseId || null}, ${row.customerId}, ${row.title}, ${row.source},
        ${row.fileName}, ${row.uploadMimeType}, ${dbBytes(row.uploadDataB64)},
        ${row.templateId}, ${row.templateName}, ${row.status}, ${dbNumber(row.subtotal)},
        ${dbNumber(row.taxPct)}, ${dbNumber(row.taxAmount)}, ${dbNumber(row.total)}, ${row.currency},
        ${dbDate(row.validUntil)}, ${row.notes}, ${row.doc}, ${row.pdf},
        ${row.driveFileId}, ${row.driveViewLink}, ${row.driveSavedAt || null},
        ${row.driveSavedBy ? normalizeEmail(row.driveSavedBy) : null}, ${dbEmail(row.createdBy)},
        ${row.createdAt}, ${row.updatedAt}
      )
    `;
  }

  async updateQuote(quoteNo: string, rev: number, fields: Partial<QuoteRow>): Promise<void> {
    const existing = await this.getQuote(quoteNo, rev);
    if (!existing) throw new Error(`Quotation ${quoteNo} R${rev} was not found.`);
    const row = { ...existing, ...fields };
    await this.db`
      update public.quotations
      set
        case_id = ${row.caseId || null},
        customer_id = ${row.customerId},
        title = ${row.title},
        source = ${row.source},
        file_name = ${row.fileName},
        upload_mime_type = ${row.uploadMimeType},
        upload_data = ${dbBytes(row.uploadDataB64)},
        template_id = ${row.templateId},
        template_name = ${row.templateName},
        status = ${row.status},
        subtotal = ${dbNumber(row.subtotal)},
        tax_pct = ${dbNumber(row.taxPct)},
        tax_amount = ${dbNumber(row.taxAmount)},
        total = ${dbNumber(row.total)},
        currency = ${row.currency},
        valid_until = ${dbDate(row.validUntil)},
        notes = ${row.notes},
        doc_link = ${row.doc},
        pdf_link = ${row.pdf},
        drive_file_id = ${row.driveFileId},
        drive_view_link = ${row.driveViewLink},
        drive_saved_at = ${row.driveSavedAt || null},
        drive_saved_by = ${row.driveSavedBy ? normalizeEmail(row.driveSavedBy) : null},
        updated_at = ${row.updatedAt}
      where quote_no = ${quoteNo}
        and rev = ${rev}
    `;
  }

  async createBoqBlocks(quoteNo: string, rev: number, blocks: QuoteBoqBlock[]): Promise<void> {
    await this.db`
      delete from public.quote_boq
      where quote_no = ${quoteNo}
        and rev = ${rev}
    `;

    for (const block of blocks) {
      await this.db`
        insert into public.quote_boq (quote_no, rev, block, title, headers, rows)
        values (
          ${quoteNo}, ${rev}, ${block.block}, ${block.title},
          ${JSON.stringify(block.headers)}::jsonb,
          ${JSON.stringify(block.rows)}::jsonb
        )
      `;
    }
  }

  async listBoqBlocks(quoteNo: string, rev: number): Promise<QuoteBoqBlock[]> {
    const rows = (await this.db`
      select quote_no, rev, block, title, headers, rows
      from public.quote_boq
      where quote_no = ${quoteNo}
        and rev = ${rev}
      order by block asc
    `) as BoqDbRow[];

    return rows.map(toBoqBlock);
  }

  async logActivity(entry: QuoteActivityLogEntry): Promise<void> {
    await this.db`
      insert into public.activity_log (who, action, entity, customer_id, details)
      values (${entry.who}, ${entry.action}, ${entry.entity}, ${entry.customerId || null}, ${entry.details})
    `;
  }
}

export const quoteRepository = new PostgresQuoteRepository();
