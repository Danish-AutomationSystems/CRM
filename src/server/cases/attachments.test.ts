import { describe, expect, it } from 'vitest';

import {
  MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENTS_PER_RESPONSE,
  buildDriveName,
  disambiguate,
  sanitiseFileName,
  validateRequestedUploads
} from './attachments';

describe('sanitiseFileName', () => {
  it('strips forward slashes', () => {
    expect(sanitiseFileName('folder/file.pdf')).not.toContain('/');
  });

  it('strips backslashes', () => {
    expect(sanitiseFileName('folder\\file.pdf')).not.toContain('\\');
  });

  it('strips control characters', () => {
    const withControlChars = 'file\x00\x01\x1fname.pdf';
    const result = sanitiseFileName(withControlChars);
    // eslint-disable-next-line no-control-regex
    expect(/[\x00-\x1f\x7f]/.test(result)).toBe(false);
  });

  it('strips leading dots', () => {
    expect(sanitiseFileName('...hidden.txt').startsWith('.')).toBe(false);
  });

  it('collapses whitespace', () => {
    expect(sanitiseFileName('my    file   name.pdf')).toBe('my file name.pdf');
  });

  it('bounds the length of very long names', () => {
    const huge = 'a'.repeat(1000) + '.pdf';
    const result = sanitiseFileName(huge);
    expect(result.length).toBeLessThan(1000);
  });

  it('never returns an empty string, falling back to "attachment"', () => {
    expect(sanitiseFileName('')).toBe('attachment');
  });

  it('falls back to "attachment" when the name is only separators and dots', () => {
    expect(sanitiseFileName('/\\...')).toBe('attachment');
  });

  it('falls back to "attachment" when the name is only whitespace', () => {
    expect(sanitiseFileName('    ')).toBe('attachment');
  });

  it('neutralises a path traversal attempt with no separators surviving', () => {
    const result = sanitiseFileName('../../etc/passwd');
    expect(result).not.toContain('/');
    expect(result).not.toContain('\\');
    expect(result.startsWith('.')).toBe(false);
  });
});

describe('buildDriveName', () => {
  it('produces the documented format', () => {
    const result = buildDriveName({
      caseId: 'CASE-2026-0004',
      uploaderName: 'Danish',
      fileName: 'site-drawing-revB.pdf',
      when: new Date('2026-08-14T09:00:00Z')
    });

    expect(result).toBe('CASE-2026-0004 - 2026-08-14 - Danish - site-drawing-revB.pdf');
  });

  it('uses the sanitised file name so a hostile filename cannot escape the convention', () => {
    const result = buildDriveName({
      caseId: 'CASE-2026-0004',
      uploaderName: 'Danish',
      fileName: '../../etc/passwd',
      when: new Date('2026-08-14T09:00:00Z')
    });

    expect(result.startsWith('CASE-2026-0004 - 2026-08-14 - Danish - ')).toBe(true);
    expect(result).not.toContain('/');
    expect(result).not.toContain('\\');
    // the sanitised segment must not contain the raw traversal sequence
    expect(result).not.toContain('../../etc/passwd');
  });

  it('formats single-digit months and days with leading zeros', () => {
    const result = buildDriveName({
      caseId: 'CASE-2026-0001',
      uploaderName: 'Danish',
      fileName: 'notes.txt',
      when: new Date('2026-01-05T00:00:00Z')
    });

    expect(result).toBe('CASE-2026-0001 - 2026-01-05 - Danish - notes.txt');
  });
});

describe('disambiguate', () => {
  it('returns the name unchanged when unused', () => {
    expect(disambiguate('file.pdf', [])).toBe('file.pdf');
    expect(disambiguate('file.pdf', ['other.pdf'])).toBe('file.pdf');
  });

  it('appends " (2)" when the name is taken once', () => {
    expect(disambiguate('file.pdf', ['file.pdf'])).toBe('file.pdf (2)');
  });

  it('appends " (3)" when both the name and " (2)" variant are taken', () => {
    expect(disambiguate('file.pdf', ['file.pdf', 'file.pdf (2)'])).toBe('file.pdf (3)');
  });
});

describe('validateRequestedUploads', () => {
  const validFile = { fileName: 'doc.pdf', mimeType: 'application/pdf', sizeBytes: 1024 };

  it('rejects a non-array', () => {
    expect(() => validateRequestedUploads('not-an-array')).toThrow();
    expect(() => validateRequestedUploads(null)).toThrow();
    expect(() => validateRequestedUploads(undefined)).toThrow();
    expect(() => validateRequestedUploads({})).toThrow();
  });

  it('rejects an empty array', () => {
    expect(() => validateRequestedUploads([])).toThrow();
  });

  it('rejects more than MAX_ATTACHMENTS_PER_RESPONSE files', () => {
    const files = Array.from({ length: MAX_ATTACHMENTS_PER_RESPONSE + 1 }, () => ({ ...validFile }));
    expect(() => validateRequestedUploads(files)).toThrow();
  });

  it('accepts exactly MAX_ATTACHMENTS_PER_RESPONSE files', () => {
    const files = Array.from({ length: MAX_ATTACHMENTS_PER_RESPONSE }, () => ({ ...validFile }));
    expect(validateRequestedUploads(files)).toHaveLength(MAX_ATTACHMENTS_PER_RESPONSE);
  });

  it('rejects a file over MAX_ATTACHMENT_BYTES', () => {
    expect(() =>
      validateRequestedUploads([{ ...validFile, sizeBytes: MAX_ATTACHMENT_BYTES + 1 }])
    ).toThrow();
  });

  it('accepts a file exactly at MAX_ATTACHMENT_BYTES', () => {
    expect(
      validateRequestedUploads([{ ...validFile, sizeBytes: MAX_ATTACHMENT_BYTES }])
    ).toHaveLength(1);
  });

  it('names the limit in MB in the over-size error message', () => {
    try {
      validateRequestedUploads([{ ...validFile, sizeBytes: MAX_ATTACHMENT_BYTES + 1 }]);
      throw new Error('expected validateRequestedUploads to throw');
    } catch (error) {
      expect((error as Error).message).toMatch(/100\s*mb/i);
    }
  });

  it('rejects a zero size', () => {
    expect(() => validateRequestedUploads([{ ...validFile, sizeBytes: 0 }])).toThrow();
  });

  it('rejects a negative size', () => {
    expect(() => validateRequestedUploads([{ ...validFile, sizeBytes: -5 }])).toThrow();
  });

  it('rejects a missing file name', () => {
    expect(() => validateRequestedUploads([{ mimeType: 'application/pdf', sizeBytes: 10 }])).toThrow();
  });

  it('rejects a blank file name', () => {
    expect(() => validateRequestedUploads([{ ...validFile, fileName: '   ' }])).toThrow();
  });

  it('accepts any mime type, including an empty one — no allow-list', () => {
    expect(validateRequestedUploads([{ ...validFile, mimeType: '' }])).toHaveLength(1);
    expect(
      validateRequestedUploads([{ ...validFile, mimeType: 'application/x-completely-unknown' }])
    ).toHaveLength(1);
    expect(
      validateRequestedUploads([{ ...validFile, mimeType: 'application/x-msdownload' }])
    ).toHaveLength(1);
  });

  it('returns typed values matching the input for valid files', () => {
    const result = validateRequestedUploads([validFile]);
    expect(result).toEqual([validFile]);
  });
});
