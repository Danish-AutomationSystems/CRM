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
  when: string;
  who: string;
  action: string;
  details: string;
};

export type CaseActivityLogEntry = {
  action: string;
  entity: string;
  customerId: string;
  details: string;
  who: string;
};

export type CaseRepository = {
  withTransaction<T>(fn: (repo?: CaseRepository) => Promise<T>): Promise<T>;
  lockCustomerName(name: string): Promise<void>;
  nextCustomerId(): Promise<string>;
  nextCaseId(): Promise<string>;
  getCustomer(id: string): Promise<CaseCustomerRow | null>;
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
  logActivity(entry: CaseActivityLogEntry): Promise<void>;
};

export type CaseInput = Partial<{
  title: unknown;
  details: unknown;
  source: unknown;
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

export function createCaseService(repo: CaseRepository) {
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

    async assignTicket(user: CrmContext, caseId: string, who: unknown) {
      const { row } = await loadVisibleCase(repo, user, caseId);
      if (row.outcome) throw new Error('This opportunity is closed - the ticket can no longer be reassigned.');
      const users = userIndex(await repo.listUsers());
      const email = resolveUser(users, who);
      await repo.updateCase(caseId, { assignee: email, updatedAt: nowIso() });
      await repo.logActivity({
        action: 'CASE_ASSIGN',
        entity: caseId,
        customerId: row.customerId,
        details: `Working on -> ${nameOf(users, email)}`,
        who: normalizeEmail(user.email)
      });
      return { ok: true, assignee: nameOf(users, email), assigneeEmail: email };
    },

    async getCase(user: CrmContext, id: string) {
      const { row, customer, ownership } = await loadVisibleCase(repo, user, id);
      const [users, quotes, history] = await Promise.all([
        repo.listUsers(),
        repo.listQuotesByCase(id),
        repo.listActivityByEntity(id)
      ]);
      const idx = userIndex(users);
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
          when: item.when,
          who: nameOf(idx, item.who),
          action: item.action,
          details: item.details
        }))
      };
    },

    async listCases(user: CrmContext, filter: CaseListFilter = {}) {
      const caseRows = await repo.listCases();
      const [cases, customers, handlers, users, quotedValues] = await Promise.all([
        Promise.resolve(caseRows),
        Promise.all(caseRows.map((row) => repo.getCustomer(row.customerId))),
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
