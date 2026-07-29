import { CRM_ROLES, type CrmRole } from '../db/schema';
import { getAuthenticatedEmailFromRequest } from './supabase';

export type CrmContext = {
  email: string;
  name: string;
  role: CrmRole;
  allowedTags: string[];
  active: boolean;
};

export type CrmUser = CrmContext;

export type CrmUserRow = {
  email: string;
  name: string;
  role: string;
  allowed_tags: string[] | string | null;
  active: boolean;
};

export type UserLookup = (email: string) => Promise<CrmUserRow | null>;
export type UserProvisioner = (email: string) => Promise<CrmUserRow | null>;

type RequestContextOptions = {
  getAuthenticatedEmail?: (request: Request) => Promise<string | null>;
  lookupUser?: UserLookup;
};

type NormalizeRoleOptions = {
  allowLegacyImportRoles?: boolean;
};

const LEGACY_ROLE_MAP = {
  Sales: 'L2',
  Manager: 'L4',
  Admin: 'L6'
} as const;

function normalizedAllowedDomain(): string {
  return (process.env.CRM_ALLOWED_DOMAIN ?? 'automationsystems.org')
    .trim()
    .toLowerCase()
    .replace(/^@/, '');
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function normalizeTags(tags: CrmUserRow['allowed_tags']): string[] {
  if (Array.isArray(tags)) {
    return tags.map((tag) => tag.trim()).filter(Boolean);
  }

  if (typeof tags === 'string') {
    return tags
      .split(/[|,]/)
      .map((tag) => tag.trim())
      .filter(Boolean);
  }

  return [];
}

export function assertAllowedDomain(email: string): void {
  const normalizedEmail = normalizeEmail(email);
  const domain = normalizedAllowedDomain();
  const emailDomain = normalizedEmail.includes('@') ? normalizedEmail.split('@').pop() : '';

  if (!emailDomain || emailDomain !== domain) {
    throw new Error(`Please sign in with an Automation Systems Google account (${domain}).`);
  }
}

export function normalizeCrmRole(role: string, options: NormalizeRoleOptions = {}): CrmRole {
  const trimmed = role.trim();
  if ((CRM_ROLES as readonly string[]).includes(trimmed)) return trimmed as CrmRole;

  if (options.allowLegacyImportRoles) {
    const legacyRole = LEGACY_ROLE_MAP[trimmed as keyof typeof LEGACY_ROLE_MAP];
    if (legacyRole) return legacyRole;
  }

  throw new Error(`User has invalid CRM role: ${role || '(blank)'}.`);
}

async function lookupUserByEmail(email: string): Promise<CrmUserRow | null> {
  const { sql } = await import('../db/client');
  const rows = (await sql`
    select email, name, role, allowed_tags, active
    from public.users
    where email = ${email}
    limit 1
  `) as CrmUserRow[];

  return rows[0] ?? null;
}

async function provisionL1UserByEmail(email: string): Promise<CrmUserRow | null> {
  const { sql } = await import('../db/client');
  await sql`
    insert into public.users (email, name, role, allowed_tags, active, added_by)
    values (${email}, ${email}, 'L1', array[]::text[], true, 'auto-provision')
    on conflict (email) do nothing
  `;

  return lookupUserByEmail(email);
}

export async function requireActiveCrmUser(
  email: string,
  lookupUser: UserLookup = lookupUserByEmail,
  provisionUser: UserProvisioner | null = provisionL1UserByEmail
): Promise<CrmUser> {
  const normalizedEmail = normalizeEmail(email);
  assertAllowedDomain(normalizedEmail);

  let user = await lookupUser(normalizedEmail);
  if (!user) {
    user = provisionUser ? await provisionUser(normalizedEmail) : null;
    if (!user) {
      throw new Error('This Google account is not registered in AS CRM.');
    }
  }

  if (!user.active) {
    throw new Error('This AS CRM user is not active.');
  }

  const role = normalizeCrmRole(user.role);

  return {
    email: normalizedEmail,
    name: user.name.trim() || normalizedEmail,
    role,
    allowedTags: normalizeTags(user.allowed_tags),
    active: true
  };
}

export async function getRequestContext(
  request: Request,
  options: RequestContextOptions = {}
): Promise<CrmContext> {
  const getAuthenticatedEmail = options.getAuthenticatedEmail ?? getAuthenticatedEmailFromRequest;
  const email = await getAuthenticatedEmail(request);

  if (!email) {
    throw new Error('Sign in to AS CRM.');
  }

  return requireActiveCrmUser(email, options.lookupUser);
}
