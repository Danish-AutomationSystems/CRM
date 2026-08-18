import type { CrmContext } from '../auth/context';
import { accessLevel, caseOwners, caseVisible } from '../auth/access';
import type { CaseCustomerRow, CaseRepository, CaseService } from '../cases/service';
import type { CustomerService } from '../customers/service';
import { DEFAULT_SETTINGS, SELECTABLE_TAGS } from '../settings/defaults';
import {
  DIRECT_EMAIL,
  DIRECT_NAME,
  DIRECT_VISIBLE_FROM_LEVEL,
  directVirtualUser,
  isDirect
} from '../domain/direct';
import { normalizeEmail } from '../domain/lists';
import type { CaseRecord, CustomerRecord } from '../domain/types';

export type DashboardActivityRow = {
  when: string;
  who: string;
  action: string;
  entity: string;
  customerId: string;
  details: string;
};

export type DashboardRepository = CaseRepository & {
  listActivity(limit?: number): Promise<DashboardActivityRow[]>;
  getCustomersByIds(ids: string[]): Promise<CaseCustomerRow[]>;
};

type DashboardDependencies = {
  customerService: Pick<CustomerService, 'myCustomers'>;
  caseService: Pick<CaseService, 'listCases'>;
};

function roleLevel(user: Pick<CrmContext, 'role'>): number {
  return Number(user.role.slice(1));
}

function normalizeUser(user: { email: string; name: string; role: string; allowedTags: string[]; active: boolean }) {
  return {
    ...user,
    email: normalizeEmail(user.email),
    allowedTags: user.allowedTags ?? []
  };
}

function userIndex(users: Awaited<ReturnType<DashboardRepository['listUsers']>>) {
  return users.reduce<Record<string, ReturnType<typeof normalizeUser>>>((index, user) => {
    const normalized = normalizeUser(user);
    index[normalized.email] = normalized;
    return index;
  }, {});
}

function nameOf(users: Record<string, { name?: string }>, email: string): string {
  return users[normalizeEmail(email)]?.name || email;
}

function customerRecord(customer: Awaited<ReturnType<DashboardRepository['getCustomer']>>): CustomerRecord {
  if (!customer) throw new Error('Customer not found.');
  return { id: customer.id, name: customer.name, tags: customer.tags, type: customer.type };
}

function caseRecord(row: Awaited<ReturnType<DashboardRepository['listCases']>>[number]): CaseRecord {
  return {
    id: row.id,
    customerId: row.customerId,
    title: row.title,
    owner: row.owner,
    extraOwners: row.extraOwners,
    assignee: row.assignee
  };
}

function daysAgo(dateText: string): number {
  const date = new Date(dateText);
  if (Number.isNaN(date.getTime())) return Number.POSITIVE_INFINITY;
  return Math.floor((Date.now() - date.getTime()) / 86_400_000);
}

function yearMonthNow(): string {
  return new Date().toISOString().slice(0, 7);
}

function sharedTag(viewer: CrmContext, subject: { allowedTags: string[] }): boolean {
  if (viewer.allowedTags.includes('*')) return true;
  return subject.allowedTags.some((tag) => viewer.allowedTags.includes(tag));
}

function expandEmail(value: unknown): string {
  const text = String(value ?? '').trim().toLowerCase();
  if (!text) return '';
  return text.includes('@') ? text : `${text}@automationsystems.org`;
}

export function createDashboardService(repo: DashboardRepository, dependencies: DashboardDependencies) {
  async function computeDash(subjectEmailInput: string) {
    const subjectEmail = normalizeEmail(subjectEmailInput);
    const caseRows = await repo.listCases();
    const [cases, customers, handlers, users] = await Promise.all([
      Promise.resolve(caseRows),
      Promise.all(caseRows.map((row) => repo.getCustomer(row.customerId))),
      repo.listHandlers(),
      repo.listUsers()
    ]);
    const idx = userIndex(users);
    const ownership = {
      handlerEmailsByCustomerId: handlers.reduce<Record<string, string[]>>((map, handler) => {
        (map[handler.customerId] = map[handler.customerId] ?? []).push(normalizeEmail(handler.email));
        return map;
      }, {})
    };
    const customersById = customers.reduce<Record<string, NonNullable<(typeof customers)[number]>>>((map, customer) => {
      if (customer) map[customer.id] = customer;
      return map;
    }, {});

    const subjectHandles = new Set(
      Object.entries(ownership.handlerEmailsByCustomerId)
        .filter(([, emails]) => emails.includes(subjectEmail))
        .map(([customerId]) => customerId)
    );
    const openMine: Array<{ id: string; title: string; customerId: string; customerName: string; stage: string; priority: string }> = [];
    const tickets: Array<{ id: string; title: string; customerId: string; customerName: string; stage: string; priority: string }> = [];
    let wonMonthValue = 0;
    let wonMonthCount = 0;
    let won2wValue = 0;
    let won2wCount = 0;
    const ym = yearMonthNow();

    // P9: Direct is a virtual account. It never appears in a case's owner set, so its
    // dashboard is attributed by the customer's `handlers.user_email = 'direct'` rows.
    const directSubject = isDirect(subjectEmail);

    for (const row of cases) {
      const customerName = customersById[row.customerId]?.name ?? row.customerId;
      const owners = caseOwners(caseRecord(row));
      const mine = directSubject ? subjectHandles.has(row.customerId) : owners.includes(subjectEmail);
      if (mine && !row.outcome) {
        openMine.push({ id: row.id, title: row.title, customerId: row.customerId, customerName, stage: row.stage, priority: row.priority });
      }
      if (normalizeEmail(row.assignee) === subjectEmail && !row.outcome) {
        tickets.push({ id: row.id, title: row.title, customerId: row.customerId, customerName, stage: row.stage, priority: row.priority });
      }
      if (mine && row.outcome === 'Won') {
        const value = Number(row.orderValue || 0) || 0;
        if (String(row.closedOn).slice(0, 7) === ym) {
          wonMonthValue += value;
          wonMonthCount++;
        }
        if (daysAgo(row.closedOn) <= 14) {
          won2wValue += value;
          won2wCount++;
        }
      }
    }

    openMine.sort((a, b) => a.title.localeCompare(b.title));
    tickets.sort((a, b) => a.title.localeCompare(b.title));

    return {
      stats: {
        myCustomers: subjectHandles.size,
        openOpps: openMine.length,
        wonMonthValue: Math.round(wonMonthValue * 100) / 100,
        wonMonthCount,
        won2wValue: Math.round(won2wValue * 100) / 100,
        won2wCount
      },
      cases: openMine.slice(0, 60),
      tickets: tickets.slice(0, 60)
    };
  }

  async function recentActivity(user: CrmContext) {
    const [activity, handlers, users] = await Promise.all([
      repo.listActivity(250),
      repo.listHandlers(),
      repo.listUsers()
    ]);
    const idx = userIndex(users);
    const ownership = {
      handlerEmailsByCustomerId: handlers.reduce<Record<string, string[]>>((map, handler) => {
        (map[handler.customerId] = map[handler.customerId] ?? []).push(normalizeEmail(handler.email));
        return map;
      }, {})
    };
    const out: Array<{ when: string; who: string; action: string; entity: string; details: string }> = [];
    const rows = activity.slice().sort((a, b) => String(b.when).localeCompare(String(a.when)));

    // Every customerId a lookup might need is knowable up front, so fetch them all in one
    // batched query rather than sequentially awaiting inside the filter loop below.
    const isSelfRow = (row: DashboardActivityRow) =>
      roleLevel(user) >= 4 || normalizeEmail(row.who) === normalizeEmail(user.email);
    const neededCustomerIds = Array.from(
      new Set(rows.filter((row) => !isSelfRow(row) && row.customerId).map((row) => row.customerId))
    );
    const customersById =
      neededCustomerIds.length > 0
        ? (await repo.getCustomersByIds(neededCustomerIds)).reduce<Record<string, Awaited<ReturnType<DashboardRepository['getCustomer']>>>>(
            (map, customer) => {
              if (customer) map[customer.id] = customer;
              return map;
            },
            {}
          )
        : {};

    for (const row of rows) {
      if (out.length >= 14) break;
      let ok = isSelfRow(row);
      if (!ok && row.customerId) {
        const customer = customersById[row.customerId];
        if (customer) {
          ok = accessLevel(user, customerRecord(customer), ownership) === 'FULL';
        }
      }
      if (!ok) continue;
      out.push({
        when: row.when,
        who: nameOf(idx, row.who),
        action: row.action,
        entity: row.entity,
        details: row.details
      });
    }
    return out;
  }

  return {
    async bootstrap(user: CrmContext) {
      const [users, recent] = await Promise.all([repo.listUsers(), recentActivity(user)]);
      const level = roleLevel(user);
      const idx = userIndex(users);
      const peers =
        level >= 3
          ? users
              .map(normalizeUser)
              .filter((candidate) => {
                if (candidate.email === normalizeEmail(user.email) || !candidate.active) return false;
                if (level >= 4) return true;
                return roleLevel(candidate as CrmContext) === 2 && sharedTag(user, candidate);
              })
              .map((candidate) => ({
                email: candidate.email,
                name: candidate.name,
                role: candidate.role,
                hasLogin: true
              }))
              .sort((a, b) => a.name.localeCompare(b.name))
          : [];

      // P9: Direct is synthesised into the "view a user's dashboard" picker for L4+ only.
      if (level >= DIRECT_VISIBLE_FROM_LEVEL) {
        const direct = directVirtualUser();
        peers.push({ email: direct.email, name: direct.name, role: direct.role, hasLogin: false });
      }

      return {
        user: { email: normalizeEmail(user.email), name: user.name, role: user.role, level },
        settings: {
          stages: [...DEFAULT_SETTINGS.STAGES],
          outcomes: [...DEFAULT_SETTINGS.OUTCOMES],
          // P7: the backfill placeholder is recognised server-side but never offered.
          tags: [...SELECTABLE_TAGS],
          types: [...DEFAULT_SETTINGS.TYPES],
          priorities: [...DEFAULT_SETTINGS.PRIORITIES],
          categories: [...DEFAULT_SETTINGS.CATEGORIES],
          sources: [...DEFAULT_SETTINGS.SOURCES],
          taxPct: DEFAULT_SETTINGS.TAX_PCT,
          currency: DEFAULT_SETTINGS.CURRENCY,
          company: DEFAULT_SETTINGS.COMPANY
        },
        nav: { admin: level >= 6 },
        isL1: level <= 1,
        isBackend: level >= 5,
        peers,
        self: level <= 4 ? await computeDash(user.email).catch(() => null) : null,
        recent
      };
    },

    async dashboard(user: CrmContext, forEmail?: unknown) {
      const users = await repo.listUsers();
      const idx = userIndex(users);
      // `direct` has no '@', so it must be recognised before expandEmail() appends a domain.
      const target = isDirect(forEmail as string)
        ? DIRECT_EMAIL
        : forEmail
          ? expandEmail(forEmail)
          : normalizeEmail(user.email);

      // P9: the Direct subject is virtual - it has no public.users row to validate against.
      if (isDirect(target)) {
        if (roleLevel(user) < DIRECT_VISIBLE_FROM_LEVEL) {
          throw new Error(
            `Your access level (${user.role}) does not allow this. It needs L${DIRECT_VISIBLE_FROM_LEVEL} or higher.`
          );
        }
        return {
          subject: { email: DIRECT_EMAIL, name: DIRECT_NAME, role: '' },
          dash: await computeDash(DIRECT_EMAIL)
        };
      }

      if (target !== normalizeEmail(user.email)) {
        if (roleLevel(user) < 3) throw new Error('Your access level (L2) does not allow this. It needs L3 or higher.');
        const subject = idx[target];
        if (!subject?.active) throw new Error('That user is not an active CRM user.');
        if (roleLevel(user) < 4) {
          if (roleLevel(subject as CrmContext) !== 2) throw new Error('At L3 you can only view the dashboards of L2 (Sales) users.');
          if (!sharedTag(user, subject)) throw new Error('You can only view dashboards of L2 users who share one of your tags.');
        }
      }

      return {
        subject: {
          email: target,
          name: idx[target]?.name || target,
          role: idx[target]?.role || ''
        },
        dash: await computeDash(target)
      };
    },

    async workspace(user: CrmContext, caseFilter: unknown) {
      const boot = await this.bootstrap(user);
      let customers = null;
      let cases = null;
      try {
        customers = await dependencies.customerService.myCustomers(user);
      } catch {
        customers = null;
      }
      try {
        cases = await dependencies.caseService.listCases(user, caseFilter as never);
      } catch {
        cases = null;
      }
      return { boot, customers, cases };
    }
  };
}

export type DashboardService = ReturnType<typeof createDashboardService>;
