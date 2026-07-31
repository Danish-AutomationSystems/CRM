import { beforeEach, describe, expect, it, vi } from 'vitest';

const filesCreate = vi.fn();
const filesList = vi.fn();
const filesCopy = vi.fn();
const filesExport = vi.fn();
const permissionsCreate = vi.fn();

vi.mock('googleapis', () => ({
  google: {
    auth: {
      OAuth2: vi.fn().mockImplementation(() => ({ setCredentials: vi.fn() }))
    },
    drive: vi.fn().mockImplementation(() => ({
      files: { create: filesCreate, list: filesList, copy: filesCopy, export: filesExport },
      permissions: { create: permissionsCreate }
    }))
  }
}));

describe('createDriveClient', () => {
  beforeEach(() => {
    filesCreate.mockReset();
    filesList.mockReset();
    filesCopy.mockReset();
    filesExport.mockReset();
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

  it('lists only Google Docs in the given folder, newest name order', async () => {
    filesList.mockResolvedValue({ data: { files: [{ id: 'tpl-1', name: 'Standard' }] } });

    const { createDriveClient } = await import('./client');
    const result = await createDriveClient().listDocsInFolder('folder-tpl');

    expect(result).toEqual([{ id: 'tpl-1', name: 'Standard' }]);
    expect(filesList).toHaveBeenCalledWith(
      expect.objectContaining({
        q: "'folder-tpl' in parents and mimeType='application/vnd.google-apps.document' and trashed=false",
        fields: 'files(id, name)',
        orderBy: 'name'
      })
    );
  });

  it('returns an empty list when the folder has no documents', async () => {
    filesList.mockResolvedValue({ data: {} });
    const { createDriveClient } = await import('./client');
    expect(await createDriveClient().listDocsInFolder('folder-tpl')).toEqual([]);
  });

  it('copies a template into the target folder', async () => {
    filesCopy.mockResolvedValue({ data: { id: 'copy-1', webViewLink: 'https://drive.google.com/file/d/copy-1/view' } });

    const { createDriveClient } = await import('./client');
    const result = await createDriveClient().copyFile('tpl-1', 'QTN-2026-0001-R0 - Acme', 'folder-out');

    expect(result).toEqual({ id: 'copy-1', webViewLink: 'https://drive.google.com/file/d/copy-1/view' });
    expect(filesCopy).toHaveBeenCalledWith(
      expect.objectContaining({
        fileId: 'tpl-1',
        requestBody: { name: 'QTN-2026-0001-R0 - Acme', parents: ['folder-out'] },
        fields: 'id, webViewLink'
      })
    );
  });

  it('throws when a copy returns no file id', async () => {
    filesCopy.mockResolvedValue({ data: {} });
    const { createDriveClient } = await import('./client');
    await expect(createDriveClient().copyFile('tpl-1', 'x', 'folder-out')).rejects.toThrow('Drive did not return a file id.');
  });

  it('exports a document to PDF bytes', async () => {
    filesExport.mockResolvedValue({ data: new Uint8Array([37, 80, 68, 70]).buffer });

    const { createDriveClient } = await import('./client');
    const pdf = await createDriveClient().exportPdf('copy-1');

    expect(Buffer.isBuffer(pdf)).toBe(true);
    expect(pdf.subarray(0, 4).toString('latin1')).toBe('%PDF');
    expect(filesExport).toHaveBeenCalledWith(
      { fileId: 'copy-1', mimeType: 'application/pdf' },
      { responseType: 'arraybuffer' }
    );
  });

  it('tolerates a sharing failure on shareDomainReadable', async () => {
    permissionsCreate.mockRejectedValue(new Error('Domain policy blocks link sharing.'));
    const { createDriveClient } = await import('./client');
    await expect(createDriveClient().shareDomainReadable('copy-1')).resolves.toBeUndefined();
  });
});
