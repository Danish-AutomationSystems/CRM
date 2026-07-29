import { createServerClient, type CookieOptions } from '@supabase/ssr';
import type { NextRequest, NextResponse } from 'next/server';

type CookiePair = {
  name: string;
  value: string;
};

type CookieToSet = CookiePair & {
  options: CookieOptions;
};

type CookieReadableRequest = Request & {
  cookies?: {
    getAll: () => CookiePair[];
  };
};

function requirePublicSupabaseEnv(): { url: string; key: string } {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;

  if (!url || !key) {
    throw new Error('Supabase public URL and publishable key must be configured.');
  }

  return { url, key };
}

function parseCookieHeader(header: string | null): CookiePair[] {
  if (!header) return [];

  return header
    .split(';')
    .map((cookie) => {
      const separatorIndex = cookie.indexOf('=');
      if (separatorIndex < 0) return null;

      const name = cookie.slice(0, separatorIndex).trim();
      const value = cookie.slice(separatorIndex + 1).trim();
      if (!name) return null;

      return { name, value };
    })
    .filter((cookie): cookie is CookiePair => cookie !== null);
}

function getAllRequestCookies(request: Request): CookiePair[] {
  const cookieRequest = request as CookieReadableRequest;
  if (cookieRequest.cookies?.getAll) return cookieRequest.cookies.getAll();

  return parseCookieHeader(request.headers.get('cookie'));
}

function setAllResponseCookies(response: NextResponse, cookiesToSet: CookieToSet[]): void {
  cookiesToSet.forEach(({ name, value, options }) => {
    response.cookies.set(name, value, options);
  });
}

export function createSupabaseRequestClient(request: Request) {
  const { url, key } = requirePublicSupabaseEnv();

  return createServerClient(url, key, {
    cookies: {
      getAll: () => getAllRequestCookies(request)
    }
  });
}

export function createSupabaseRouteClient(request: NextRequest, response: NextResponse) {
  const { url, key } = requirePublicSupabaseEnv();

  return createServerClient(url, key, {
    cookies: {
      getAll: () => request.cookies.getAll(),
      setAll: (cookiesToSet: CookieToSet[]) => setAllResponseCookies(response, cookiesToSet)
    }
  });
}

export function createSupabaseMiddlewareClient(request: NextRequest, response: NextResponse) {
  const { url, key } = requirePublicSupabaseEnv();

  return createServerClient(url, key, {
    cookies: {
      getAll: () => request.cookies.getAll(),
      setAll: (cookiesToSet: CookieToSet[]) => setAllResponseCookies(response, cookiesToSet)
    }
  });
}

export async function getAuthenticatedEmailFromRequest(request: Request): Promise<string | null> {
  const supabase = createSupabaseRequestClient(request);
  const {
    data: { user },
    error
  } = await supabase.auth.getUser();

  if (error || !user?.email) return null;

  return user.email;
}
