export function normalizeEmail(value: string | null | undefined): string {
  return String(value ?? '').trim().toLowerCase();
}

export function parseList(value: string | readonly string[] | null | undefined): string[] {
  if (Array.isArray(value)) {
    return value.map((item) => item.trim()).filter(Boolean);
  }

  return String(value ?? '')
    .split(/[|,]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

export function parsePipe(value: string | readonly string[] | null | undefined): string[] {
  if (Array.isArray(value)) {
    return value.map((item) => item.trim()).filter(Boolean);
  }

  return String(value ?? '')
    .split('|')
    .map((item) => item.trim())
    .filter(Boolean);
}

export function joinPipe(values: readonly string[]): string {
  return values.join(' | ');
}

export function uniqueEmails(values: readonly string[]): string[] {
  return Array.from(new Set(values.map(normalizeEmail).filter(Boolean)));
}
