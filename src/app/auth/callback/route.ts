import { NextRequest, NextResponse } from 'next/server';

import { requireActiveCrmUser } from '../../../server/auth/context';
import { createSupabaseRouteClient } from '../../../server/auth/supabase';

function safeRelativePath(path: string | null): string {
  if (!path || !path.startsWith('/') || path.startsWith('//')) return '/';
  return path;
}

function loginRedirect(request: NextRequest, message: string): NextResponse {
  const loginUrl = new URL('/login', request.url);
  loginUrl.searchParams.set('error', message);
  return NextResponse.redirect(loginUrl);
}

export async function GET(request: NextRequest) {
  const requestUrl = new URL(request.url);
  const code = requestUrl.searchParams.get('code');
  const nextPath = safeRelativePath(requestUrl.searchParams.get('next'));

  if (!code) {
    return loginRedirect(request, 'Sign in could not be completed.');
  }

  const successUrl = new URL(nextPath, request.url);
  const response = NextResponse.redirect(successUrl);
  const supabase = createSupabaseRouteClient(request, response);
  const { error } = await supabase.auth.exchangeCodeForSession(code);

  if (error) {
    return loginRedirect(request, 'Sign in could not be completed.');
  }

  const {
    data: { user }
  } = await supabase.auth.getUser();

  try {
    await requireActiveCrmUser(user?.email ?? '');
    return response;
  } catch {
    await supabase.auth.signOut();
    const deniedUrl = new URL('/login', request.url);
    deniedUrl.searchParams.set('error', 'Your account is not allowed to access AS CRM.');
    response.headers.set('location', deniedUrl.toString());
    return response;
  }
}
