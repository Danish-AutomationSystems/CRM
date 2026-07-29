import type { CrmContext } from '../auth/context';
import { ensureFull } from '../auth/access';
import type { CrmRole } from '../db/schema';
import { DEFAULT_SETTINGS } from '../settings/defaults';
import { normalizeEmail } from '../domain/lists';
import { renderQuoteHtml, safeQuoteFileName, type QuoteDownloadArtifact } from './render';

export type QuoteCustomerRow = {
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

export type QuoteCaseRow = {
  id: string;
  customerId: string;
  title: string;
  details: string;
  source: string;
  stage: string;
  outcome: '' | 'Won' | 'Lost' | 'Hold';
  orderValue: number | '';
  wonCategories: string[];
  outcomeNote: string;
  owner: string;
  extraOwners: string[];
  assignee: string;
  closedOn: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
};

export type QuoteUserRow = {
  email: string;
  name: string;
  role: CrmRole;
  allowedTags: string[];
  active: boolean;
};

export type QuoteHandlerRow = {
  customerId: string;
  email: string;
  assignedBy: string;
  assignedAt: string;
};

export type QuoteRow = {
  quoteNo: string;
  rev: number;
  caseId: string;
  customerId: string;
  title: string;
  source: 'Generated' | 'External';
  fileName: string;
  templateId: string;
  templateName: string;
  status: 'Draft' | 'Sent' | 'Superseded';
  subtotal: number | '';
  taxPct: number | '';
  taxAmount: number | '';
  total: number | '';
  currency: string;
  validUntil: string;
  notes: string;
  doc: string;
  pdf: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
};

export type QuoteBoqBlock = {
  quoteNo: string;
  rev: number;
  block: number;
  title: string;
  headers: string[];
  rows: string[][];
};

export type QuoteActivityLogEntry = {
  action: string;
  entity: string;
  customerId: string;
  details: string;
  who: string;
};

export type QuoteRepository = {
  withTransaction<T>(fn: (repo?: QuoteRepository) => Promise<T>): Promise<T>;
  nextQuoteNo(): Promise<string>;
  nextCaseId(): Promise<string>;
  listTemplates(): Promise<Array<{ id: string; name: string }>>;
  getCustomer(id: string): Promise<QuoteCustomerRow | null>;
  listUsers(): Promise<QuoteUserRow[]>;
  listHandlers(): Promise<QuoteHandlerRow[]>;
  getCase(id: string): Promise<QuoteCaseRow | null>;
  createCase(row: QuoteCaseRow): Promise<void>;
  updateCase(id: string, fields: Partial<QuoteCaseRow>): Promise<void>;
  getQuote(quoteNo: string, rev: number): Promise<QuoteRow | null>;
  listQuotesByQuoteNo(quoteNo: string): Promise<QuoteRow[]>;
  createQuote(row: QuoteRow): Promise<void>;
  updateQuote(quoteNo: string, rev: number, fields: Partial<QuoteRow>): Promise<void>;
  createBoqBlocks(quoteNo: string, rev: number, blocks: QuoteBoqBlock[]): Promise<void>;
  listBoqBlocks(quoteNo: string, rev: number): Promise<QuoteBoqBlock[]>;
  logActivity(entry: QuoteActivityLogEntry): Promise<void>;
};

export type CreateQuotationInput = Partial<{
  customerId: unknown;
  caseId: unknown;
  baseQuoteNo: unknown;
  title: unknown;
  templateId: unknown;
  subtotal: unknown;
  taxPct: unknown;
  currency: unknown;
  validUntil: unknown;
  notes: unknown;
  blocks: unknown;
}>;

export type UploadQuotationInput = Partial<{
  customerId: unknown;
  caseId: unknown;
  baseQuoteNo: unknown;
  title: unknown;
  fileName: unknown;
  mimeType: unknown;
  dataB64: unknown;
  total: unknown;
  currency: unknown;
  status: unknown;
  validUntil: unknown;
  notes: unknown;
}>;

type Ownership = {
  handlerEmailsByCustomerId: Record<string, string[]>;
};

type LoadedQuote = {
  quote: QuoteRow;
  customer: QuoteCustomerRow;
};

function nowIso(): string {
  return new Date().toISOString();
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
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

function roundedMoney(value: number): number {
  return Math.round(value * 100) / 100;
}

function nonnegativeNumber(value: unknown, fallback = 0): number {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric < 0) return fallback;
  return roundedMoney(numeric);
}

function taxPercent(value: unknown): number {
  if (value === '' || value === undefined || value === null) return DEFAULT_SETTINGS.TAX_PCT;
  return nonnegativeNumber(value, 0);
}

function quoteStatus(value: unknown, fallback: 'Draft' | 'Sent'): 'Draft' | 'Sent' {
  const text = asText(value);
  return text === 'Draft' || text === 'Sent' ? text : fallback;
}

function ownershipFor(handlers: readonly QuoteHandlerRow[]): Ownership {
  return {
    handlerEmailsByCustomerId: handlers.reduce<Record<string, string[]>>((map, handler) => {
      const email = normalizeEmail(handler.email);
      (map[handler.customerId] = map[handler.customerId] ?? []).push(email);
      return map;
    }, {})
  };
}

function customerForAccess(customer: QuoteCustomerRow) {
  return {
    id: customer.id,
    name: customer.name,
    tags: customer.tags,
    type: customer.type
  };
}

function userIndex(users: readonly QuoteUserRow[]): Record<string, QuoteUserRow> {
  return users.reduce<Record<string, QuoteUserRow>>((index, user) => {
    index[normalizeEmail(user.email)] = { ...user, email: normalizeEmail(user.email) };
    return index;
  }, {});
}

function nameOf(users: Record<string, QuoteUserRow>, email: string): string {
  return users[normalizeEmail(email)]?.name || email;
}

async function ensureFullCustomer(
  repo: QuoteRepository,
  user: CrmContext,
  customerId: string
): Promise<{ customer: QuoteCustomerRow; ownership: Ownership }> {
  const customer = await repo.getCustomer(customerId);
  if (!customer) throw new Error(`Customer ${customerId} was not found.`);
  const ownership = ownershipFor(await repo.listHandlers());
  ensureFull(user, customerForAccess(customer), ownership);
  return { customer, ownership };
}

async function validateCase(repo: QuoteRepository, caseId: string, customerId: string): Promise<QuoteCaseRow | null> {
  if (!caseId) return null;
  const row = await repo.getCase(caseId);
  if (!row) throw new Error(`Case ${caseId} was not found.`);
  if (row.customerId !== customerId) throw new Error('That case belongs to a different customer.');
  return row;
}

function cleanBoqBlocks(input: unknown): Array<Omit<QuoteBoqBlock, 'quoteNo' | 'rev' | 'block'>> {
  const blocks = Array.isArray(input) ? input : [];
  const cleaned = blocks
    .map((raw) => {
      const value = raw as { title?: unknown; headers?: unknown; rows?: unknown };
      const headers = (Array.isArray(value.headers) ? value.headers : [])
        .map((header) => asText(header))
        .filter((header, index, all) => index < all.length);
      while (headers.length && headers[headers.length - 1] === '') headers.pop();
      if (!headers.length) return null;

      const rows = (Array.isArray(value.rows) ? value.rows : [])
        .map((row) =>
          Array.from({ length: headers.length }, (_, index) =>
            String((Array.isArray(row) ? row[index] : undefined) ?? '')
          )
        )
        .filter((row) => row.join('').trim() !== '');

      return {
        title: asText(value.title),
        headers,
        rows
      };
    })
    .filter((block): block is Omit<QuoteBoqBlock, 'quoteNo' | 'rev' | 'block'> => Boolean(block));

  if (!cleaned.length) {
    throw new Error('Paste at least one BOQ table (the first pasted row is treated as the column headers).');
  }

  return cleaned;
}

function quoteDownloadUrl(quoteNo: string, rev: number, format = 'html'): string {
  const suffix = format ? `?format=${encodeURIComponent(format)}` : '';
  return `/api/download/quote/${encodeURIComponent(quoteNo)}/${rev}${suffix}`;
}

function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function activeRevisions(quotes: readonly QuoteRow[]): QuoteRow[] {
  return quotes.filter((quote) => quote.status === 'Draft' || quote.status === 'Sent');
}

function nextRevision(quotes: readonly QuoteRow[]): number {
  return quotes.reduce((max, quote) => Math.max(max, quote.rev), -1) + 1;
}

async function allocateQuoteRevision(
  repo: QuoteRepository,
  input: { baseQuoteNo: string; caseId: string }
): Promise<{ quoteNo: string; rev: number; caseId: string; previous: QuoteRow[] }> {
  if (!input.baseQuoteNo) {
    return { quoteNo: await repo.nextQuoteNo(), rev: 0, caseId: input.caseId, previous: [] };
  }

  const previous = await repo.listQuotesByQuoteNo(input.baseQuoteNo);
  if (!previous.length) throw new Error(`Quotation ${input.baseQuoteNo} was not found.`);
  const caseId = input.caseId || previous[0].caseId;
  return { quoteNo: input.baseQuoteNo, rev: nextRevision(previous), caseId, previous };
}

async function supersedePrevious(repo: QuoteRepository, previous: readonly QuoteRow[]): Promise<void> {
  for (const quote of activeRevisions(previous)) {
    await repo.updateQuote(quote.quoteNo, quote.rev, { status: 'Superseded', updatedAt: nowIso() });
  }
}

async function createAutoCase(
  repo: QuoteRepository,
  user: CrmContext,
  customer: QuoteCustomerRow,
  title: string,
  quoteNo: string,
  stage: string,
  detailPrefix: string
): Promise<string> {
  const id = await repo.nextCaseId();
  const now = nowIso();
  await repo.createCase({
    id,
    customerId: customer.id,
    title,
    details: `${detailPrefix} ${quoteNo}`,
    source: 'Sales Team',
    stage,
    outcome: '',
    orderValue: '',
    wonCategories: [],
    outcomeNote: '',
    owner: normalizeEmail(user.email),
    extraOwners: [],
    assignee: normalizeEmail(user.email),
    closedOn: '',
    createdBy: normalizeEmail(user.email),
    createdAt: now,
    updatedAt: now
  });
  await repo.logActivity({
    action: 'CASE_NEW',
    entity: id,
    customerId: customer.id,
    details: `Auto-created for ${quoteNo}`,
    who: normalizeEmail(user.email)
  });
  return id;
}

async function bumpCaseToQuoted(repo: QuoteRepository, caseId: string): Promise<void> {
  const row = await repo.getCase(caseId);
  if (!row || row.outcome || row.stage === 'Quoted') return;
  await repo.updateCase(caseId, { stage: 'Quoted', updatedAt: nowIso() });
}

async function loadQuote(repo: QuoteRepository, user: CrmContext, quoteNo: string, rev: number): Promise<LoadedQuote> {
  const quote = await repo.getQuote(quoteNo, rev);
  if (!quote) throw new Error(`Quotation ${quoteNo} R${rev} was not found.`);
  const customer = await repo.getCustomer(quote.customerId);
  if (!customer) throw new Error(`Customer ${quote.customerId} was not found.`);
  const ownership = ownershipFor(await repo.listHandlers());
  ensureFull(user, customerForAccess(customer), ownership);
  return { quote, customer };
}

function externalArtifact(quote: QuoteRow, customer: QuoteCustomerRow): QuoteDownloadArtifact {
  return {
    fileName: safeQuoteFileName(quote.quoteNo, quote.rev, customer.name),
    mimeType: 'text/html; charset=utf-8',
    body: `<!doctype html><html><body><h1>${escapeHtml(quote.quoteNo)} R${quote.rev}</h1><p>External quotation: ${escapeHtml(quote.fileName || 'quotation')}</p></body></html>`
  };
}

export function createQuoteService(repo: QuoteRepository) {
  return {
    async listTemplates(_user: CrmContext) {
      return (await repo.listTemplates()).sort((a, b) => a.name.localeCompare(b.name));
    },

    async createQuotation(user: CrmContext, input: CreateQuotationInput) {
      requireLevel(user, 2);
      const customerId = asText(input.customerId);
      const { customer } = await ensureFullCustomer(repo, user, customerId);
      const blocks = cleanBoqBlocks(input.blocks);
      const subtotal = nonnegativeNumber(input.subtotal, 0);
      const taxPct = taxPercent(input.taxPct);
      const taxAmount = roundedMoney((subtotal * taxPct) / 100);
      const total = roundedMoney(subtotal + taxAmount);
      const currency = asText(input.currency) || DEFAULT_SETTINGS.CURRENCY;
      const title = asText(input.title) || `Quotation for ${customer.name}`;
      const templates = await repo.listTemplates();
      const templateId = asText(input.templateId);
      const templateName = templates.find((template) => template.id === templateId)?.name ?? '';

      return repo.withTransaction(async (tx) => {
        const trx = tx ?? repo;
        let caseId = asText(input.caseId);
        await validateCase(trx, caseId, customer.id);
        const allocation = await allocateQuoteRevision(trx, {
          baseQuoteNo: asText(input.baseQuoteNo),
          caseId
        });
        caseId = allocation.caseId;
        if (caseId) await validateCase(trx, caseId, customer.id);
        await supersedePrevious(trx, allocation.previous);
        if (!caseId) {
          caseId = await createAutoCase(trx, user, customer, title, allocation.quoteNo, 'Opportunity', 'Auto-created with quotation');
        }

        const now = nowIso();
        await trx.createQuote({
          quoteNo: allocation.quoteNo,
          rev: allocation.rev,
          caseId,
          customerId: customer.id,
          title,
          source: 'Generated',
          fileName: '',
          templateId,
          templateName,
          status: 'Draft',
          subtotal,
          taxPct,
          taxAmount,
          total,
          currency,
          validUntil: asText(input.validUntil),
          notes: String(input.notes ?? ''),
          doc: '',
          pdf: '',
          createdBy: normalizeEmail(user.email),
          createdAt: now,
          updatedAt: now
        });
        await trx.createBoqBlocks(
          allocation.quoteNo,
          allocation.rev,
          blocks.map((block, index) => ({
            quoteNo: allocation.quoteNo,
            rev: allocation.rev,
            block: index + 1,
            ...block
          }))
        );
        await trx.logActivity({
          action: 'QUOTE_NEW',
          entity: `${allocation.quoteNo} R${allocation.rev}`,
          customerId: customer.id,
          details: `${title} - ${currency} ${total}`,
          who: normalizeEmail(user.email)
        });
        return { quoteNo: allocation.quoteNo, rev: allocation.rev, caseId };
      });
    },

    async uploadQuotation(user: CrmContext, input: UploadQuotationInput) {
      requireLevel(user, 2);
      const customerId = asText(input.customerId);
      const { customer } = await ensureFullCustomer(repo, user, customerId);
      const dataB64 = String(input.dataB64 ?? '');
      if (!dataB64) throw new Error('Choose a file to upload.');
      if (dataB64.length > 11_000_000) throw new Error('That file is too large - please keep uploads under about 8 MB.');

      const title = asText(input.title) || `Quotation for ${customer.name}`;
      const status = quoteStatus(input.status, 'Sent');
      const total = nonnegativeNumber(input.total, 0);
      const currency = asText(input.currency) || DEFAULT_SETTINGS.CURRENCY;

      return repo.withTransaction(async (tx) => {
        const trx = tx ?? repo;
        let caseId = asText(input.caseId);
        await validateCase(trx, caseId, customer.id);
        const allocation = await allocateQuoteRevision(trx, {
          baseQuoteNo: asText(input.baseQuoteNo),
          caseId
        });
        caseId = allocation.caseId;
        if (caseId) await validateCase(trx, caseId, customer.id);
        await supersedePrevious(trx, allocation.previous);
        if (!caseId) {
          caseId = await createAutoCase(
            trx,
            user,
            customer,
            title,
            allocation.quoteNo,
            status === 'Sent' ? 'Quoted' : 'Opportunity',
            'Auto-created with uploaded quotation'
          );
        }

        const downloadUrl = quoteDownloadUrl(allocation.quoteNo, allocation.rev, '');
        const now = nowIso();
        await trx.createQuote({
          quoteNo: allocation.quoteNo,
          rev: allocation.rev,
          caseId,
          customerId: customer.id,
          title,
          source: 'External',
          fileName: asText(input.fileName) || 'quotation',
          templateId: '',
          templateName: '',
          status,
          subtotal: '',
          taxPct: '',
          taxAmount: '',
          total,
          currency,
          validUntil: asText(input.validUntil),
          notes: String(input.notes ?? ''),
          doc: '',
          pdf: downloadUrl,
          createdBy: normalizeEmail(user.email),
          createdAt: now,
          updatedAt: now
        });
        await trx.logActivity({
          action: 'QUOTE_UPLOAD',
          entity: `${allocation.quoteNo} R${allocation.rev}`,
          customerId: customer.id,
          details: `${title} - ${currency} ${total}`,
          who: normalizeEmail(user.email)
        });
        if (caseId && status === 'Sent') await bumpCaseToQuoted(trx, caseId);
        return { quoteNo: allocation.quoteNo, rev: allocation.rev, caseId };
      });
    },

    async getQuotation(user: CrmContext, quoteNo: string, rev: number) {
      const { quote, customer } = await loadQuote(repo, user, quoteNo, rev);
      const [blocks, revisions, users] = await Promise.all([
        quote.source === 'Generated' ? repo.listBoqBlocks(quoteNo, rev) : Promise.resolve([]),
        repo.listQuotesByQuoteNo(quoteNo),
        repo.listUsers()
      ]);
      const idx = userIndex(users);

      return {
        quote: {
          quoteNo: quote.quoteNo,
          rev: quote.rev,
          caseId: quote.caseId,
          title: quote.title,
          source: quote.source,
          fileName: quote.fileName,
          templateId: quote.templateId,
          templateName: quote.templateName,
          status: quote.status,
          subtotal: quote.subtotal,
          taxPct: quote.taxPct,
          taxAmount: quote.taxAmount,
          total: quote.total,
          currency: quote.currency,
          validUntil: quote.validUntil,
          notes: quote.notes,
          doc: quote.doc,
          pdf: quote.pdf,
          by: nameOf(idx, quote.createdBy),
          date: quote.createdAt
        },
        customer: { id: customer.id, name: customer.name },
        blocks,
        revisions: revisions
          .map((row) => ({ rev: row.rev, status: row.status, date: row.createdAt, total: row.total }))
          .sort((a, b) => b.rev - a.rev)
      };
    },

    async setQuoteStatus(user: CrmContext, quoteNo: string, rev: number, statusInput: unknown) {
      const status = asText(statusInput);
      if (!(DEFAULT_SETTINGS.QUOTE_STATUSES as readonly string[]).includes(status)) {
        throw new Error(`"${status}" is not a valid quotation status.`);
      }
      const { quote } = await loadQuote(repo, user, quoteNo, rev);
      await repo.withTransaction(async (tx) => {
        const trx = tx ?? repo;
        await trx.updateQuote(quoteNo, rev, { status: status as QuoteRow['status'], updatedAt: nowIso() });
        await trx.logActivity({
          action: 'QUOTE_STATUS',
          entity: `${quoteNo} R${rev}`,
          customerId: quote.customerId,
          details: status,
          who: normalizeEmail(user.email)
        });
        if (status === 'Sent' && quote.caseId) await bumpCaseToQuoted(trx, quote.caseId);
        return undefined;
      });
      return { ok: true };
    },

    async generateQuoteDoc(user: CrmContext, quoteNo: string, rev: number) {
      const { quote, customer } = await loadQuote(repo, user, quoteNo, rev);
      if (quote.source === 'External') {
        throw new Error('This quotation was uploaded as an external file - there is no template to generate from.');
      }
      if (!quote.templateId) throw new Error('This quotation has no template selected. Create a revision and pick a template.');

      const fileName = safeQuoteFileName(quote.quoteNo, quote.rev, customer.name);
      const url = quoteDownloadUrl(quote.quoteNo, quote.rev);
      const metadata = { fileName, mimeType: 'text/html; charset=utf-8', url };

      await repo.updateQuote(quote.quoteNo, quote.rev, { doc: url, pdf: url, updatedAt: nowIso() });
      await repo.logActivity({
        action: 'QUOTE_PDF',
        entity: `${quoteNo} R${rev}`,
        customerId: quote.customerId,
        details: fileName,
        who: normalizeEmail(user.email)
      });

      return { doc: metadata, pdf: metadata };
    },

    async getDownloadArtifact(user: CrmContext, quoteNo: string, rev: number): Promise<QuoteDownloadArtifact> {
      const { quote, customer } = await loadQuote(repo, user, quoteNo, rev);
      if (quote.source === 'External') return externalArtifact(quote, customer);

      const [blocks, users] = await Promise.all([repo.listBoqBlocks(quoteNo, rev), repo.listUsers()]);
      const idx = userIndex(users);
      return {
        fileName: safeQuoteFileName(quote.quoteNo, quote.rev, customer.name),
        mimeType: 'text/html; charset=utf-8',
        body: renderQuoteHtml({
          company: DEFAULT_SETTINGS.COMPANY,
          preparedBy: `${nameOf(idx, quote.createdBy)} (${normalizeEmail(quote.createdBy)})`,
          generatedOn: today(),
          quote,
          customer: {
            name: customer.name,
            address: customer.address,
            area: customer.area
          },
          contact: null,
          blocks
        })
      };
    }
  };
}

export type QuoteService = ReturnType<typeof createQuoteService>;
