import type { CrmContext } from '../auth/context';
import { ensureFull } from '../auth/access';
import type { CrmRole } from '../db/schema';
import { DEFAULT_SETTINGS } from '../settings/defaults';
import { loadSettings } from '../settings/live';
import { normalizeEmail } from '../domain/lists';
import { renderQuoteHtml, safeQuoteFileName, type QuoteDownloadArtifact } from './render';
import type { DriveClient } from '../drive/client';
import type { DocsClient } from '../drive/docs';
import {
  buildCellFillRequests,
  buildMergeFieldRequests,
  buildStructureRequests,
  collectTables,
  locateMarker
} from '../drive/template-merge';

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
  sei: string[];
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
  priority: string;
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
  uploadMimeType: string;
  uploadDataB64: string;
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
  driveFileId: string;
  driveViewLink: string;
  driveSavedAt: string;
  driveSavedBy: string;
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
  listSettings(): Promise<Array<{ key: string; value: string }>>;
  lockQuoteFamily(quoteNo: string): Promise<void>;
  nextQuoteNo(): Promise<string>;
  nextCaseId(): Promise<string>;
  listContacts(customerId: string): Promise<Array<{ name: string; designation: string }>>;
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

function fmtMoney(value: number | ''): string {
  return Number(value || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
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

function taxPercent(value: unknown, fallback: number = DEFAULT_SETTINGS.TAX_PCT): number {
  if (value === '' || value === undefined || value === null) return fallback;
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

function cleanUploadFileName(value: unknown): string {
  const fileName = asText(value)
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 160);
  return fileName || 'quotation';
}

function cleanMimeType(value: unknown): string {
  const text = asText(value).toLowerCase();
  return /^[a-z0-9][a-z0-9.+-]*\/[a-z0-9][a-z0-9.+-]*$/i.test(text) ? text : 'application/octet-stream';
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

  await repo.lockQuoteFamily(input.baseQuoteNo);
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
    priority: '',
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

function externalArtifact(quote: QuoteRow): QuoteDownloadArtifact {
  if (quote.uploadDataB64) {
    return {
      fileName: cleanUploadFileName(quote.fileName),
      mimeType: cleanMimeType(quote.uploadMimeType),
      body: Buffer.from(quote.uploadDataB64, 'base64')
    };
  }

  throw new Error('This quotation is stored in Google Drive - use the "View in Drive" link to open it.');
}

export type QuoteServiceDeps = {
  listTemplates?: () => Promise<Array<{ id: string; name: string }>>;
  getDriveClient?: () => DriveClient;
  getDocsClient?: () => DocsClient;
  getQuotationsFolderId?: () => Promise<string>;
};

export function createQuoteService(repo: QuoteRepository, deps: QuoteServiceDeps = {}) {
  async function loadTemplates(): Promise<Array<{ id: string; name: string }>> {
    if (!deps.listTemplates) return [];
    return deps.listTemplates();
  }

  return {
    async listTemplates(_user: CrmContext) {
      return (await loadTemplates()).sort((a, b) => a.name.localeCompare(b.name));
    },

    async createQuotation(user: CrmContext, input: CreateQuotationInput) {
      requireLevel(user, 2);
      const customerId = asText(input.customerId);
      const { customer } = await ensureFullCustomer(repo, user, customerId);
      // Fallback only - the client always sends live tax/currency values from
      // bootstrap(), so these matter only when the client omits them.
      const live = await loadSettings(repo);
      const blocks = cleanBoqBlocks(input.blocks);
      const subtotal = nonnegativeNumber(input.subtotal, 0);
      const taxPct = taxPercent(input.taxPct, live.taxPct);
      const taxAmount = roundedMoney((subtotal * taxPct) / 100);
      const total = roundedMoney(subtotal + taxAmount);
      const currency = asText(input.currency) || live.currency;
      const title = asText(input.title) || `Quotation for ${customer.name}`;
      const templates = await loadTemplates();
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
          uploadMimeType: '',
          uploadDataB64: '',
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
          driveFileId: '',
          driveViewLink: '',
          driveSavedAt: '',
          driveSavedBy: '',
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
      if (!deps.getDriveClient || !deps.getQuotationsFolderId) {
        throw new Error('Google Drive is not configured. Run the one-time Drive setup first.');
      }

      const title = asText(input.title) || `Quotation for ${customer.name}`;
      const status = quoteStatus(input.status, 'Sent');
      const total = nonnegativeNumber(input.total, 0);
      // Fallback only - the client always sends a live currency from bootstrap().
      const currency = asText(input.currency) || (await loadSettings(repo)).currency;
      const fileName = cleanUploadFileName(input.fileName);
      const uploadMimeType = cleanMimeType(input.mimeType);

      const folderId = await deps.getQuotationsFolderId();
      const drive = deps.getDriveClient();
      const uploaded = await drive.uploadFile(
        {
          fileName: `${customer.name} - ${fileName}`,
          mimeType: uploadMimeType,
          body: Buffer.from(dataB64, 'base64')
        },
        folderId
      );

      if (!uploaded.id) throw new Error('Drive did not return a file id.');
      // Drive normally returns webViewLink, but the field is optional in the API
      // response. An empty link would commit a row whose file is unreachable from
      // the UI. The canonical view URL is fully derivable from the id, so fall
      // back to it rather than discarding a file that uploaded successfully.
      const driveViewLink = uploaded.webViewLink || `https://drive.google.com/file/d/${uploaded.id}/view`;

      let committed: { quoteNo: string; rev: number; caseId: string };
      try {
        committed = await repo.withTransaction(async (tx) => {
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

          const now = nowIso();
          await trx.createQuote({
            quoteNo: allocation.quoteNo,
            rev: allocation.rev,
            caseId,
            customerId: customer.id,
            title,
            source: 'External',
            fileName,
            uploadMimeType,
            uploadDataB64: '',
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
            pdf: '',
            driveFileId: uploaded.id,
            driveViewLink,
            driveSavedAt: now,
            driveSavedBy: normalizeEmail(user.email),
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
      } catch (error) {
        // The database rolled back, so the Drive file is now unreferenced.
        // Best effort only: if this delete also fails we still surface the
        // original database error, because that is the one the user needs.
        try {
          await drive.deleteFile(uploaded.id);
        } catch (cleanupError) {
          // Leaves one orphan file in the folder. No data loss, no database
          // impact. Identifiable by its missing "<quoteNo> R<rev>" prefix.
          console.error('Drive orphan cleanup failed:', uploaded.id, cleanupError);
        }
        throw error;
      }

      // Cosmetic only - the row and the link are already correct, so a rename
      // failure must not fail an otherwise complete upload.
      try {
        await drive.renameFile(
          uploaded.id,
          `${committed.quoteNo} R${committed.rev} - ${customer.name} - ${fileName}`
        );
      } catch (renameError) {
        // Cosmetic only: the row and the link are already correct, so the upload
        // still succeeds. Logged so a file left under its provisional name is
        // distinguishable from an orphan of a rolled-back transaction.
        console.error(
          'Drive post-commit rename failed:',
          uploaded.id,
          `${committed.quoteNo} R${committed.rev}`,
          renameError
        );
      }

      return committed;
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
          driveViewLink: quote.driveViewLink,
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
      if (!deps.getDriveClient || !deps.getDocsClient || !deps.getQuotationsFolderId) {
        throw new Error('Google Drive is not configured. Run the one-time Drive setup first.');
      }

      const [blocks, contacts, users, live] = await Promise.all([
        repo.listBoqBlocks(quoteNo, rev),
        repo.listContacts(quote.customerId),
        repo.listUsers(),
        loadSettings(repo)
      ]);
      const idx = userIndex(users);
      const contact = contacts[0];
      const baseName = `${quoteNo}-R${rev} - ${customer.name}`;

      const drive = deps.getDriveClient();
      const docsClient = deps.getDocsClient();
      const folderId = await deps.getQuotationsFolderId();

      // 1. Copy the template into the quotations folder.
      const copy = await drive.copyFile(quote.templateId, baseName, folderId);

      // 2. Merge every scalar placeholder (matches legacy Code.gs:1808-1826).
      await docsClient.batchUpdate(
        copy.id,
        buildMergeFieldRequests({
          '{{QUOTE_NO}}': quote.quoteNo,
          '{{REV}}': `R${quote.rev}`,
          '{{DATE}}': today(),
          '{{CUSTOMER_NAME}}': customer.name,
          '{{CUSTOMER_ADDRESS}}': [customer.address, customer.area].filter((part) => part.trim()).join(', '),
          '{{CONTACT_NAME}}': contact ? `${contact.name}${contact.designation ? ` (${contact.designation})` : ''}` : '-',
          '{{TITLE}}': quote.title,
          '{{VALID_UNTIL}}': quote.validUntil || '30 days from date of offer',
          '{{NOTES}}': quote.notes || '-',
          '{{TAX_PCT}}': String(quote.taxPct),
          '{{SUBTOTAL}}': fmtMoney(quote.subtotal),
          '{{TAX_AMOUNT}}': fmtMoney(quote.taxAmount),
          '{{TOTAL}}': fmtMoney(quote.total),
          '{{CURRENCY}}': quote.currency,
          '{{COMPANY}}': live.company,
          '{{PREPARED_BY}}': `${nameOf(idx, quote.createdBy)} (${normalizeEmail(quote.createdBy)})`
        })
      );

      // 3. Locate the structural marker and insert the BOQ + totals tables.
      const marker = locateMarker(await docsClient.getDocument(copy.id), '{{BOQ_TABLE}}');
      if (!marker) {
        throw new Error('This template has no {{BOQ_TABLE}} placeholder - add one where the BOQ should appear.');
      }

      const totals = {
        currency: quote.currency,
        subtotal: fmtMoney(quote.subtotal),
        taxPct: String(quote.taxPct),
        taxAmount: fmtMoney(quote.taxAmount),
        total: fmtMoney(quote.total)
      };
      await docsClient.batchUpdate(copy.id, buildStructureRequests(marker, blocks, totals));

      // 4. Re-read the document for the new tables' real cell indices, then
      //    fill them. Table order matches insertion order: BOQ blocks, totals.
      const tables = collectTables(await docsClient.getDocument(copy.id));
      const tableValues = [
        ...blocks.map((block) => [...block.headers, ...block.rows.flat()]),
        [
          'Subtotal',
          `${totals.currency} ${totals.subtotal}`,
          `GST @ ${totals.taxPct}%`,
          `${totals.currency} ${totals.taxAmount}`,
          'Total',
          `${totals.currency} ${totals.total}`
        ]
      ];
      await docsClient.batchUpdate(copy.id, buildCellFillRequests(tables, tableValues));

      // 5. Export to PDF via Drive's native conversion and store it alongside.
      const pdfBytes = await drive.exportPdf(copy.id);
      const pdf = await drive.uploadFile(
        { fileName: `${baseName}.pdf`, mimeType: 'application/pdf', body: pdfBytes },
        folderId
      );

      await drive.shareDomainReadable(copy.id);

      await repo.updateQuote(quote.quoteNo, quote.rev, {
        doc: copy.webViewLink,
        pdf: pdf.webViewLink,
        updatedAt: nowIso()
      });
      await repo.logActivity({
        action: 'QUOTE_PDF',
        entity: `${quoteNo} R${rev}`,
        customerId: quote.customerId,
        details: baseName,
        who: normalizeEmail(user.email)
      });

      return { doc: { url: copy.webViewLink }, pdf: { url: pdf.webViewLink } };
    },

    async getDownloadArtifact(user: CrmContext, quoteNo: string, rev: number): Promise<QuoteDownloadArtifact> {
      const { quote, customer } = await loadQuote(repo, user, quoteNo, rev);
      if (quote.source === 'External') return externalArtifact(quote);

      const [blocks, users, live] = await Promise.all([
        repo.listBoqBlocks(quoteNo, rev),
        repo.listUsers(),
        loadSettings(repo)
      ]);
      const idx = userIndex(users);
      return {
        fileName: safeQuoteFileName(quote.quoteNo, quote.rev, customer.name),
        mimeType: 'text/html; charset=utf-8',
        body: renderQuoteHtml({
          company: live.company,
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
