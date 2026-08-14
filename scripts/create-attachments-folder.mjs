/**
 * One-time setup: creates the Google Drive folder that will hold ticket
 * handover attachments, and records its id in public.settings.
 *
 * Why this script exists rather than making the folder by hand: the app's
 * OAuth scope is https://www.googleapis.com/auth/drive.file, which only
 * grants access to files/folders the application itself created. A folder
 * made manually in the Drive UI would be invisible to the CRM. So this
 * mirrors how the quotations folder was created in
 * src/app/api/admin/drive-setup/callback/route.ts:63-72.
 *
 * Idempotent: if GOOGLE_DRIVE_ATTACHMENTS_FOLDER_ID is already set in
 * settings, this prints the existing id and exits without creating anything.
 *
 * Usage (PowerShell) - load secrets from .env.local without displaying them:
 *   $env:DATABASE_URL = (Select-String -Path .env.local -Pattern '^DATABASE_URL=').Line.Substring(13).Trim('"')
 *   $env:GOOGLE_DRIVE_CLIENT_ID = (Select-String -Path .env.local -Pattern '^GOOGLE_DRIVE_CLIENT_ID=').Line.Split('=',2)[1].Trim('"')
 *   $env:GOOGLE_DRIVE_CLIENT_SECRET = (Select-String -Path .env.local -Pattern '^GOOGLE_DRIVE_CLIENT_SECRET=').Line.Split('=',2)[1].Trim('"')
 *   $env:GOOGLE_DRIVE_REFRESH_TOKEN = (Select-String -Path .env.local -Pattern '^GOOGLE_DRIVE_REFRESH_TOKEN=').Line.Split('=',2)[1].Trim('"')
 *   node scripts/create-attachments-folder.mjs
 */
import postgres from 'postgres';
import { google } from 'googleapis';

const FOLDER_ID_SETTING_KEY = 'GOOGLE_DRIVE_ATTACHMENTS_FOLDER_ID';
const FOLDER_NAME = 'AS CRM Case Attachments Testing';

const databaseUrl = process.env.DATABASE_URL;
const clientId = process.env.GOOGLE_DRIVE_CLIENT_ID;
const clientSecret = process.env.GOOGLE_DRIVE_CLIENT_SECRET;
const refreshToken = process.env.GOOGLE_DRIVE_REFRESH_TOKEN;

if (!databaseUrl) {
  console.error('DATABASE_URL is required.');
  process.exit(1);
}
if (!clientId || !clientSecret || !refreshToken) {
  console.error('GOOGLE_DRIVE_CLIENT_ID, GOOGLE_DRIVE_CLIENT_SECRET and GOOGLE_DRIVE_REFRESH_TOKEN are all required.');
  process.exit(1);
}

const sql = postgres(databaseUrl, { prepare: false });

try {
  const existing = await sql`
    select value
    from public.settings
    where key = ${FOLDER_ID_SETTING_KEY}
    limit 1
  `;
  const existingId = existing[0]?.value?.trim();

  if (existingId) {
    console.log(`Attachments folder already configured. Existing folder id: ${existingId}`);
    process.exit(0);
  }

  const oauth2Client = new google.auth.OAuth2(clientId, clientSecret);
  oauth2Client.setCredentials({ refresh_token: refreshToken });
  const drive = google.drive({ version: 'v3', auth: oauth2Client });

  const folder = await drive.files.create({
    requestBody: { name: FOLDER_NAME, mimeType: 'application/vnd.google-apps.folder' },
    fields: 'id'
  });

  const folderId = folder.data.id;
  if (!folderId) {
    console.error('Drive did not return a folder id.');
    process.exit(1);
  }

  await sql`
    insert into public.settings (key, value)
    values (${FOLDER_ID_SETTING_KEY}, ${folderId})
    on conflict (key) do update set value = excluded.value
  `;

  console.log(`Created "${FOLDER_NAME}" and saved to settings. Folder id: ${folderId}`);
} catch (err) {
  // Never log the raw error object: Drive/Postgres client errors (e.g. a
  // GaxiosError from drive.files.create) can carry an Authorization bearer
  // token or other request internals as enumerable properties, and both
  // console.error(err) and an uncaught throw would print those to stderr.
  // Only the message is safe to surface.
  console.error(`Failed to set up the attachments folder: ${err?.message ?? 'unknown error'}`);
  process.exitCode = 1;
} finally {
  await sql.end();
}
