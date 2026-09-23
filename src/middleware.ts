import { NextRequest, NextResponse } from 'next/server';

import { signIdentity } from './server/auth/identity-signature';
import { createSupabaseMiddlewareClient } from './server/auth/supabase';

const PROTECTED_PREFIXES = ['/crm', '/api/rpc', '/api/admin'];

function isProtectedPath(pathname: string): boolean {
  return PROTECTED_PREFIXES.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));
}

export async function middleware(request: NextRequest) {
  const cookieCarrier = NextResponse.next({ request });
  const supabase = createSupabaseMiddlewareClient(request, cookieCarrier);
  const {
    data: { user }
  } = await supabase.auth.getUser();

  if (!user && isProtectedPath(request.nextUrl.pathname)) {
    const loginUrl = new URL('/login', request.url);
    loginUrl.searchParams.set('next', request.nextUrl.pathname);
    return NextResponse.redirect(loginUrl);
  }

  // Always overwrite: a client may send this header, and it must never be trusted.
  const forwarded = new Headers(request.headers);
  forwarded.delete('x-crm-user-email');
  const secret = process.env.CRM_IDENTITY_SECRET;
  if (user?.email && secret) {
    forwarded.set('x-crm-user-email', await signIdentity(user.email, secret));
  }

  const response = NextResponse.next({ request: { headers: forwarded } });
  // Carry over any refreshed auth cookies Supabase wrote while validating.
  cookieCarrier.cookies.getAll().forEach((cookie) => response.cookies.set(cookie));
  return response;
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)']
};
