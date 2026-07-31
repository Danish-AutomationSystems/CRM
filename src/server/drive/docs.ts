import type { DocsDocument, DocsRequest } from './template-merge';

export type DocsClient = {
  getDocument(documentId: string): Promise<DocsDocument>;
  batchUpdate(documentId: string, requests: DocsRequest[]): Promise<void>;
};

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not configured.`);
  return value;
}

export function createDocsClient(): DocsClient {
  // Validated eagerly, same contract as createDriveClient - callers on the
  // RPC path must pass this factory lazily, never call it at module scope.
  const clientId = requireEnv('GOOGLE_DRIVE_CLIENT_ID');
  const clientSecret = requireEnv('GOOGLE_DRIVE_CLIENT_SECRET');
  const refreshToken = requireEnv('GOOGLE_DRIVE_REFRESH_TOKEN');

  async function docsApi() {
    // Lazy import: reachable from the hot /api/rpc path.
    const { google } = await import('googleapis');
    const oauth2Client = new google.auth.OAuth2(clientId, clientSecret);
    oauth2Client.setCredentials({ refresh_token: refreshToken });
    return google.docs({ version: 'v1', auth: oauth2Client });
  }

  return {
    async getDocument(documentId: string) {
      const docs = await docsApi();
      const response = await docs.documents.get({ documentId });
      return (response.data ?? {}) as DocsDocument;
    },

    async batchUpdate(documentId: string, requests: DocsRequest[]) {
      if (!requests.length) return;
      const docs = await docsApi();
      await docs.documents.batchUpdate({ documentId, requestBody: { requests } });
    }
  };
}
