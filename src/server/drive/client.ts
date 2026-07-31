import { Readable } from 'node:stream';

export type DriveFileUpload = {
  fileName: string;
  mimeType: string;
  body: Buffer;
};

export type DriveClient = {
  uploadFile(input: DriveFileUpload, folderId: string): Promise<{ id: string; webViewLink: string }>;
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

  return {
    async uploadFile(input: DriveFileUpload, folderId: string) {
      // Lazily load googleapis: this file is imported unconditionally on the
      // hot /api/rpc path (via quotes/rpc.ts), and the root googleapis
      // package eagerly wires up hundreds of Google API services. Deferring
      // the import until a Drive upload actually happens keeps that cost off
      // every other RPC call.
      const { google } = await import('googleapis');

      // Use already-validated values from closure
      const oauth2Client = new google.auth.OAuth2(clientId, clientSecret);
      oauth2Client.setCredentials({ refresh_token: refreshToken });
      const drive = google.drive({ version: 'v3', auth: oauth2Client });

      const response = await drive.files.create({
        requestBody: { name: input.fileName, parents: [folderId] },
        media: { mimeType: input.mimeType, body: Readable.from(input.body) },
        fields: 'id, webViewLink'
      });

      const fileId = response.data.id;
      if (!fileId) throw new Error('Drive did not return a file id.');

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
        // exists and the upload still succeeds either way (mirrors the
        // legacy Apps Script behavior at Code.gs:1722).
      }

      return { id: fileId, webViewLink: response.data.webViewLink ?? '' };
    }
  };
}
