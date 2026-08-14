/**
 * Delete abandoned attachment uploads from the Drive attachments folder.
 *
 * Why this exists: the browser PUTs each file straight to Drive (a 100 MB
 * attachment cannot pass Vercel's 4.5 MB request body limit) and only then
 * calls api_assignTicket with the resulting file ids. If any PUT fails, or the
 * user cancels, or the tab is closed, the completed uploads stay in Drive and
 * the server never learns their ids - so the service's own cleanup
 * (deleteStillUnreferencedUploads) cannot reach them, and nothing else deletes
 * them either. A cancelled 100 MB upload leaves 100 MB behind every time, and
 * exhausting the Workspace storage would break the quotation upload path too.
 *
 * The rule this script enforces: a file in the attachments folder that no
 * case_attachments row references, and that is older than the grace period, was
 * abandoned. The grace period matters - a file uploaded seconds ago may belong
 * to a handover that is still being submitted.
 *
 * DRY RUN BY DEFAULT. It prints what it would delete and changes nothing unless
 * --delete is passed.
 *
 * Usage (PowerShell) - load secrets from .env.local without displaying them:
 *   $env:DATABASE_URL = (Select-String -Path .env.local -Pattern '^DATABASE_URL=').Line.Substring(13).Trim('"')
 *   $env:GOOGLE_DRIVE_CLIENT_ID = (Select-String -Path .env.local -Pattern '^GOOGLE_DRIVE_CLIENT_ID=').Line.Split('=',2)[1].Trim('"')
 *   $env:GOOGLE_DRIVE_CLIENT_SECRET = (Select-String -Path .env.local -Pattern '^GOOGLE_DRIVE_CLIENT_SECRET=').Line.Split('=',2)[1].Trim('"')
 *   $env:GOOGLE_DRIVE_REFRESH_TOKEN = (Select-String -Path .env.local -Pattern '^GOOGLE_DRIVE_REFRESH_TOKEN=').Line.Split('=',2)[1].Trim('"')
 *   node scripts/reap-orphan-attachments.mjs                 # dry run, deletes nothing
 *   node scripts/reap-orphan-attachments.mjs --delete        # actually deletes
 *   node scripts/reap-orphan-attachments.mjs --older-than 72 # different grace period, in hours
 *
 * Never logs a raw error object: a GaxiosError carries the OAuth access token
 * in .config.headers.Authorization, and console.error(err) would print it.
 */
import postgres from 'postgres';
import { google } from 'googleapis';

const FOLDER_ID_SETTING_KEY = 'GOOGLE_DRIVE_ATTACHMENTS_FOLDER_ID';
const DEFAULT_GRACE_HOURS = 24;

const databaseUrl = process.env.DATABASE_URL;
const clientId = process.env.GOOGLE_DRIVE_CLIENT_ID;
const clientSecret = process.env.GOOGLE_DRIVE_CLIENT_SECRET;
const refreshToken = process.env.GOOGLE_DRIVE_REFRESH_TOKEN;

const reallyDelete = process.argv.includes('--delete');

function graceHours() {
  const flagIndex = process.argv.indexOf('--older-than');
  if (flagIndex === -1) return DEFAULT_GRACE_HOURS;
  const value = Number(process.argv[flagIndex + 1]);
  if (!Number.isFinite(value) || value < 0) {
    console.error('--older-than expects a number of hours, e.g. --older-than 72');
    process.exit(1);
  }
  return value;
}

if (!databaseUrl) {
  console.error('DATABASE_URL is needed. Never paste it into a shared terminal or chat.');
  process.exit(1);
}
if (!clientId || !clientSecret || !refreshToken) {
  console.error('GOOGLE_DRIVE_CLIENT_ID, GOOGLE_DRIVE_CLIENT_SECRET and GOOGLE_DRIVE_REFRESH_TOKEN are all needed.');
  process.exit(1);
}

function safeMessage(err) {
  // Message only. See the note at the top of this file.
  return err && typeof err.message === 'string' ? err.message : 'unknown error';
}

function formatSize(bytes) {
  const value = Number(bytes ?? 0);
  if (!Number.isFinite(value) || value <= 0) return '0 B';
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

const sql = postgres(databaseUrl, { prepare: false });
let exitCode = 0;

try {
  const hours = graceHours();
  const cutoff = new Date(Date.now() - hours * 60 * 60 * 1000);

  const settings = await sql`
    select value from public.settings where key = ${FOLDER_ID_SETTING_KEY} limit 1
  `;
  const folderId = settings[0]?.value?.trim();
  // Thrown rather than process.exit()ed so the finally below still closes the
  // database connection.
  if (!folderId) throw new Error('the attachments folder is not set up yet, so there is nothing to reap');

  const oauth2Client = new google.auth.OAuth2(clientId, clientSecret);
  oauth2Client.setCredentials({ refresh_token: refreshToken });
  const drive = google.drive({ version: 'v3', auth: oauth2Client });

  // Paginated on purpose: this walks the whole folder, unlike the service's
  // per-case listing, so a single 1000-row page is not enough.
  const files = [];
  let pageToken;
  do {
    const response = await drive.files.list({
      q: `'${folderId}' in parents and trashed=false`,
      fields: 'nextPageToken, files(id, name, size, createdTime)',
      pageSize: 1000,
      pageToken,
      supportsAllDrives: true,
      includeItemsFromAllDrives: true
    });
    for (const file of response.data.files ?? []) {
      if (file.id) files.push(file);
    }
    pageToken = response.data.nextPageToken ?? undefined;
  } while (pageToken);

  // The left join, done in memory: every id the database knows about.
  const rows = await sql`select drive_file_id from public.case_attachments`;
  const referenced = new Set(rows.map((row) => row.drive_file_id));

  const orphans = files.filter((file) => {
    if (referenced.has(file.id)) return false;
    // No createdTime is not evidence of age - leave it alone rather than guess.
    if (!file.createdTime) return false;
    const createdAt = new Date(file.createdTime);
    return !Number.isNaN(createdAt.getTime()) && createdAt < cutoff;
  });

  const referencedHere = files.filter((file) => referenced.has(file.id)).length;
  const young = files.length - referencedHere - orphans.length;
  console.log(`Attachments folder: ${files.length} file(s).`);
  console.log(`Referenced by a case_attachments row: ${referencedHere}.`);
  console.log(`Unreferenced but newer than ${hours}h (left alone): ${young}.`);
  console.log(`Unreferenced and older than ${hours}h: ${orphans.length}.\n`);

  let reclaimed = 0;
  for (const file of orphans) {
    reclaimed += Number(file.size ?? 0);
    console.log(`  ${reallyDelete ? 'deleting' : 'would delete'}  ${file.id}  ${formatSize(file.size)}  ${file.name ?? ''}  (created ${file.createdTime})`);
    if (!reallyDelete) continue;
    try {
      await drive.files.delete({ fileId: file.id, supportsAllDrives: true });
    } catch (err) {
      console.error(`  ! could not delete ${file.id}: ${safeMessage(err)}`);
      exitCode = 1;
    }
  }

  console.log(`\n${reallyDelete ? 'Reclaimed' : 'Would reclaim'} ${formatSize(reclaimed)} across ${orphans.length} file(s).`);
  if (!reallyDelete && orphans.length > 0) {
    console.log('This was a dry run. Re-run with --delete to actually remove them.');
  }
} catch (err) {
  console.error(`Reaping orphaned attachments failed: ${safeMessage(err)}`);
  exitCode = 1;
} finally {
  await sql.end();
}

process.exitCode = exitCode;
