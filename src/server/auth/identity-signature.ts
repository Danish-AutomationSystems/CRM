// Signs the forwarded user identity so that a header value can only have
// originated from code that holds CRM_IDENTITY_SECRET (middleware), never
// from a client-supplied request. Uses the Web Crypto API (not node:crypto)
// because middleware runs on the Edge runtime, where node:crypto is
// unavailable; Web Crypto is available in both Edge and Node 18+.

function toBase64Url(bytes: ArrayBuffer): string {
  const binary = Array.from(new Uint8Array(bytes), (byte) => String.fromCharCode(byte)).join('');
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function importHmacKey(secret: string): Promise<CryptoKey> {
  const keyData = new TextEncoder().encode(secret);
  return crypto.subtle.importKey('raw', keyData, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
}

async function hmacSign(value: string, secret: string): Promise<string> {
  const key = await importHmacKey(secret);
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(value));
  return toBase64Url(signature);
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) {
    // Still walk a comparison of equal length to avoid a length-based
    // early exit revealing timing information beyond length.
    let diff = 0;
    const len = Math.max(a.length, b.length);
    for (let i = 0; i < len; i++) {
      const charA = i < a.length ? a.charCodeAt(i) : 0;
      const charB = i < b.length ? b.charCodeAt(i) : 0;
      diff |= charA ^ charB;
    }
    return false;
  }

  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

export async function signIdentity(email: string, secret: string): Promise<string> {
  const signature = await hmacSign(email, secret);
  return `${email}.${signature}`;
}

export async function verifyIdentity(
  value: string | null | undefined,
  secret: string
): Promise<string | null> {
  if (!value) return null;

  const separatorIndex = value.lastIndexOf('.');
  if (separatorIndex <= 0 || separatorIndex === value.length - 1) return null;

  const email = value.slice(0, separatorIndex);
  const signature = value.slice(separatorIndex + 1);

  try {
    const expectedSignature = await hmacSign(email, secret);
    if (!constantTimeEqual(signature, expectedSignature)) return null;
    return email;
  } catch {
    return null;
  }
}
