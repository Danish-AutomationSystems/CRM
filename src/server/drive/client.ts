import { Readable } from 'node:stream';

export type DriveFileUpload = {
  fileName: string;
  mimeType: string;
  body: Buffer;
};

export type ResumableSessionInput = {
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  folderId: string;
};

export type DriveFileMeta = {
  id: string;
  name: string;
  size: number;
  mimeType: string;
  webViewLink: string;
  parents: string[];
};

export type DriveClient = {
  uploadFile(input: DriveFileUpload, folderId: string): Promise<{ id: string; webViewLink: string }>;
  listDocsInFolder(folderId: string): Promise<Array<{ id: string; name: string }>>;
  copyFile(fileId: string, name: string, folderId: string): Promise<{ id: string; webViewLink: string }>;
  exportPdf(fileId: string): Promise<Buffer>;
  shareDomainReadable(fileId: string): Promise<void>;
  renameFile(fileId: string, name: string): Promise<void>;
  deleteFile(fileId: string): Promise<void>;
  createResumableSession(input: ResumableSessionInput): Promise<{ sessionUrl: string }>;
  getFileMeta(fileId: string): Promise<DriveFileMeta | null>;
  /**
   * Names of this case's files in the attachments folder. Scoped to one case on
   * purpose: the folder is shared by every case, and an unscoped listing is
   * capped at one page - past 1000 files the caller would stop seeing the
   * collisions it disambiguates against and two attachments could end up with
   * identical names.
   */
  listFileNamesInFolder(folderId: string, caseId: string): Promise<string[]>;
};

const RESUMABLE_UPLOAD_URL =
  'https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&supportsAllDrives=true';

/**
 * Pull an HTTP status out of a Google API rejection without touching the error
 * object itself: a GaxiosError carries the bearer token in
 * `.config.headers.Authorization`, so it must never be logged or rethrown.
 */
function httpStatusOf(error: unknown): number | null {
  if (typeof error !== 'object' || error === null) return null;
  const candidate = error as { code?: unknown; status?: unknown; response?: { status?: unknown } };
  for (const value of [candidate.code, candidate.status, candidate.response?.status]) {
    if (typeof value === 'number') return value;
    if (typeof value === 'string' && /^\d+$/.test(value)) return Number(value);
  }
  return null;
}

/**
 * Turn a Google API rejection into an error that is safe to propagate.
 *
 * A GaxiosError carries `.config.headers.Authorization = "Bearer ya29..."` as an
 * own enumerable property, so anything that prints the object - `console.error(err)`,
 * an uncaught throw, a serialiser - prints the access token. Every Drive call that
 * can reject must funnel through here: the detail is logged as a message only, and
 * the caller receives a brand new Error carrying nothing but an operation name and
 * an HTTP status.
 *
 * The returned message is deliberately fixed wording. `normalizeRpcError`
 * (src/server/rpc/errors.ts) forwards any message matching USER_FACING_PATTERNS
 * straight to the browser, and Google's classic failures ("Invalid Credentials",
 * "Login Required") match /invalid/i and /required/i - embedding them would leak
 * internal auth state to the user.
 */
function safeDriveError(operation: string, error: unknown): Error {
  const status = httpStatusOf(error);
  console.error(
    `Drive ${operation} failed:`,
    error instanceof Error ? error.message : String(status ?? 'unknown error')
  );
  return new Error(
    status === null ? `Drive ${operation} did not succeed.` : `Drive ${operation} did not succeed (HTTP ${status}).`
  );
}

/**
 * Escape a value for interpolation into a Drive `q` search string. Drive query
 * literals are single-quoted, and a backslash escapes the next character - so a
 * value containing a quote or a backslash would otherwise change the meaning of
 * the query. Order matters: backslashes first, or the escapes get double-escaped.
 */
function escapeDriveQueryValue(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not configured.`);
  return value;
}

export function createDriveClient(): DriveClient {
  // Validate env vars at construction time and capture in closure
  const clientId = requireEnv('GOOGLE_DRIVE_CLIENT_ID');
  const clientSecret = requireEnv('GOOGLE_DRIVE_CLIENT_SECRET');
  const refreshToken = requireEnv('GOOGLE_DRIVE_REFRESH_TOKEN');

  async function googleClients() {
    // Lazily load googleapis: this file is imported unconditionally on the
    // hot /api/rpc path (via quotes/rpc.ts), and the root googleapis
    // package eagerly wires up hundreds of Google API services. Deferring
    // the import until a Drive call actually happens keeps that cost off
    // every other RPC call. Keep this a dynamic import - never a top-level one.
    const { google } = await import('googleapis');

    // Use already-validated values from closure
    const oauth2Client = new google.auth.OAuth2(clientId, clientSecret);
    oauth2Client.setCredentials({ refresh_token: refreshToken });
    return { oauth2Client, drive: google.drive({ version: 'v3', auth: oauth2Client }) };
  }

  async function driveApi() {
    return (await googleClients()).drive;
  }

  async function shareDomainReadable(fileId: string): Promise<void> {
    const drive = await driveApi();
    try {
      await drive.permissions.create({
        fileId,
        requestBody: {
          type: 'domain',
          domain: process.env.CRM_ALLOWED_DOMAIN || 'automationsystems.org',
          role: 'reader'
        }
      });
    } catch {
      // Some Workspace domains restrict link sharing - the file still
      // exists and the operation still succeeds either way (mirrors the
      // legacy Apps Script behavior at Code.gs:1722).
    }
  }

  return {
    async uploadFile(input: DriveFileUpload, folderId: string) {
      const drive = await driveApi();

      const response = await drive.files.create({
        requestBody: { name: input.fileName, parents: [folderId] },
        media: { mimeType: input.mimeType, body: Readable.from(input.body) },
        fields: 'id, webViewLink'
      });

      const fileId = response.data.id;
      if (!fileId) throw new Error('Drive did not return a file id.');

      await shareDomainReadable(fileId);

      return { id: fileId, webViewLink: response.data.webViewLink ?? '' };
    },

    async listDocsInFolder(folderId: string) {
      const drive = await driveApi();
      const response = await drive.files.list({
        q: `'${folderId}' in parents and mimeType='application/vnd.google-apps.document' and trashed=false`,
        fields: 'files(id, name)',
        orderBy: 'name'
      });
      return (response.data.files ?? [])
        .map((file) => ({ id: String(file.id ?? ''), name: String(file.name ?? '') }))
        .filter((file) => file.id && file.name);
    },

    async copyFile(fileId: string, name: string, folderId: string) {
      const drive = await driveApi();
      const response = await drive.files.copy({
        fileId,
        requestBody: { name, parents: [folderId] },
        fields: 'id, webViewLink'
      });
      const copyId = response.data.id;
      if (!copyId) throw new Error('Drive did not return a file id.');
      return { id: copyId, webViewLink: response.data.webViewLink ?? '' };
    },

    async exportPdf(fileId: string) {
      const drive = await driveApi();
      const response = await drive.files.export(
        { fileId, mimeType: 'application/pdf' },
        { responseType: 'arraybuffer' }
      );
      return Buffer.from(response.data as ArrayBuffer);
    },

    shareDomainReadable,

    async renameFile(fileId: string, name: string) {
      const drive = await driveApi();
      try {
        await drive.files.update({ fileId, requestBody: { name }, supportsAllDrives: true });
      } catch (err) {
        // assignTicket rethrows whatever this rejects with, and the RPC layer
        // logs it: a raw GaxiosError would put the bearer token in the logs.
        throw safeDriveError('rename', err);
      }
    },

    async deleteFile(fileId: string) {
      const drive = await driveApi();
      try {
        await drive.files.delete({ fileId, supportsAllDrives: true });
      } catch (err) {
        throw safeDriveError('delete', err);
      }
    },

    /**
     * Open a Drive resumable upload session so the browser can PUT the bytes
     * straight to Google. Vercel caps a serverless request body at 4.5 MB and
     * base64 inflates by a third, so a 100 MB attachment cannot pass through
     * this server at all - only the session URL crosses back to the client.
     *
     * The access token authorises this one POST and stays in this function.
     */
    async createResumableSession(input: ResumableSessionInput) {
      const { oauth2Client } = await googleClients();

      const accessToken = (await oauth2Client.getAccessToken())?.token;
      if (!accessToken) throw new Error('Could not obtain a Google access token.');

      const response = await fetch(RESUMABLE_UPLOAD_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json; charset=UTF-8',
          'X-Upload-Content-Type': input.mimeType,
          'X-Upload-Content-Length': String(input.sizeBytes)
        },
        body: JSON.stringify({ name: input.fileName, parents: [input.folderId] })
      });

      if (!response.ok) {
        // Status only: the response and any error object built from it can
        // carry the request headers, and those hold the bearer token.
        throw new Error(`Google refused the upload session (HTTP ${response.status}).`);
      }

      const sessionUrl = response.headers.get('Location');
      if (!sessionUrl) throw new Error('Google did not return an upload session URL.');

      return { sessionUrl };
    },

    async getFileMeta(fileId: string): Promise<DriveFileMeta | null> {
      const drive = await driveApi();

      try {
        const response = await drive.files.get({
          fileId,
          fields: 'id, name, size, mimeType, webViewLink, parents, trashed',
          supportsAllDrives: true
        });
        const file = response.data;
        const id = file.id;
        if (!id) return null;
        // files.get still returns a trashed file, parents intact, so a file
        // trashed between upload and commit would pass every verification check
        // and leave a row pointing at a link that 404s. Unconfirmable = null.
        if (file.trashed === true) return null;

        return {
          id,
          name: file.name ?? '',
          size: Number(file.size ?? 0),
          mimeType: file.mimeType ?? '',
          webViewLink: file.webViewLink ?? '',
          parents: file.parents ?? []
        };
      } catch (err) {
        // A missing or inaccessible file is a verification failure, not a
        // crash - callers treat null as "could not confirm this upload".
        const status = httpStatusOf(err);
        if (status === 404 || status === 403) return null;

        // Fixed wording, Google's message logged rather than embedded: the RPC
        // layer forwards any message matching USER_FACING_PATTERNS to the
        // browser, and "Invalid Credentials"/"Login Required" match /invalid/i
        // and /required/i - which would tell a user about our auth state.
        throw safeDriveError('file metadata lookup', err);
      }
    },

    async listFileNamesInFolder(folderId: string, caseId: string) {
      const drive = await driveApi();
      let response;
      try {
        response = await drive.files.list({
          q: `'${folderId}' in parents and trashed=false and name contains '${escapeDriveQueryValue(`${caseId} - `)}'`,
          fields: 'files(name)',
          pageSize: 1000,
          supportsAllDrives: true,
          includeItemsFromAllDrives: true
        });
      } catch (err) {
        // Same reason as renameFile: this rejection reaches the RPC error log.
        throw safeDriveError('folder listing', err);
      }
      return (response.data.files ?? [])
        .map((file) => String(file.name ?? ''))
        .filter((name) => name.length > 0);
    }
  };
}
