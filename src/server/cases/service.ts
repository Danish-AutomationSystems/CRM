import type { CrmContext } from '../auth/context';
import {
  accessLevel,
  caseOwnerEntries,
  caseOwners,
  customerRealHandlers,
  ensureCanSeeCase,
  ensureFull
} from '../auth/access';
import { CASE_STAGES, type CrmRole } from '../db/schema';
import { DIRECT_EMAIL, isDirect } from '../domain/direct';
import { DEFAULT_SETTINGS } from '../settings/defaults';
import { joinPipe, normalizeEmail, parseList, parsePipe, uniqueEmails } from '../domain/lists';
import type { CustomerRecord } from '../domain/types';
import type { DriveClient, DriveFileMeta } from '../drive/client';
import { buildDriveName, disambiguate, validateRequestedUploads } from './attachments';

export type CaseCustomerRow = {
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

export type CaseUserRow = {
  email: string;
  name: string;
  role: CrmRole;
  allowedTags: string[];
  active: boolean;
};

export type CaseHandlerRow = {
  customerId: string;
  email: string;
  assignedBy: string;
  assignedAt: string;
};

export type CaseRow = {
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

export type CaseQuoteRow = {
  caseId: string;
  quoteNo: string;
  rev: number;
  title: string;
  total: number;
  currency: string;
  status: string;
  createdAt: string;
  createdBy: string;
  doc: string;
  pdf: string;
};

export type CaseActivityRow = {
  /** activity_log.id - what case_attachments.activity_id points at. */
  id: string;
  when: string;
  who: string;
  action: string;
  details: string;
  note: string;
};

export type CaseActivityLogEntry = {
  action: string;
  entity: string;
  customerId: string;
  details: string;
  who: string;
  note?: string;
};

export type CaseAttachmentRow = {
  id: string;
  activityId: string;
  caseId: string;
  driveFileId: string;
  driveViewLink: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  uploadedBy: string;
  createdAt: string;
};

export type CaseRepository = {
  withTransaction<T>(fn: (repo?: CaseRepository) => Promise<T>): Promise<T>;
  lockCustomerName(name: string): Promise<void>;
  nextCustomerId(): Promise<string>;
  nextCaseId(): Promise<string>;
  getCustomer(id: string): Promise<CaseCustomerRow | null>;
  getCustomersByIds(ids: string[]): Promise<CaseCustomerRow[]>;
  findCustomerByName(name: string): Promise<CaseCustomerRow | null>;
  createCustomer(customer: CaseCustomerRow): Promise<void>;
  addHandler(handler: CaseHandlerRow): Promise<void>;
  listHandlers(): Promise<CaseHandlerRow[]>;
  listUsers(): Promise<CaseUserRow[]>;
  getCase(id: string): Promise<CaseRow | null>;
  listCases(): Promise<CaseRow[]>;
  createCase(row: CaseRow): Promise<void>;
  updateCase(id: string, fields: Partial<CaseRow>): Promise<void>;
  listQuotesByCase(caseId: string): Promise<CaseQuoteRow[]>;
  listActivityByEntity(entity: string): Promise<CaseActivityRow[]>;
  latestQuotedValueByCase(): Promise<Record<string, number>>;
  logActivity(entry: CaseActivityLogEntry): Promise<string>;
  /**
   * The newest handover note on this case, with the activity it was logged
   * against. The id is what the client keys attachments off: matching on the
   * note text instead broke silently once the case had more than 40 activity
   * entries, because the history the client sees is capped and this is not.
   */
  latestHandover(caseId: string): Promise<{ note: string; activityId: string }>;
  createAttachments(rows: Array<Omit<CaseAttachmentRow, 'id' | 'createdAt'>>): Promise<void>;
  listAttachmentsByCase(caseId: string): Promise<CaseAttachmentRow[]>;
};

export type CaseInput = Partial<{
  title: unknown;
  details: unknown;
  source: unknown;
  priority: unknown;
  stage: unknown;
  order: unknown;
  orderValue: unknown;
  categories: unknown;
  assignee: unknown;
}>;

export type CaseOutcomeInput = Partial<{
  orderValue: unknown;
  categories: unknown;
  note: unknown;
}>;

export type CaseListFilter = Partial<{
  /** Legacy flag from older clients; treated exactly as `owned`. */
  mine: unknown;
  owned: unknown;
  assigned: unknown;
  stage: unknown;
  outcome: unknown;
  priority: unknown;
  q: unknown;
}>;

export type QuickLogInput = Partial<{
  customerId: unknown;
  newCustomer: Partial<{
    name: unknown;
    tag: unknown;
    tags: unknown;
    type: unknown;
    priority: unknown;
    area: unknown;
  }>;
  title: unknown;
  priority: unknown;
  stage: unknown;
  details: unknown;
}>;

type Ownership = {
  handlerEmailsByCustomerId: Record<string, string[]>;
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

function asBool(value: unknown): boolean {
  return value === true || String(value ?? '').toLowerCase() === 'true';
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

function validCategories(value: unknown): string[] {
  return (Array.isArray(value) ? value.map(String) : parsePipe(String(value ?? ''))).filter((category) =>
    (DEFAULT_SETTINGS.CATEGORIES as readonly string[]).includes(category)
  );
}

function ownershipFor(handlers: readonly CaseHandlerRow[]): Ownership {
  return {
    handlerEmailsByCustomerId: handlers.reduce<Record<string, string[]>>((map, handler) => {
      const email = normalizeEmail(handler.email);
      (map[handler.customerId] = map[handler.customerId] ?? []).push(email);
      return map;
    }, {})
  };
}

function userIndex(users: readonly CaseUserRow[]): Record<string, CaseUserRow> {
  return users.reduce<Record<string, CaseUserRow>>((index, user) => {
    index[normalizeEmail(user.email)] = { ...user, email: normalizeEmail(user.email) };
    return index;
  }, {});
}

function nameOf(users: Record<string, CaseUserRow>, email: string): string {
  const normalized = normalizeEmail(email);
  if (normalized === 'direct') return 'Direct';
  return users[normalized]?.name || email;
}

function expandEmail(value: unknown): string {
  const text = lower(value);
  if (!text) return '';
  return text.includes('@') ? text : `${text}@automationsystems.org`;
}

function resolveUser(users: Record<string, CaseUserRow>, value: unknown): string {
  const email = expandEmail(value);
  if (!email) throw new Error('Pick a user to assign the ticket to.');
  if (isDirect(email)) throw new Error('Direct is not a real user and cannot own or be assigned work.');
  if (!users[email]?.active) throw new Error(`${email} is not an active CRM user.`);
  return email;
}

function customerForAccess(customer: CaseCustomerRow): CustomerRecord {
  return {
    id: customer.id,
    name: customer.name,
    tags: customer.tags,
    type: customer.type
  };
}

function caseForAccess(row: CaseRow) {
  return {
    id: row.id,
    customerId: row.customerId,
    title: row.title,
    owner: row.owner,
    extraOwners: row.extraOwners,
    assignee: row.assignee
  };
}

function visibleCase(user: CrmContext, customer: CaseCustomerRow, row: CaseRow, ownership: Ownership): boolean {
  const level = accessLevel(user, customerForAccess(customer), ownership);
  try {
    ensureCanSeeCase(user, level, caseForAccess(row));
    return true;
  } catch {
    return false;
  }
}

function ensureVisible(user: CrmContext, customer: CaseCustomerRow, row: CaseRow, ownership: Ownership): void {
  const level = accessLevel(user, customerForAccess(customer), ownership);
  ensureCanSeeCase(user, level, caseForAccess(row));
}

async function loadVisibleCase(repo: CaseRepository, user: CrmContext, id: string) {
  const [row, handlers] = await Promise.all([repo.getCase(id), repo.listHandlers()]);
  if (!row) throw new Error(`Case ${id} was not found.`);
  const customer = await repo.getCustomer(row.customerId);
  if (!customer) throw new Error(`Customer ${row.customerId} was not found.`);
  const ownership = ownershipFor(handlers);
  ensureVisible(user, customer, row, ownership);
  return { row, customer, ownership };
}

function ownerEmails(row: CaseRow): string[] {
  return caseOwners(caseForAccess(row));
}

/** The customer's real account handlers - used for labelling only, never to derive ownership. */
function realHandlerEmails(row: CaseRow, ownership: Ownership): string[] {
  return customerRealHandlers(row.customerId, ownership);
}

function formatCase(row: CaseRow, ownership: Ownership, users: Record<string, CaseUserRow>) {
  const owners = ownerEmails(row);
  return {
    id: row.id,
    title: row.title,
    details: row.details,
    source: row.source,
    priority: row.priority,
    stage: row.stage,
    outcome: row.outcome,
    orderValue: row.orderValue,
    wonCategories: row.wonCategories,
    outcomeNote: row.outcomeNote,
    owners: owners.map((email) => nameOf(users, email)),
    ownerEmails: owners,
    // P10: each entry says WHY this person owns the case, so the UI stops calling the
    // creator an account handler.
    ownerList: caseOwnerEntries(caseForAccess(row), ownership).map((entry) => ({
      email: entry.email,
      name: nameOf(users, entry.email),
      source: entry.source,
      removable: entry.removable
    })),
    assignee: row.assignee ? nameOf(users, row.assignee) : '',
    assigneeEmail: normalizeEmail(row.assignee),
    closedOn: row.closedOn,
    createdOn: row.createdAt,
    updatedOn: row.updatedAt
  };
}

/**
 * P11: the owner set a brand-new case starts with. The customer's real account handlers, or
 * the creator when there are none (e.g. a Direct-handled account). Never empty.
 */
function seedOwners(customerId: string, creatorEmail: string, ownership: Ownership): string[] {
  const handlers = customerRealHandlers(customerId, ownership);
  return handlers.length > 0 ? handlers : uniqueEmails([creatorEmail]);
}

function sortableUpdated(row: CaseRow): string {
  return String(row.updatedAt || row.createdAt || '');
}

export type CaseServiceDeps = {
  getDriveClient?: () => DriveClient;
  getAttachmentsFolderId?: () => Promise<string>;
};

/** What the client claims it uploaded. Every field of it is untrusted. */
type ReportedUpload = { fileId: string; fileName: string; mimeType: string; sizeBytes: number };

type VerifiedUpload = { reported: ReportedUpload; meta: DriveFileMeta };

/**
 * The single message every verification failure produces. Deliberately uniform:
 * telling the client *which* check failed would turn this endpoint into an
 * oracle for whether a given Drive file id exists and what size it is. The
 * detail an operator needs goes to the server log instead.
 *
 * Contains "invalid" so `normalizeRpcError` classifies it as a 400 rather than
 * flattening it to a generic 500.
 */
const VERIFICATION_FAILED = 'That upload could not be verified in Google Drive - the file is missing or invalid. Please upload it again.';

const UPLOAD_DETAILS_INVALID = 'Attachment upload details are invalid.';

/**
 * Normalises what the client reported about its uploads. Returns an empty list
 * for "no attachments" so the caller can keep the untouched pre-attachment path
 * byte for byte.
 *
 * Reuses `validateRequestedUploads` so the per-response count cap and the 100 MB
 * cap are enforced identically on both the session and the commit path.
 */
function parseReportedUploads(value: unknown): ReportedUpload[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new Error(UPLOAD_DETAILS_INVALID);
  if (value.length === 0) return [];

  const records = value.map((item) => {
    if (typeof item !== 'object' || item === null) throw new Error(UPLOAD_DETAILS_INVALID);
    return item as Record<string, unknown>;
  });

  const files = validateRequestedUploads(
    records.map((record) => ({
      fileName: record.fileName,
      mimeType: record.mimeType,
      sizeBytes: record.sizeBytes
    }))
  );

  const fileIds = records.map((record) => (typeof record.fileId === 'string' ? record.fileId.trim() : ''));
  if (fileIds.some((fileId) => fileId.length === 0)) throw new Error(UPLOAD_DETAILS_INVALID);
  // A repeated id would write two rows for one file - and would let a client
  // pad a response with copies of a single upload.
  if (new Set(fileIds).size !== fileIds.length) throw new Error(UPLOAD_DETAILS_INVALID);

  return files.map((file, index) => ({ ...file, fileId: fileIds[index] }));
}

/**
 * The outcome of verification. On failure it carries the ids that were *proved*
 * to be ours, because those - and only those - may be deleted afterwards.
 */
type VerificationResult =
  | { ok: true; verified: VerifiedUpload[] }
  | { ok: false; deletable: string[] };

/**
 * Independently confirms, against Drive itself, that every reported file is one
 * this response is actually allowed to attach. The client is never believed:
 *
 *  1. the file must exist and be reachable by our credentials;
 *  2. its parents must include our attachments folder - without this a client
 *     could name any file the app's credentials can read, including another
 *     customer's quotation;
 *  3. its name must carry this case's id prefix. Names are built server-side by
 *     `beginAttachmentUpload`, so this proves the file was created by a session
 *     issued for *this* case, and stops a file id borrowed from another case's
 *     handover - which does sit in the shared attachments folder, and so passes
 *     check 2 - from being re-attached here.
 *  4. its real size must match the declared size (a truncated or abandoned
 *     resumable upload fails here).
 *
 * Checks 2 and 3 together are what makes a file "ours": in our folder, named
 * for this case. They are evaluated for *every* reported file, and evaluated
 * before the size check, because the answer decides what the caller is allowed
 * to delete. A file that fails either one is never touched again - deleting it
 * would let any authenticated user destroy arbitrary Drive files.
 *
 * Never writes and never deletes; the caller decides both.
 */
async function verifyReportedUploads(
  drive: DriveClient,
  folderId: string,
  caseId: string,
  reported: readonly ReportedUpload[]
): Promise<VerificationResult> {
  const metas = await Promise.all(reported.map((upload) => drive.getFileMeta(upload.fileId)));

  const checked = reported.map((upload, index) => {
    const meta = metas[index];
    // Unresolvable is unprovable: without metadata we cannot show the file is
    // ours, so it is not deletable either.
    const ours = meta !== null && meta.parents.includes(folderId) && meta.name.startsWith(`${caseId} - `);
    return { upload, meta, ours };
  });
  // Every id we are entitled to delete, whatever else went wrong below.
  const deletable = checked.filter((file) => file.ours).map((file) => file.upload.fileId);

  // getFileMeta maps 403 and 404 both to null - fail-closed, and correct, but it
  // makes a credential/scope misconfiguration look exactly like a deleted file.
  // Every id failing at once is the signature of the former; one of several is
  // the signature of the latter. Say which, so an operator can tell them apart
  // from the log alone. The user still sees only the uniform message above.
  const unresolved = checked.filter((file) => file.meta === null).map((file) => file.upload.fileId);
  if (unresolved.length > 0) {
    console.error(
      unresolved.length === reported.length && reported.length > 1
        ? `Case attachment verification: all ${reported.length} reported files were unresolvable (${unresolved.join(', ')}) - either every upload failed, or the CRM's Drive credentials/scope can no longer read the attachments folder.`
        : `Case attachment verification: file id(s) ${unresolved.join(', ')} could not be resolved - the file does not exist, or our Drive credentials cannot see it (Drive reports 403 and 404 identically here). ${reported.length - unresolved.length} of ${reported.length} resolved fine, so the credentials themselves are working.`
    );
    return { ok: false, deletable };
  }

  const foreign = checked.filter((file) => !file.ours);
  if (foreign.length > 0) {
    for (const file of foreign) {
      const meta = file.meta;
      console.error(
        meta && !meta.parents.includes(folderId)
          ? `Case attachment verification: ${file.upload.fileId} is not in the configured attachments folder (it has ${meta.parents.length} parent(s), none of them ours) - a client pointed at a file it did not upload here. Left untouched.`
          : `Case attachment verification: ${file.upload.fileId} was not named for ${caseId} - it belongs to another case's handover. Left untouched.`
      );
    }
    return { ok: false, deletable };
  }

  const verified: VerifiedUpload[] = [];
  for (const file of checked) {
    const meta = file.meta;
    // Unreachable: `unresolved` returned above. Narrows the type without a cast.
    if (!meta) return { ok: false, deletable };

    if (meta.size !== file.upload.sizeBytes) {
      console.error(
        `Case attachment verification: ${file.upload.fileId} is ${meta.size} bytes but ${file.upload.sizeBytes} was declared - incomplete upload, or a substituted file id.`
      );
      return { ok: false, deletable };
    }

    verified.push({ reported: file.upload, meta });
  }

  return { ok: true, verified };
}

/**
 * Best effort, and deliberately silent about its own failures: the caller is
 * about to rethrow the error the user actually needs, and a cleanup failure
 * must never replace it. A file left behind is one orphan in the attachments
 * folder - no data loss, no database impact, identifiable by having no row.
 *
 * THE RULE: only ever pass ids this request both created and verified as ours -
 * in our attachments folder, named for this case, and not already attached.
 * Anything else is somebody else's file, and this function is a delete.
 */
async function deleteOrphanedUploads(drive: DriveClient, fileIds: readonly string[]): Promise<void> {
  for (const fileId of fileIds) {
    try {
      await drive.deleteFile(fileId);
    } catch (cleanupError) {
      // Message only: a GaxiosError carries the bearer token in
      // .config.headers.Authorization and must never be logged whole.
      console.error(
        'Case attachment orphan cleanup failed:',
        fileId,
        cleanupError instanceof Error ? cleanupError.message : 'unknown error'
      );
    }
  }
}

/**
 * Shared by both cleanup paths in assignTicket - verification failure and
 * transaction failure alike. Both reach here holding a set of file ids that
 * were ours as of an earlier, out-of-transaction read (the already-attached
 * guard, or the pre-verification state); a concurrent reassignment reporting
 * the same id(s) can commit a row between that read and this call. Deleting
 * blindly would then delete the winner's now-referenced file and dangle its
 * row - the exact defect the 9a808d7 rewrite eliminated for the client-supplied
 * case. So re-read the current attachments and delete only what is still
 * unreferenced.
 *
 * Fails safe: if the re-read itself throws, nothing is known to be safe, so
 * nothing is deleted. A residual TOCTOU between this re-read and the
 * subsequent deleteFile calls is not closable in application code and is
 * accepted.
 */
async function deleteStillUnreferencedUploads(
  repo: CaseRepository,
  drive: DriveClient,
  caseId: string,
  candidateFileIds: readonly string[]
): Promise<void> {
  if (candidateFileIds.length === 0) return;
  let stillUnreferenced: readonly string[] = candidateFileIds;
  try {
    const referenced = new Set((await repo.listAttachmentsByCase(caseId)).map((file) => file.driveFileId));
    stillUnreferenced = candidateFileIds.filter((fileId) => !referenced.has(fileId));
  } catch (recheckError) {
    console.error(
      'Case attachment cleanup skipped - could not confirm the files are unreferenced:',
      recheckError instanceof Error ? recheckError.message : 'unknown error'
    );
    stillUnreferenced = [];
  }
  await deleteOrphanedUploads(drive, stillUnreferenced);
}

export function createCaseService(repo: CaseRepository, deps: CaseServiceDeps = {}) {
  function requireDrive(): { drive: DriveClient; folderId: () => Promise<string> } {
    if (!deps.getDriveClient || !deps.getAttachmentsFolderId) {
      throw new Error('Google Drive is not configured. Run the one-time Drive setup first.');
    }
    const getFolderId = deps.getAttachmentsFolderId;
    return { drive: deps.getDriveClient(), folderId: () => getFolderId() };
  }

  async function uploaderNameFor(user: CrmContext): Promise<string> {
    // Server-derived, from the users table - buildDriveName does not sanitise
    // this field, so it must never be anything the client sent.
    return nameOf(userIndex(await repo.listUsers()), user.email);
  }

  return {
    async listAssignableUsers(_user: CrmContext) {
      return (await repo.listUsers())
        // P9: Direct is a virtual account with no login - it can never hold a ticket.
        .filter((row) => row.active && !isDirect(row.email))
        .map((row) => ({ email: normalizeEmail(row.email), name: row.name, role: row.role }))
        .sort((a, b) => a.name.localeCompare(b.name));
    },

    async createCase(user: CrmContext, customerId: string, input: CaseInput) {
      requireLevel(user, 2);
      const customer = await repo.getCustomer(customerId);
      if (!customer) throw new Error(`Customer ${customerId} was not found.`);
      const handlers = await repo.listHandlers();
      const ownership = ownershipFor(handlers);
      ensureFull(user, customerForAccess(customer), ownership);

      const title = asText(input.title);
      if (!title) throw new Error('Give the case a short title.');

      const order = asBool(input.order);
      const users = userIndex(await repo.listUsers());
      let assignee = '';
      if (order) {
        const orderValue = Number(input.orderValue);
        if (!(orderValue > 0)) throw new Error('Enter the order value to add a won order.');
        if (!validCategories(input.categories).length) throw new Error('Select at least one product category for the order.');
      } else if (input.assignee) {
        assignee = resolveUser(users, input.assignee);
      } else if (roleLevel(user) >= 5) {
        throw new Error('Choose who this case is assigned to.');
      } else {
        assignee = normalizeEmail(user.email);
      }

      return repo.withTransaction(async (tx) => {
        const trx = tx ?? repo;
        const id = await trx.nextCaseId();
        const now = nowIso();
        const row: CaseRow = {
          id,
          customerId,
          title,
          details: String(input.details ?? ''),
          source: asText(input.source),
          priority: validOne(input.priority, DEFAULT_SETTINGS.PRIORITIES),
          stage: order ? 'Quoted' : validOne(input.stage, CASE_STAGES) || DEFAULT_SETTINGS.STAGES[0],
          outcome: order ? 'Won' : '',
          orderValue: order ? Number(input.orderValue) : '',
          wonCategories: order ? validCategories(input.categories) : [],
          outcomeNote: '',
          owner: normalizeEmail(user.email),
          // P11: ownership is materialised at creation - the customer's real handlers, or
          // the creator when the only handler is the virtual Direct account.
          extraOwners: seedOwners(customerId, normalizeEmail(user.email), ownership),
          assignee: order ? '' : assignee,
          closedOn: order ? now : '',
          createdBy: normalizeEmail(user.email),
          createdAt: now,
          updatedAt: now
        };
        await trx.createCase(row);
        await trx.logActivity({
          action: 'CASE_NEW',
          entity: id,
          customerId,
          details: `${title} (${customer.name}${order ? ', order' : `, ${row.stage}`})`,
          who: normalizeEmail(user.email)
        });
        return { id };
      });
    },

    async updateCase(user: CrmContext, id: string, input: Partial<{ title: unknown; details: unknown; source: unknown }>) {
      const { row } = await loadVisibleCase(repo, user, id);
      const fields: Partial<CaseRow> = { updatedAt: nowIso() };
      if (input.title !== undefined) fields.title = asText(input.title) || row.title;
      if (input.details !== undefined) fields.details = String(input.details ?? '');
      if (input.source !== undefined) fields.source = asText(input.source);
      await repo.updateCase(id, fields);
      await repo.logActivity({
        action: 'CASE_EDIT',
        entity: id,
        customerId: row.customerId,
        details: fields.title ?? row.title,
        who: normalizeEmail(user.email)
      });
      return { ok: true };
    },

    async setCaseStage(user: CrmContext, id: string, stageInput: unknown, note?: unknown) {
      const stage = asText(stageInput);
      const { row } = await loadVisibleCase(repo, user, id);
      if (!(CASE_STAGES as readonly string[]).includes(stage)) throw new Error(`"${stage}" is not a valid stage.`);
      if (row.outcome === 'Won' || row.outcome === 'Lost') {
        throw new Error(`This case is closed as ${row.outcome}. Reopen it before changing the stage.`);
      }
      if (row.stage === stage && !row.outcome) return { ok: true };

      const fields: Partial<CaseRow> = { stage, updatedAt: nowIso() };
      if (row.outcome === 'Hold') fields.outcome = '';
      await repo.updateCase(id, fields);
      await repo.logActivity({
        action: 'CASE_STAGE',
        entity: id,
        customerId: row.customerId,
        details: `${row.stage || '-'} -> ${stage}${asText(note) ? ` - ${asText(note)}` : ''}`,
        who: normalizeEmail(user.email)
      });
      return { ok: true };
    },

    async setCasePriority(user: CrmContext, id: string, priorityInput: unknown) {
      const priority = asText(priorityInput);
      const { row } = await loadVisibleCase(repo, user, id);
      // '' is allowed and means "clear it" - priority is optional, so it must be removable.
      if (priority && !(DEFAULT_SETTINGS.PRIORITIES as readonly string[]).includes(priority)) {
        throw new Error(`"${priority}" is not a valid priority.`);
      }
      // No block on a closed case. setCaseStage refuses on Won/Lost because a closed case
      // has no meaningful stage; priority carries no such contradiction.
      if (row.priority === priority) return { ok: true };

      const previousPriority = row.priority;
      await repo.updateCase(id, { priority, updatedAt: nowIso() });
      await repo.logActivity({
        action: 'CASE_PRIORITY',
        entity: id,
        customerId: row.customerId,
        details: `${previousPriority || '-'} -> ${priority || '-'}`,
        who: normalizeEmail(user.email)
      });
      return { ok: true };
    },

    async setCaseOutcome(user: CrmContext, id: string, outcomeInput: unknown, data: CaseOutcomeInput = {}) {
      const outcome = asText(outcomeInput);
      const { row } = await loadVisibleCase(repo, user, id);

      if (outcome === 'Open') {
        await repo.updateCase(id, { outcome: '', closedOn: '', updatedAt: nowIso() });
        await repo.logActivity({
          action: 'CASE_OUTCOME',
          entity: id,
          customerId: row.customerId,
          details: 'Reopened',
          who: normalizeEmail(user.email)
        });
        return { ok: true };
      }

      if (!(DEFAULT_SETTINGS.OUTCOMES as readonly string[]).includes(outcome)) {
        throw new Error(`"${outcome}" is not a valid outcome.`);
      }

      return repo.withTransaction(async (tx) => {
        const trx = tx ?? repo;
        const fields: Partial<CaseRow> = {
          outcome: outcome as CaseRow['outcome'],
          outcomeNote: String(data.note ?? ''),
          updatedAt: nowIso()
        };

        if (outcome === 'Won') {
          const value = Number(data.orderValue);
          if (!(value > 0)) throw new Error('Enter the order value (the amount at which the order was won).');
          const categories = validCategories(data.categories);
          if (!categories.length) throw new Error('Select at least one product category for the won order.');
          fields.orderValue = Math.round(value * 100) / 100;
          fields.wonCategories = categories;
          fields.closedOn = nowIso();
          fields.stage = 'Quoted';
          fields.assignee = '';
        } else if (outcome === 'Lost') {
          fields.closedOn = nowIso();
          fields.assignee = '';
        } else if (outcome === 'Hold') {
          fields.closedOn = '';
        }

        await trx.updateCase(id, fields);
        await trx.logActivity({
          action: 'CASE_OUTCOME',
          entity: id,
          customerId: row.customerId,
          details: outcome,
          who: normalizeEmail(user.email)
        });
        return { ok: true };
      });
    },

    async addCaseOwner(user: CrmContext, caseId: string, who: unknown) {
      const { row } = await loadVisibleCase(repo, user, caseId);
      const owners = ownerEmails(row);
      if (!owners.includes(normalizeEmail(user.email)) && roleLevel(user) < 4) {
        throw new Error('Only a current owner of this case can add owners.');
      }
      const users = userIndex(await repo.listUsers());
      const email = resolveUser(users, who);
      const extras = uniqueEmails([...owners, email]);
      if (extras.length === owners.length) throw new Error(`${nameOf(users, email)} is already an owner of this case.`);
      await repo.updateCase(caseId, { extraOwners: extras, updatedAt: nowIso() });
      await repo.logActivity({
        action: 'CASE_OWNER_ADD',
        entity: caseId,
        customerId: row.customerId,
        details: nameOf(users, email),
        who: normalizeEmail(user.email)
      });
      return { ok: true };
    },

    async removeCaseOwner(user: CrmContext, caseId: string, who: unknown) {
      const { row, ownership } = await loadVisibleCase(repo, user, caseId);
      const owners = ownerEmails(row);
      if (!owners.includes(normalizeEmail(user.email)) && roleLevel(user) < 4) {
        throw new Error('Only a current owner of this case can remove owners.');
      }
      const email = expandEmail(who);
      if (!owners.includes(email)) {
        throw new Error('That user is not an owner of this case.');
      }
      // P11: a case must always keep at least one owner. Checked before the handler rule so
      // a sole creator-owner gets the accurate message rather than a handler refusal.
      if (owners.length <= 1) {
        throw new Error('A case must always have at least one owner. Add another owner before removing this one.');
      }
      if (realHandlerEmails(row, ownership).includes(email)) {
        throw new Error('Account handlers are owners of every case on the account and cannot be removed here. Remove them as a handler on the customer instead.');
      }
      const extras = owners.filter((owner) => owner !== email);
      const users = userIndex(await repo.listUsers());
      await repo.updateCase(caseId, { extraOwners: extras, updatedAt: nowIso() });
      await repo.logActivity({
        action: 'CASE_OWNER_REMOVE',
        entity: caseId,
        customerId: row.customerId,
        details: nameOf(users, email),
        who: normalizeEmail(user.email)
      });
      return { ok: true };
    },

    /**
     * Issues one Drive resumable upload session per requested file so the
     * browser can send the bytes straight to Google - 100 MB cannot pass
     * through Vercel's 4.5 MB request body limit.
     *
     * Access is checked first, before any session exists, so a user who cannot
     * see the case learns nothing and consumes nothing. Only `{ fileName,
     * sessionUrl }` crosses back: never the access token, never the folder id.
     */
    async beginAttachmentUpload(user: CrmContext, caseId: string, files: unknown) {
      const { row } = await loadVisibleCase(repo, user, caseId);
      if (row.outcome) throw new Error('This opportunity is closed - the ticket can no longer be reassigned.');
      const requested = validateRequestedUploads(files);

      const { drive, folderId: resolveFolderId } = requireDrive();
      const folderId = await resolveFolderId();
      const uploaderName = await uploaderNameFor(user);
      const when = new Date();

      const sessions: Array<{ fileName: string; sessionUrl: string }> = [];
      for (const file of requested) {
        const { sessionUrl } = await drive.createResumableSession({
          // Server-built name: the client's file name is only ever an input to
          // buildDriveName, which sanitises it.
          fileName: buildDriveName({ caseId: row.id, uploaderName, fileName: file.fileName, when }),
          mimeType: file.mimeType,
          sizeBytes: file.sizeBytes,
          folderId
        });
        sessions.push({ fileName: file.fileName, sessionUrl });
      }
      return sessions;
    },

    async assignTicket(user: CrmContext, caseId: string, who: unknown, noteInput?: unknown, uploadsInput?: unknown) {
      const { row } = await loadVisibleCase(repo, user, caseId);
      if (row.outcome) throw new Error('This opportunity is closed - the ticket can no longer be reassigned.');
      const note = asText(noteInput);
      if (note.length > 2000) throw new Error('That handover note is too long - please keep it under 2000 characters.');
      const users = userIndex(await repo.listUsers());
      const email = resolveUser(users, who);
      const reported = parseReportedUploads(uploadsInput);

      if (reported.length === 0) {
        // Unchanged path: no transaction, no Drive call, identical details and
        // return value to before attachments existed.
        await repo.updateCase(caseId, { assignee: email, updatedAt: nowIso() });
        await repo.logActivity({
          action: 'CASE_ASSIGN',
          entity: caseId,
          customerId: row.customerId,
          details: `Working on -> ${nameOf(users, email)}`,
          who: normalizeEmail(user.email),
          note
        });
        return { ok: true, assignee: nameOf(users, email), assigneeEmail: email };
      }

      // Checked before the cleanup-guarded block on purpose: these files back
      // rows that already exist, so failing inside that block would delete a
      // live attachment out from under an earlier handover.
      const alreadyAttached = new Set((await repo.listAttachmentsByCase(caseId)).map((file) => file.driveFileId));
      if (reported.some((upload) => alreadyAttached.has(upload.fileId))) {
        throw new Error(UPLOAD_DETAILS_INVALID);
      }

      const { drive, folderId: resolveFolderId } = requireDrive();
      const folderId = await resolveFolderId();

      // Verification runs outside the cleanup-guarded block on purpose. It
      // decides which ids are ours, and only it can say so; a catch-all around
      // it would be cleaning up files it had just proved belong to someone
      // else. If getFileMeta throws outright, nothing is deleted at all - an
      // unverified file is never ours to touch.
      const verification = await verifyReportedUploads(drive, folderId, row.id, reported);
      if (!verification.ok) {
        // Same re-read-before-delete guard as the transaction-failure path
        // below: the already-attached guard above is a read outside any
        // transaction, so a concurrent reassignment can commit a row for one
        // of these ids while verification is still working through the rest
        // of the batch.
        await deleteStillUnreferencedUploads(repo, drive, caseId, verification.deletable);
        throw new Error(VERIFICATION_FAILED);
      }
      const verified = verification.verified;
      // Past this point every id has been proved ours, so the whole set is safe
      // to clean up if the rename or the transaction fails.
      const ourFileIds = verified.map((file) => file.meta.id);

      try {
        // Give each file its final name. The base name is rebuilt server-side
        // rather than taken from Drive, and disambiguated against the folder so
        // two identically named uploads stay distinguishable. Each file's own
        // provisional name is removed from the taken set first, so a file never
        // collides with itself.
        // Scoped to this case: the folder holds every case's attachments and the
        // listing is a single page, so an unscoped read could miss collisions.
        const taken = await drive.listFileNamesInFolder(folderId, row.id);
        for (const file of verified) {
          const index = taken.indexOf(file.meta.name);
          if (index >= 0) taken.splice(index, 1);
        }
        const when = new Date();
        const uploaderName = nameOf(users, user.email);
        const named = verified.map((file) => {
          const finalName = disambiguate(
            buildDriveName({ caseId: row.id, uploaderName, fileName: file.reported.fileName, when }),
            taken
          );
          taken.push(finalName);
          return { ...file, finalName };
        });
        for (const file of named) {
          await drive.renameFile(file.meta.id, file.finalName);
        }

        // Every Drive call is finished before the transaction opens: holding one
        // of only ten pool connections across a Google round trip is not
        // something this app can afford.
        return await repo.withTransaction(async (tx) => {
          const trx = tx ?? repo;
          await trx.updateCase(caseId, { assignee: email, updatedAt: nowIso() });
          const activityId = await trx.logActivity({
            action: 'CASE_ASSIGN',
            entity: caseId,
            customerId: row.customerId,
            details: `Working on -> ${nameOf(users, email)}`,
            who: normalizeEmail(user.email),
            note
          });
          await trx.createAttachments(
            named.map((file) => ({
              activityId,
              caseId,
              driveFileId: file.meta.id,
              // Drive normally returns webViewLink, but the field is optional in
              // the API response; the canonical URL is derivable from the id.
              driveViewLink: file.meta.webViewLink || `https://drive.google.com/file/d/${file.meta.id}/view`,
              fileName: file.finalName,
              mimeType: file.meta.mimeType,
              // Drive's size, never the client's declared one.
              sizeBytes: file.meta.size,
              uploadedBy: normalizeEmail(user.email)
            }))
          );
          return { ok: true, assignee: nameOf(users, email), assigneeEmail: email };
        });
      } catch (error) {
        // The rename failed, or the database rolled back: these files are ours
        // and, in the ordinary case, now unreferenced.
        //
        // One exception, and it is the reason for the re-read: the
        // case_attachments_drive_file_id_key unique index. The already-attached
        // guard above is a read outside the transaction, so a concurrent
        // reassignment reporting the same file id can commit between that read
        // and this insert. We lose on the index - and the file now backs the
        // winner's row. Deleting it would leave that row dangling, which is the
        // same defect as deleting somebody else's file. So only delete what is
        // still unreferenced; if we cannot establish that, delete nothing and
        // leave a harmless orphan.
        // Best effort, and never masks the original error - the one the caller needs.
        await deleteStillUnreferencedUploads(repo, drive, caseId, ourFileIds);
        throw error;
      }
    },

    async getCase(user: CrmContext, id: string) {
      const { row, customer, ownership } = await loadVisibleCase(repo, user, id);
      const [users, quotes, history, latestHandover, attachmentRows] = await Promise.all([
        repo.listUsers(),
        repo.listQuotesByCase(id),
        repo.listActivityByEntity(id),
        repo.latestHandover(id),
        repo.listAttachmentsByCase(id)
      ]);
      const idx = userIndex(users);
      const formatAttachment = (attachment: CaseAttachmentRow) => ({
        id: attachment.id,
        fileName: attachment.fileName,
        viewLink: attachment.driveViewLink,
        mimeType: attachment.mimeType,
        sizeBytes: attachment.sizeBytes,
        uploadedBy: nameOf(idx, attachment.uploadedBy),
        uploadedOn: attachment.createdAt
      });
      const attachmentsByActivity = attachmentRows.reduce<Record<string, ReturnType<typeof formatAttachment>[]>>(
        (map, attachment) => {
          (map[attachment.activityId] = map[attachment.activityId] ?? []).push(formatAttachment(attachment));
          return map;
        },
        {}
      );
      return {
        canEdit: true,
        canAssign: roleLevel(user) >= 2,
        canAssignTicket: !row.outcome,
        case: formatCase(row, ownership, idx),
        customer: { id: customer.id, name: customer.name, tags: customer.tags },
        quotes: quotes
          .slice()
          .sort((a, b) => (a.quoteNo === b.quoteNo ? b.rev - a.rev : b.quoteNo.localeCompare(a.quoteNo)))
          .map((quote) => ({
            quoteNo: quote.quoteNo,
            rev: quote.rev,
            title: quote.title,
            total: quote.total,
            currency: quote.currency,
            status: quote.status,
            date: quote.createdAt,
            doc: quote.doc,
            pdf: quote.pdf,
            by: nameOf(idx, quote.createdBy)
          })),
        history: history.slice().reverse().slice(0, 40).map((item) => ({
          // The client keys the "Latest handover note" card's attachments off
          // this, rather than matching on note text.
          id: item.id,
          when: item.when,
          who: nameOf(idx, item.who),
          action: item.action,
          details: item.details,
          note: item.note,
          attachments: attachmentsByActivity[item.id] ?? []
        })),
        // The same rows keyed by the activity they belong to, for callers that
        // want them without walking the (40-entry capped) history.
        attachments: attachmentsByActivity,
        latestHandoverNote: latestHandover.note,
        // Lets the client find that note's attachments by id. Deliberately not
        // derived from `history`: that is capped at 40 entries and this is not,
        // which is exactly how the old text match failed on a busy case.
        latestHandoverActivityId: latestHandover.activityId
      };
    },

    async listCases(user: CrmContext, filter: CaseListFilter = {}) {
      const caseRows = await repo.listCases();
      const customerIds = [...new Set(caseRows.map((row) => row.customerId).filter(Boolean))];
      const [cases, customers, handlers, users, quotedValues] = await Promise.all([
        Promise.resolve(caseRows),
        repo.getCustomersByIds(customerIds),
        repo.listHandlers(),
        repo.listUsers(),
        repo.latestQuotedValueByCase()
      ]);
      const ownership = ownershipFor(handlers);
      const idx = userIndex(users);
      const customersById = customers.reduce<Record<string, CaseCustomerRow>>((map, customer) => {
        if (customer) map[customer.id] = customer;
        return map;
      }, {});
      const stage = asText(filter.stage);
      const priority = asText(filter.priority);
      const outcome = asText(filter.outcome);
      const query = lower(filter.q);
      const me = normalizeEmail(user.email);
      // P6: two independent filters combined with OR. The legacy `mine` flag is retained and
      // treated as `owned`, so an in-flight old client keeps working. Neither set = all
      // visible cases, which is today's behaviour.
      const wantOwned = asBool(filter.owned) || asBool(filter.mine);
      const wantAssigned = asBool(filter.assigned);

      return cases
        .filter((row) => {
          const customer = customersById[row.customerId];
          if (!customer || !visibleCase(user, customer, row, ownership)) return false;
          if (wantOwned || wantAssigned) {
            const isOwned = wantOwned && ownerEmails(row).includes(me);
            const isAssigned = wantAssigned && normalizeEmail(row.assignee) === me;
            if (!isOwned && !isAssigned) return false;
          }
          if (outcome === 'Open' && row.outcome) return false;
          if (outcome && outcome !== 'Open' && row.outcome !== outcome) return false;
          if (stage && row.stage !== stage) return false;
          if (priority && row.priority !== priority) return false;
          if (query) {
            const haystack = lower(`${row.title} ${row.id} ${customer.name}`);
            if (!haystack.includes(query)) return false;
          }
          return true;
        })
        .sort((a, b) => sortableUpdated(b).localeCompare(sortableUpdated(a)))
        .slice(0, 300)
        .map((row) => {
          const customer = customersById[row.customerId];
          const outcomeText = row.outcome || '';
          return {
            id: row.id,
            title: row.title,
            customerId: row.customerId,
            customerName: customer?.name ?? row.customerId,
            priority: row.priority,
            stage: row.stage,
            outcome: outcomeText,
            orderValue: row.orderValue,
            quotedValue: quotedValues[row.id] ?? '',
            owners: ownerEmails(row).map((email) => nameOf(idx, email)),
            assignee: outcomeText ? '' : row.assignee ? nameOf(idx, row.assignee) : '',
            updatedOn: row.updatedAt
          };
        });
    },

    async quickLog(user: CrmContext, input: QuickLogInput) {
      requireLevel(user, 2);
      return repo.withTransaction(async (tx) => {
        const trx = tx ?? repo;
        let customerId = asText(input.customerId);
        if (!customerId) {
          const newCustomer = input.newCustomer ?? {};
          const name = asText(newCustomer.name);
          if (!name) throw new Error('Pick an existing customer or enter a new customer name.');
          await trx.lockCustomerName(name);
          const duplicate = await trx.findCustomerByName(name);
          if (duplicate) {
            customerId = duplicate.id;
          } else {
            customerId = await trx.nextCustomerId();
            const now = nowIso();
            await trx.createCustomer({
              id: customerId,
              name,
              tags: validTags(newCustomer.tags ?? newCustomer.tag),
              type: validOne(newCustomer.type, DEFAULT_SETTINGS.TYPES),
              priority: validOne(newCustomer.priority, DEFAULT_SETTINGS.PRIORITIES),
              area: asText(newCustomer.area),
              address: '',
              gstin: '',
              website: '',
              notes: '',
              sei: [],
              remarks: '',
              status: 'Active',
              createdBy: normalizeEmail(user.email),
              createdAt: now,
              updatedAt: now
            });
            await trx.addHandler({
              customerId,
              // P1: an L5/L6 quick-logger does not become a handler; the account is Direct
              // until a real handler is added.
              email: roleLevel(user) >= 5 ? DIRECT_EMAIL : normalizeEmail(user.email),
              assignedBy: 'quick-log',
              assignedAt: now
            });
            await trx.logActivity({
              action: 'CUSTOMER_NEW',
              entity: customerId,
              customerId,
              details: `${name} (quick-log)`,
              who: normalizeEmail(user.email)
            });
          }
        } else {
          const customer = await trx.getCustomer(customerId);
          if (!customer) throw new Error(`Customer ${customerId} was not found.`);
          ensureFull(user, customerForAccess(customer), ownershipFor(await trx.listHandlers()));
        }

        const id = await trx.nextCaseId();
        const now = nowIso();
        const row: CaseRow = {
          id,
          customerId,
          title: asText(input.title) || 'Untitled case',
          details: String(input.details ?? ''),
          source: '',
          priority: validOne(input.priority, DEFAULT_SETTINGS.PRIORITIES),
          stage: validOne(input.stage, CASE_STAGES) || DEFAULT_SETTINGS.STAGES[0],
          outcome: '',
          orderValue: '',
          wonCategories: [],
          outcomeNote: '',
          owner: normalizeEmail(user.email),
          extraOwners: seedOwners(customerId, normalizeEmail(user.email), ownershipFor(await trx.listHandlers())),
          assignee: normalizeEmail(user.email),
          closedOn: '',
          createdBy: normalizeEmail(user.email),
          createdAt: now,
          updatedAt: now
        };
        await trx.createCase(row);
        await trx.logActivity({
          action: 'CASE_NEW',
          entity: id,
          customerId,
          details: `${row.title || 'Case'} (quick-log)`,
          who: normalizeEmail(user.email)
        });
        return { caseId: id, customerId };
      });
    }
  };
}

export type CaseService = ReturnType<typeof createCaseService>;
