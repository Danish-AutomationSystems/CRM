import { NextResponse } from 'next/server';
import { google } from 'googleapis';

import { getRequestContext } from '../../../../../server/auth/context';
import { ensureAdmin } from '../../../../../server/auth/access';
import { normalizeRpcError } from '../../../../../server/rpc/errors';
import { sql } from '../../../../../server/db/client';

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

  const url = new URL(request.url);
  const code = url.searchParams.get('code');
  if (!code) {
    return NextResponse.json({ error: 'Missing authorization code from Google.' }, { status: 400 });
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

  let refreshToken: string | null | undefined;
  try {
    const { tokens } = await oauth2Client.getToken(code);
    refreshToken = tokens.refresh_token;
    oauth2Client.setCredentials(tokens);
  } catch {
    return NextResponse.json({ error: 'Failed to exchange the authorization code for tokens.' }, { status: 502 });
  }

  if (!refreshToken) {
    return NextResponse.json(
      {
        error:
          'Google did not return a refresh token. Revoke prior access at https://myaccount.google.com/permissions for this app, then try again.'
      },
      { status: 502 }
    );
  }

  const drive = google.drive({ version: 'v3', auth: oauth2Client });
  const folder = await drive.files.create({
    requestBody: { name: 'AS CRM Quotations Testing', mimeType: 'application/vnd.google-apps.folder' },
    fields: 'id'
  });

  const folderId = folder.data.id;
  if (!folderId) {
    return NextResponse.json({ error: 'Drive did not return a folder id.' }, { status: 502 });
  }

  const templatesFolder = await drive.files.create({
    requestBody: { name: 'AS CRM Templates Testing', mimeType: 'application/vnd.google-apps.folder' },
    fields: 'id'
  });
  const templatesFolderId = templatesFolder.data.id;
  if (!templatesFolderId) {
    return NextResponse.json({ error: 'Drive did not return a templates folder id.' }, { status: 502 });
  }

  const starterFile = await drive.files.create({
    requestBody: {
      name: 'Quotation Template - Standard',
      mimeType: 'application/vnd.google-apps.document',
      parents: [templatesFolderId]
    },
    fields: 'id'
  });
  const starterId = starterFile.data.id;
  if (!starterId) {
    return NextResponse.json({ error: 'Drive did not return a starter template id.' }, { status: 502 });
  }

  // Body text mirrors the legacy createStarterTemplate_ (Code.gs:165),
  // including every merge placeholder generateQuoteDoc fills in.
  const starterBody = [
    '{{COMPANY}}',
    'Industrial Automation | Control & Distribution Panels | Energy Management',
    '',
    'QUOTATION',
    'Quote No: {{QUOTE_NO}}    Rev: {{REV}}    Date: {{DATE}}',
    '',
    'To: {{CUSTOMER_NAME}}',
    '{{CUSTOMER_ADDRESS}}',
    'Kind Attn: {{CONTACT_NAME}}',
    '',
    'Subject: {{TITLE}}',
    '',
    'Dear Sir / Madam,',
    'Thank you for your enquiry. We are pleased to submit our offer as per the details below.',
    '',
    '{{BOQ_TABLE}}',
    '',
    'Notes: {{NOTES}}',
    '',
    'Terms & Conditions',
    'Prices: In {{CURRENCY}}, ex-works Ludhiana unless stated otherwise.',
    'Taxes: GST @ {{TAX_PCT}}% included as shown above.',
    'Validity: This offer is valid until {{VALID_UNTIL}}.',
    'Delivery & payment: As mutually agreed at the time of order.',
    '',
    'We look forward to your valued order.',
    '',
    'For {{COMPANY}}',
    '{{PREPARED_BY}}'
  ].join('\n');

  const docsApi = google.docs({ version: 'v1', auth: oauth2Client });
  await docsApi.documents.batchUpdate({
    documentId: starterId,
    requestBody: { requests: [{ insertText: { text: starterBody, location: { index: 1 } } }] }
  });

  await sql`
    insert into public.settings (key, value)
    values
      ('GOOGLE_DRIVE_QUOTATIONS_FOLDER_ID', ${folderId}),
      ('GOOGLE_DRIVE_TEMPLATES_FOLDER_ID', ${templatesFolderId})
    on conflict (key) do update set value = excluded.value
  `;

  return new NextResponse(
    `<!doctype html><html><body style="font-family:monospace;padding:24px;white-space:pre-wrap">Drive folders created and saved to settings:
  Quotations: AS CRM Quotations Testing (id: ${folderId})
  Templates:  AS CRM Templates Testing (id: ${templatesFolderId}) - seeded with "Quotation Template - Standard"

Add this ONE remaining env var to Vercel, then redeploy:

GOOGLE_DRIVE_REFRESH_TOKEN=${refreshToken}

This page will not show this value again - copy it now.</body></html>`,
    { headers: { 'content-type': 'text/html; charset=utf-8' } }
  );
}
