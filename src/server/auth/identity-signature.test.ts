import { describe, expect, it } from 'vitest';

import { signIdentity, verifyIdentity } from './identity-signature';

const SECRET = 'test-secret-value';
const OTHER_SECRET = 'a-different-secret';
const EMAIL = 'danish@automationsystems.org';

describe('signIdentity / verifyIdentity', () => {
  it('round-trips a signed value', async () => {
    const signed = await signIdentity(EMAIL, SECRET);
    await expect(verifyIdentity(signed, SECRET)).resolves.toBe(EMAIL);
  });

  it('rejects a tampered email in an otherwise valid signature', async () => {
    const signed = await signIdentity(EMAIL, SECRET);
    const [, signature] = signed.split('.');
    const tampered = `attacker@automationsystems.org.${signature}`;
    await expect(verifyIdentity(tampered, SECRET)).resolves.toBeNull();
  });

  it('rejects a value signed with a different secret', async () => {
    const signed = await signIdentity(EMAIL, SECRET);
    await expect(verifyIdentity(signed, OTHER_SECRET)).resolves.toBeNull();
  });

  it('rejects a garbage/malformed value without throwing', async () => {
    await expect(verifyIdentity('not-a-valid-signed-value', SECRET)).resolves.toBeNull();
    await expect(verifyIdentity('..', SECRET)).resolves.toBeNull();
    await expect(verifyIdentity('foo.bar.baz', SECRET)).resolves.toBeNull();
  });

  it('rejects an empty or missing value', async () => {
    await expect(verifyIdentity('', SECRET)).resolves.toBeNull();
    await expect(verifyIdentity(null, SECRET)).resolves.toBeNull();
    await expect(verifyIdentity(undefined, SECRET)).resolves.toBeNull();
  });
});
