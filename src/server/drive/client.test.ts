import { beforeEach, describe, expect, it, vi } from 'vitest';

const filesCreate = vi.fn();
const permissionsCreate = vi.fn();

vi.mock('googleapis', () => ({
  google: {
    auth: {
      OAuth2: vi.fn().mockImplementation(() => ({ setCredentials: vi.fn() }))
    },
    drive: vi.fn().mockImplementation(() => ({
      files: { create: filesCreate },
      permissions: { create: permissionsCreate }
    }))
  }
}));

describe('createDriveClient', () => {
  beforeEach(() => {
    filesCreate.mockReset();
    permissionsCreate.mockReset();
    process.env.GOOGLE_DRIVE_CLIENT_ID = 'test-client-id';
    process.env.GOOGLE_DRIVE_CLIENT_SECRET = 'test-client-secret';
    process.env.GOOGLE_DRIVE_REFRESH_TOKEN = 'test-refresh-token';
  });

  it('uploads a file and sets domain-shared read access', async () => {
    filesCreate.mockResolvedValue({ data: { id: 'file-123', webViewLink: 'https://drive.google.com/file/d/file-123/view' } });
    permissionsCreate.mockResolvedValue({ data: {} });

    const { createDriveClient } = await import('./client');
    const client = createDriveClient();
    const result = await client.uploadFile(
      { fileName: 'QTN-2026-0001 R0 - Acme Controls - quote.html', mimeType: 'text/html', body: Buffer.from('<html></html>') },
      'folder-abc'
    );

    expect(result).toEqual({ id: 'file-123', webViewLink: 'https://drive.google.com/file/d/file-123/view' });
    expect(filesCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        requestBody: { name: 'QTN-2026-0001 R0 - Acme Controls - quote.html', parents: ['folder-abc'] },
        fields: 'id, webViewLink'
      })
    );
    expect(permissionsCreate).toHaveBeenCalledWith(
      expect.objectContaining({ fileId: 'file-123', requestBody: expect.objectContaining({ type: 'domain', role: 'reader' }) })
    );
  });

  it('tolerates a permission-sharing failure and still returns the uploaded file', async () => {
    filesCreate.mockResolvedValue({ data: { id: 'file-456', webViewLink: 'https://drive.google.com/file/d/file-456/view' } });
    permissionsCreate.mockRejectedValue(new Error('Domain policy blocks link sharing.'));

    const { createDriveClient } = await import('./client');
    const client = createDriveClient();
    const result = await client.uploadFile(
      { fileName: 'file.html', mimeType: 'text/html', body: Buffer.from('x') },
      'folder-abc'
    );

    expect(result.id).toBe('file-456');
  });

  it('throws a clear error when required env vars are missing', async () => {
    delete process.env.GOOGLE_DRIVE_CLIENT_ID;
    const { createDriveClient } = await import('./client');
    expect(() => createDriveClient()).toThrow('GOOGLE_DRIVE_CLIENT_ID is not configured.');
  });
});
