import { Readable } from 'node:stream';

export type DriveFileUpload = {
  fileName: string;
  mimeType: string;
  body: Buffer;
};

export type DriveClient = {
  uploadFile(input: DriveFileUpload, folderId: string): Promise<{ id: string; webViewLink: string }>;
  listDocsInFolder(folderId: string): Promise<Array<{ id: string; name: string }>>;
  copyFile(fileId: string, name: string, folderId: string): Promise<{ id: string; webViewLink: string }>;
  exportPdf(fileId: string): Promise<Buffer>;
  shareDomainReadable(fileId: string): Promise<void>;
};

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

  async function driveApi() {
    // Lazily load googleapis: this file is imported unconditionally on the
    // hot /api/rpc path (via quotes/rpc.ts), and the root googleapis
    // package eagerly wires up hundreds of Google API services. Deferring
    // the import until a Drive call actually happens keeps that cost off
    // every other RPC call. Keep this a dynamic import - never a top-level one.
    const { google } = await import('googleapis');

    // Use already-validated values from closure
    const oauth2Client = new google.auth.OAuth2(clientId, clientSecret);
    oauth2Client.setCredentials({ refresh_token: refreshToken });
    return google.drive({ version: 'v3', auth: oauth2Client });
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

    shareDomainReadable
  };
}
