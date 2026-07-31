import { beforeEach, describe, expect, it, vi } from 'vitest';

const documentsGet = vi.fn();
const documentsBatchUpdate = vi.fn();

vi.mock('googleapis', () => ({
  google: {
    auth: { OAuth2: vi.fn().mockImplementation(() => ({ setCredentials: vi.fn() })) },
    docs: vi.fn().mockImplementation(() => ({
      documents: { get: documentsGet, batchUpdate: documentsBatchUpdate }
    }))
  }
}));

describe('createDocsClient', () => {
  beforeEach(() => {
    documentsGet.mockReset();
    documentsBatchUpdate.mockReset();
    process.env.GOOGLE_DRIVE_CLIENT_ID = 'test-client-id';
    process.env.GOOGLE_DRIVE_CLIENT_SECRET = 'test-client-secret';
    process.env.GOOGLE_DRIVE_REFRESH_TOKEN = 'test-refresh-token';
  });

  it('fetches a document by id', async () => {
    documentsGet.mockResolvedValue({ data: { body: { content: [] } } });

    const { createDocsClient } = await import('./docs');
    const doc = await createDocsClient().getDocument('doc-1');

    expect(doc).toEqual({ body: { content: [] } });
    expect(documentsGet).toHaveBeenCalledWith({ documentId: 'doc-1' });
  });

  it('sends batched requests', async () => {
    documentsBatchUpdate.mockResolvedValue({ data: {} });
    const requests = [{ insertText: { text: 'x', location: { index: 1 } } }];

    const { createDocsClient } = await import('./docs');
    await createDocsClient().batchUpdate('doc-1', requests);

    expect(documentsBatchUpdate).toHaveBeenCalledWith({ documentId: 'doc-1', requestBody: { requests } });
  });

  it('skips the API call entirely when there are no requests', async () => {
    const { createDocsClient } = await import('./docs');
    await createDocsClient().batchUpdate('doc-1', []);
    expect(documentsBatchUpdate).not.toHaveBeenCalled();
  });

  it('throws a clear error when required env vars are missing', async () => {
    delete process.env.GOOGLE_DRIVE_CLIENT_ID;
    const { createDocsClient } = await import('./docs');
    expect(() => createDocsClient()).toThrow('GOOGLE_DRIVE_CLIENT_ID is not configured.');
  });
});
