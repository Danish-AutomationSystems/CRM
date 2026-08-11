import type { CrmRole } from '../db/schema';

/**
 * "Direct" is a virtual account, never a row in public.users - the users table has a
 * CHECK constraint requiring an @automationsystems.org address, so it cannot exist there.
 * It is only ever stored as public.handlers.user_email = 'direct', and is synthesised
 * into user lists / dashboard subjects at read time.
 */
export const DIRECT_EMAIL = 'direct';
export const DIRECT_NAME = 'Direct';

export function isDirect(value: string | null | undefined): boolean {
  return String(value ?? '').trim().toLowerCase() === DIRECT_EMAIL;
}

export type DirectVirtualUser = {
  email: typeof DIRECT_EMAIL;
  name: typeof DIRECT_NAME;
  role: CrmRole;
  allowedTags: string[];
  active: boolean;
  /** Direct can never sign in; the UI uses this to hide login-only affordances. */
  hasLogin: false;
  virtual: true;
};

/** The minimum role level that may see / select the virtual Direct account. */
export const DIRECT_VISIBLE_FROM_LEVEL = 4;

export function directVirtualUser(): DirectVirtualUser {
  return {
    email: DIRECT_EMAIL,
    name: DIRECT_NAME,
    // L2 is the sales-equivalent level; Direct holds customers but never logs in.
    role: 'L2',
    allowedTags: ['*'],
    active: true,
    hasLogin: false,
    virtual: true
  };
}
