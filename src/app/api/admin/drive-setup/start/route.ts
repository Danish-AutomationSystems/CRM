import { NextResponse } from 'next/server';
import { google } from 'googleapis';

import { getRequestContext } from '../../../../../server/auth/context';
import { ensureAdmin } from '../../../../../server/auth/access';
import { normalizeRpcError } from '../../../../../server/rpc/errors';

const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.file';
const DOCS_SCOPE = 'https://www.googleapis.com/auth/documents';

export async function GET(request: Request): Promise<NextResponse> {
  if (process.env.GOOGLE_DRIVE_REFRESH_TOKEN) {
    return NextResponse.json(
      { error: 'Drive is already configured. Remove GOOGLE_DRIVE_REFRESH_TOKEN to re-run setup.' },
      { status: 409 }
    );
  }

  try {
    const context = await getRequestContext(request);
    ensureAdmin(context);
  } catch (error) {
    const rpcError = normalizeRpcError(error);
    return NextResponse.json({ error: rpcError.message }, { status: rpcError.status });
  }

  const clientId = process.env.GOOGLE_DRIVE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_DRIVE_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    return NextResponse.json(
      { error: 'GOOGLE_DRIVE_CLIENT_ID / GOOGLE_DRIVE_CLIENT_SECRET are not configured.' },
      { status: 500 }
    );
  }

  const redirectUri = new URL('/api/admin/drive-setup/callback', request.url).toString();
  const oauth2Client = new google.auth.OAuth2(clientId, clientSecret, redirectUri);
  const authUrl = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: [DRIVE_SCOPE, DOCS_SCOPE]
  });

  return NextResponse.redirect(authUrl);
}
