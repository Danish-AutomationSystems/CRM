import { NextRequest, NextResponse } from 'next/server';

import { createSupabaseMiddlewareClient } from './server/auth/supabase';

const PROTECTED_PREFIXES = ['/crm', '/api/rpc', '/api/admin'];

function isProtectedPath(pathname: string): boolean {
  return PROTECTED_PREFIXES.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));
}

export async function middleware(request: NextRequest) {
  // SPIKE: proving middleware can hand a header to the route handler before any
  // design depends on it. Reverted once the result is recorded.
  const forwarded = new Headers(request.headers);
  forwarded.set('x-mw-probe', 'middleware-ran');

  const response = NextResponse.next({ request: { headers: forwarded } });
  const supabase = createSupabaseMiddlewareClient(request, response);
  const {
    data: { user }
  } = await supabase.auth.getUser();

  if (!user && isProtectedPath(request.nextUrl.pathname)) {
    const loginUrl = new URL('/login', request.url);
    loginUrl.searchParams.set('next', request.nextUrl.pathname);
    return NextResponse.redirect(loginUrl);
  }

  return response;
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)']
};
