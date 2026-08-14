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
  listFileNamesInFolder(folderId: string): Promise<string[]>;
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
      await drive.files.update({ fileId, requestBody: { name } });
    },

    async deleteFile(fileId: string) {
      const drive = await driveApi();
      await drive.files.delete({ fileId });
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
          fields: 'id, name, size, mimeType, webViewLink, parents'
        });
        const file = response.data;
        const id = file.id;
        if (!id) return null;

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

        // Rethrow the message only. The original GaxiosError holds the bearer
        // token in .config.headers.Authorization; it must never propagate.
        const message = err instanceof Error ? err.message : String(status ?? 'unknown error');
        throw new Error(`Drive could not return file metadata: ${message}`);
      }
    },

    async listFileNamesInFolder(folderId: string) {
      const drive = await driveApi();
      const response = await drive.files.list({
        q: `'${folderId}' in parents and trashed=false`,
        fields: 'files(name)',
        pageSize: 1000
      });
      return (response.data.files ?? [])
        .map((file) => String(file.name ?? ''))
        .filter((name) => name.length > 0);
    }
  };
}
