import { beforeEach, describe, expect, it, vi } from 'vitest';

const sqlMock = vi.fn();

vi.mock('../db/client', () => ({
  sql: (...args: unknown[]) => sqlMock(...args)
}));

describe('getDriveAttachmentsFolderId', () => {
  beforeEach(() => {
    sqlMock.mockReset();
  });

  it('returns the trimmed folder id when configured', async () => {
    sqlMock.mockResolvedValue([{ value: '  folder-abc123  ' }]);

    const { getDriveAttachmentsFolderId } = await import('./attachments-folder');
    await expect(getDriveAttachmentsFolderId()).resolves.toBe('folder-abc123');
  });

  it('throws a clear error when no row is present', async () => {
    sqlMock.mockResolvedValue([]);

    const { getDriveAttachmentsFolderId } = await import('./attachments-folder');
    await expect(getDriveAttachmentsFolderId()).rejects.toThrow(
      'Google Drive attachments folder is not configured. Run the one-time setup first.'
    );
  });

  it('throws when the stored value is blank', async () => {
    sqlMock.mockResolvedValue([{ value: '   ' }]);

    const { getDriveAttachmentsFolderId } = await import('./attachments-folder');
    await expect(getDriveAttachmentsFolderId()).rejects.toThrow(
      'Google Drive attachments folder is not configured. Run the one-time setup first.'
    );
  });

  it('throws when the stored value is null', async () => {
    sqlMock.mockResolvedValue([{ value: null }]);

    const { getDriveAttachmentsFolderId } = await import('./attachments-folder');
    await expect(getDriveAttachmentsFolderId()).rejects.toThrow(
      'Google Drive attachments folder is not configured. Run the one-time setup first.'
    );
  });
});
