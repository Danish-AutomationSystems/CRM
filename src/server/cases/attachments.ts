/**
 * Attachment naming, validation and sanitisation.
 *
 * Pure functions only — no I/O, no network, no database, no clock. Callers
 * pass in the current time as a parameter so behaviour stays deterministic
 * and cheaply testable.
 *
 * The Drive filename is built server-side from server-held data (case id,
 * date, uploader name). A client-supplied file name is treated as hostile
 * input: it is sanitised before being embedded, and can never introduce a
 * path separator or otherwise escape the naming convention.
 */

export const MAX_ATTACHMENT_BYTES = 100 * 1024 * 1024;
export const MAX_ATTACHMENTS_PER_RESPONSE = 10;

const MAX_ATTACHMENT_MB = MAX_ATTACHMENT_BYTES / (1024 * 1024);

const MAX_SANITISED_NAME_LENGTH = 150;

export type RequestedUpload = { fileName: string; mimeType: string; sizeBytes: number };

/**
 * Strips path separators and control characters, collapses whitespace,
 * strips leading dots, bounds the length, and never returns an empty
 * string — falls back to "attachment" instead.
 */
export function sanitiseFileName(name: string): string {
  let result = typeof name === 'string' ? name : '';

  // Strip path separators outright — never join into a directory reference.
  result = result.replace(/[/\\]/g, '');

  // Strip control characters (including DEL).
  // eslint-disable-next-line no-control-regex
  result = result.replace(/[\x00-\x1f\x7f]/g, '');

  // Collapse runs of whitespace into a single space and trim the ends.
  result = result.replace(/\s+/g, ' ').trim();

  // Strip leading dots (defeats "." / ".." / hidden-file style traversal
  // remnants left after separator stripping).
  result = result.replace(/^\.+/, '');

  // Re-collapse/trim in case stripping leading dots exposed more whitespace.
  result = result.trim();

  // Bound the length so it can never dominate the full Drive name.
  if (result.length > MAX_SANITISED_NAME_LENGTH) {
    result = result.slice(0, MAX_SANITISED_NAME_LENGTH).trim();
  }

  return result.length > 0 ? result : 'attachment';
}

function formatDate(when: Date): string {
  const year = when.getUTCFullYear();
  const month = String(when.getUTCMonth() + 1).padStart(2, '0');
  const day = String(when.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * Builds the canonical Drive file name:
 *   <caseId> - <YYYY-MM-DD> - <uploaderName> - <sanitised file name>
 *
 * Always uses the sanitised form of the client-supplied file name — never
 * the raw input — so a hostile name cannot control the shape of the name
 * or escape the convention.
 */
export function buildDriveName(input: {
  caseId: string;
  uploaderName: string;
  fileName: string;
  when: Date;
}): string {
  const datePart = formatDate(input.when);
  const safeFileName = sanitiseFileName(input.fileName);
  return `${input.caseId} - ${datePart} - ${input.uploaderName} - ${safeFileName}`;
}

/**
 * Returns `name` unchanged if it does not appear in `existingNames`;
 * otherwise appends " (2)", " (3)", ... until a free name is found.
 */
export function disambiguate(name: string, existingNames: string[]): string {
  if (!existingNames.includes(name)) {
    return name;
  }

  let attempt = 2;
  let candidate = `${name} (${attempt})`;
  while (existingNames.includes(candidate)) {
    attempt += 1;
    candidate = `${name} (${attempt})`;
  }
  return candidate;
}

/**
 * Validates untrusted input describing the files a client wants to upload.
 * Returns typed values on success; throws a plain Error with a
 * user-actionable message otherwise. No I/O, no MIME allow-list — any
 * mime type (including empty) is permitted.
 */
export function validateRequestedUploads(files: unknown): RequestedUpload[] {
  if (!Array.isArray(files) || files.length === 0) {
    throw new Error('At least one attachment is required.');
  }

  if (files.length > MAX_ATTACHMENTS_PER_RESPONSE) {
    throw new Error(`You can attach at most ${MAX_ATTACHMENTS_PER_RESPONSE} files per response.`);
  }

  return files.map((file) => {
    if (typeof file !== 'object' || file === null) {
      throw new Error('Attachment file name is required.');
    }

    const record = file as Record<string, unknown>;

    const fileName = typeof record.fileName === 'string' ? record.fileName.trim() : '';
    if (fileName.length === 0) {
      throw new Error('Attachment file name is required.');
    }

    const mimeType = typeof record.mimeType === 'string' ? record.mimeType : '';

    const sizeBytes = record.sizeBytes;
    if (typeof sizeBytes !== 'number' || !Number.isFinite(sizeBytes) || sizeBytes <= 0) {
      throw new Error('Attachment size is invalid.');
    }

    if (sizeBytes > MAX_ATTACHMENT_BYTES) {
      throw new Error(`Attachment exceeds the ${MAX_ATTACHMENT_MB} MB limit.`);
    }

    return { fileName, mimeType, sizeBytes };
  });
}
