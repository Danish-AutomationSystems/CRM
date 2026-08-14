import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const filesCreate = vi.fn();
const filesList = vi.fn();
const filesCopy = vi.fn();
const filesExport = vi.fn();
const filesUpdate = vi.fn();
const filesDelete = vi.fn();
const permissionsCreate = vi.fn();
const filesGet = vi.fn();
const getAccessToken = vi.fn();
const fetchMock = vi.fn();

vi.mock('googleapis', () => ({
  google: {
    auth: {
      OAuth2: vi.fn().mockImplementation(() => ({ setCredentials: vi.fn(), getAccessToken }))
    },
    drive: vi.fn().mockImplementation(() => ({
      files: {
        create: filesCreate,
        list: filesList,
        copy: filesCopy,
        export: filesExport,
        update: filesUpdate,
        delete: filesDelete,
        get: filesGet
      },
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
    filesUpdate.mockReset();
    filesDelete.mockReset();
    permissionsCreate.mockReset();
    filesGet.mockReset();
    getAccessToken.mockReset();
    getAccessToken.mockResolvedValue({ token: 'ya29.test-access-token' });
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
    process.env.GOOGLE_DRIVE_CLIENT_ID = 'test-client-id';
    process.env.GOOGLE_DRIVE_CLIENT_SECRET = 'test-client-secret';
    process.env.GOOGLE_DRIVE_REFRESH_TOKEN = 'test-refresh-token';
  });

  afterEach(() => {
    vi.unstubAllGlobals();
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

  it('renames a file', async () => {
    filesUpdate.mockResolvedValue({ data: { id: 'file-123' } });

    const { createDriveClient } = await import('./client');
    await createDriveClient().renameFile('file-123', 'QTN-2026-0001 R0 - Acme Controls - offer.pdf');

    expect(filesUpdate).toHaveBeenCalledWith({
      fileId: 'file-123',
      requestBody: { name: 'QTN-2026-0001 R0 - Acme Controls - offer.pdf' },
      supportsAllDrives: true
    });
  });

  it('does not rethrow the raw Google error when a rename fails', async () => {
    const gaxiosLike = Object.assign(new Error('Invalid Credentials'), {
      code: 401,
      config: { headers: { Authorization: 'Bearer ya29.test-access-token' } }
    });
    filesUpdate.mockRejectedValue(gaxiosLike);
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});

    const { createDriveClient } = await import('./client');
    const error = await createDriveClient()
      .renameFile('file-123', 'new name.pdf')
      .catch((err: unknown) => err);
    const logged = errorLog.mock.calls.flat().map((part) => String(part)).join(' ');
    errorLog.mockRestore();

    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBe(gaxiosLike);
    // Fixed wording: no Google message, and nothing matching USER_FACING_PATTERNS.
    expect((error as Error).message).toBe('Drive rename did not succeed (HTTP 401).');
    expect(JSON.stringify(error, Object.getOwnPropertyNames(error))).not.toContain('ya29.test-access-token');
    expect(logged).not.toContain('ya29.test-access-token');
    expect(logged).not.toContain('Bearer');
  });

  it('does not rethrow the raw Google error when a folder listing fails', async () => {
    const gaxiosLike = Object.assign(new Error('Login Required'), {
      code: 403,
      config: { headers: { Authorization: 'Bearer ya29.test-access-token' } }
    });
    filesList.mockRejectedValue(gaxiosLike);
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});

    const { createDriveClient } = await import('./client');
    const error = await createDriveClient()
      .listFileNamesInFolder('folder-att', 'CASE-2026-0001')
      .catch((err: unknown) => err);
    const logged = errorLog.mock.calls.flat().map((part) => String(part)).join(' ');
    errorLog.mockRestore();

    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBe(gaxiosLike);
    expect((error as Error).message).toBe('Drive folder listing did not succeed (HTTP 403).');
    expect(JSON.stringify(error, Object.getOwnPropertyNames(error))).not.toContain('ya29.test-access-token');
    expect(logged).not.toContain('ya29.test-access-token');
    expect(logged).not.toContain('Bearer');
  });

  it('deletes a file', async () => {
    filesDelete.mockResolvedValue({ data: {} });

    const { createDriveClient } = await import('./client');
    await createDriveClient().deleteFile('file-123');

    expect(filesDelete).toHaveBeenCalledWith({ fileId: 'file-123', supportsAllDrives: true });
  });

  describe('createResumableSession', () => {
    function sessionResponse(location: string | null, init: { ok?: boolean; status?: number } = {}) {
      const headers = new Headers();
      if (location !== null) headers.set('Location', location);
      return { ok: init.ok ?? true, status: init.status ?? 200, headers };
    }

    it('returns the Location response header as the session URL', async () => {
      fetchMock.mockResolvedValue(sessionResponse('https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&upload_id=SESSION-1'));

      const { createDriveClient } = await import('./client');
      const result = await createDriveClient().createResumableSession({
        fileName: 'spec.pdf',
        mimeType: 'application/pdf',
        sizeBytes: 104857600,
        folderId: 'folder-att'
      });

      expect(result.sessionUrl).toBe(
        'https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&upload_id=SESSION-1'
      );
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, init] = fetchMock.mock.calls[0] as [string, { method: string }];
      expect(url).toBe('https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&supportsAllDrives=true');
      expect(init.method).toBe('POST');
    });

    it('declares the upload size and content type as X-Upload-Content-* headers', async () => {
      fetchMock.mockResolvedValue(sessionResponse('https://upload.example/session'));

      const { createDriveClient } = await import('./client');
      await createDriveClient().createResumableSession({
        fileName: 'drawing.dwg',
        mimeType: 'image/vnd.dwg',
        sizeBytes: 52428800,
        folderId: 'folder-att'
      });

      const [, init] = fetchMock.mock.calls[0] as [string, { headers: Record<string, string> }];
      expect(init.headers['X-Upload-Content-Type']).toBe('image/vnd.dwg');
      expect(init.headers['X-Upload-Content-Length']).toBe('52428800');
      expect(init.headers['Content-Type']).toBe('application/json; charset=UTF-8');
      expect(init.headers.Authorization).toBe('Bearer ya29.test-access-token');
    });

    it('places the new file in the requested folder', async () => {
      fetchMock.mockResolvedValue(sessionResponse('https://upload.example/session'));

      const { createDriveClient } = await import('./client');
      await createDriveClient().createResumableSession({
        fileName: 'site-photo.jpg',
        mimeType: 'image/jpeg',
        sizeBytes: 2048,
        folderId: 'folder-att'
      });

      const [, init] = fetchMock.mock.calls[0] as [string, { body: string }];
      expect(JSON.parse(init.body)).toEqual({ name: 'site-photo.jpg', parents: ['folder-att'] });
    });

    it('throws a clear error when Google returns no Location header', async () => {
      fetchMock.mockResolvedValue(sessionResponse(null));

      const { createDriveClient } = await import('./client');
      await expect(
        createDriveClient().createResumableSession({
          fileName: 'a.pdf',
          mimeType: 'application/pdf',
          sizeBytes: 10,
          folderId: 'folder-att'
        })
      ).rejects.toThrow('Google did not return an upload session URL.');
    });

    it('throws without leaking the access token when Google rejects the request', async () => {
      fetchMock.mockResolvedValue(sessionResponse(null, { ok: false, status: 403 }));

      const { createDriveClient } = await import('./client');
      const error = await createDriveClient()
        .createResumableSession({ fileName: 'a.pdf', mimeType: 'application/pdf', sizeBytes: 10, folderId: 'f' })
        .catch((err: unknown) => err);

      expect(error).toBeInstanceOf(Error);
      expect(String(error)).toContain('403');
      expect(JSON.stringify(error, Object.getOwnPropertyNames(error))).not.toContain('ya29.test-access-token');
    });

    it('returns only a sessionUrl - never the access token or request headers', async () => {
      fetchMock.mockResolvedValue(sessionResponse('https://upload.example/session'));

      const { createDriveClient } = await import('./client');
      const result = await createDriveClient().createResumableSession({
        fileName: 'a.pdf',
        mimeType: 'application/pdf',
        sizeBytes: 10,
        folderId: 'folder-att'
      });

      expect(Object.keys(result)).toEqual(['sessionUrl']);
      expect(JSON.stringify(result)).not.toContain('ya29.test-access-token');
    });

    it('throws when no access token can be obtained', async () => {
      getAccessToken.mockResolvedValue({ token: null });

      const { createDriveClient } = await import('./client');
      await expect(
        createDriveClient().createResumableSession({
          fileName: 'a.pdf',
          mimeType: 'application/pdf',
          sizeBytes: 10,
          folderId: 'folder-att'
        })
      ).rejects.toThrow('Could not obtain a Google access token.');
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  describe('getFileMeta', () => {
    it('returns the parsed metadata with size coerced to a number', async () => {
      filesGet.mockResolvedValue({
        data: {
          id: 'file-999',
          name: 'spec.pdf',
          size: '104857600',
          mimeType: 'application/pdf',
          webViewLink: 'https://drive.google.com/file/d/file-999/view',
          parents: ['folder-att']
        }
      });

      const { createDriveClient } = await import('./client');
      const meta = await createDriveClient().getFileMeta('file-999');

      expect(meta).toEqual({
        id: 'file-999',
        name: 'spec.pdf',
        size: 104857600,
        mimeType: 'application/pdf',
        webViewLink: 'https://drive.google.com/file/d/file-999/view',
        parents: ['folder-att']
      });
      expect(typeof meta?.size).toBe('number');
      expect(filesGet).toHaveBeenCalledWith(
        expect.objectContaining({
          fileId: 'file-999',
          fields: 'id, name, size, mimeType, webViewLink, parents, trashed',
          supportsAllDrives: true
        })
      );
    });

    it('returns null for a trashed file, which Drive still answers in full', async () => {
      // A file trashed between upload and commit keeps its parents and its name,
      // so without this it passes every verification check and the row that gets
      // written points at a link that 404s.
      filesGet.mockResolvedValue({
        data: {
          id: 'file-999',
          name: 'CASE-2026-0001 - spec.pdf',
          size: '10',
          mimeType: 'application/pdf',
          webViewLink: 'https://drive.google.com/file/d/file-999/view',
          parents: ['folder-att'],
          trashed: true
        }
      });

      const { createDriveClient } = await import('./client');
      await expect(createDriveClient().getFileMeta('file-999')).resolves.toBeNull();
    });

    it('still returns metadata when Drive reports trashed: false', async () => {
      filesGet.mockResolvedValue({
        data: { id: 'file-999', name: 'a.pdf', size: '10', mimeType: 'application/pdf', webViewLink: '', parents: ['folder-att'], trashed: false }
      });

      const { createDriveClient } = await import('./client');
      await expect(createDriveClient().getFileMeta('file-999')).resolves.toMatchObject({ id: 'file-999' });
    });

    it('returns null when Drive answers 404', async () => {
      filesGet.mockRejectedValue(Object.assign(new Error('File not found: file-nope.'), { code: 404 }));

      const { createDriveClient } = await import('./client');
      await expect(createDriveClient().getFileMeta('file-nope')).resolves.toBeNull();
    });

    it('returns null when the 404 is reported on the response', async () => {
      filesGet.mockRejectedValue(Object.assign(new Error('Not Found'), { response: { status: 404 } }));

      const { createDriveClient } = await import('./client');
      await expect(createDriveClient().getFileMeta('file-nope')).resolves.toBeNull();
    });

    it('does not swallow non-404 failures, and does not rethrow the raw Google error', async () => {
      const gaxiosLike = Object.assign(new Error('Rate limit exceeded'), {
        code: 429,
        config: { headers: { Authorization: 'Bearer ya29.test-access-token' } }
      });
      filesGet.mockRejectedValue(gaxiosLike);
      const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});

      const { createDriveClient } = await import('./client');
      const error = await createDriveClient()
        .getFileMeta('file-999')
        .catch((err: unknown) => err);
      const logged = errorLog.mock.calls.flat().map(String).join(' ');
      errorLog.mockRestore();

      expect(error).toBeInstanceOf(Error);
      expect(error).not.toBe(gaxiosLike);
      expect((error as Error).message).toBe('Drive file metadata lookup did not succeed (HTTP 429).');
      expect(JSON.stringify(error, Object.getOwnPropertyNames(error))).not.toContain('ya29.test-access-token');
      // The detail is kept for operators, as a message - never the object.
      expect(logged).toContain('Rate limit exceeded');
      expect(logged).not.toContain('ya29.test-access-token');
    });

    it('never embeds a Google auth message that the RPC layer would show the user', async () => {
      const { normalizeRpcError } = await import('../rpc/errors');
      const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
      const { createDriveClient } = await import('./client');

      for (const googleMessage of ['Invalid Credentials', 'Login Required']) {
        filesGet.mockRejectedValue(
          Object.assign(new Error(googleMessage), {
            code: 401,
            config: { headers: { Authorization: 'Bearer ya29.test-access-token' } }
          })
        );

        const error = await createDriveClient()
          .getFileMeta('file-999')
          .catch((err: unknown) => err);

        expect((error as Error).message).not.toContain(googleMessage);
        // /invalid/i and /required/i are USER_FACING_PATTERNS: a message carrying
        // Google's wording would be forwarded verbatim to the browser.
        const rpcError = normalizeRpcError(error);
        expect(rpcError.status).toBe(500);
        expect(rpcError.message).toBe('Something went wrong.');
      }

      errorLog.mockRestore();
    });
  });

  describe('listFileNamesInFolder', () => {
    it('returns the names of this case\'s non-trashed files in the folder', async () => {
      filesList.mockResolvedValue({ data: { files: [{ name: 'spec.pdf' }, { name: 'photo.jpg' }] } });

      const { createDriveClient } = await import('./client');
      const names = await createDriveClient().listFileNamesInFolder('folder-att', 'CASE-2026-0001');

      expect(names).toEqual(['spec.pdf', 'photo.jpg']);
      expect(filesList).toHaveBeenCalledWith(
        expect.objectContaining({
          q: "'folder-att' in parents and trashed=false and name contains 'CASE-2026-0001 - '",
          fields: 'files(name)',
          supportsAllDrives: true
        })
      );
    });

    it('escapes quotes and backslashes in the case id before building the query', async () => {
      filesList.mockResolvedValue({ data: { files: [] } });

      const { createDriveClient } = await import('./client');
      await createDriveClient().listFileNamesInFolder('folder-att', "CASE' or '1'='1\\");

      const [args] = filesList.mock.calls[0] as [{ q: string }];
      expect(args.q).toBe(
        "'folder-att' in parents and trashed=false and name contains 'CASE\\' or \\'1\\'=\\'1\\\\ - '"
      );
    });

    it('returns an empty list when the folder holds nothing for this case', async () => {
      filesList.mockResolvedValue({ data: {} });

      const { createDriveClient } = await import('./client');
      await expect(createDriveClient().listFileNamesInFolder('folder-att', 'CASE-2026-0001')).resolves.toEqual([]);
    });
  });
});
