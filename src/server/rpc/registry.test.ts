import { describe, expect, it, vi } from 'vitest';

import { RpcError, callRpc, createRpcRegistry } from './registry';
import { normalizeRpcError } from './errors';
import type { CrmContext } from '../auth/context';

const request = new Request('https://crm.example.test/api/rpc', { method: 'POST' });

const user: CrmContext = {
  email: 'sales@automationsystems.org',
  name: 'Sales User',
  role: 'L2',
  allowedTags: ['Punjab'],
  active: true
};

describe('RPC registry', () => {
  it('returns a safe 404-style error for unknown functions', async () => {
    await expect(callRpc('api_missing', [], request, user)).rejects.toMatchObject({
      code: 'not_found',
      status: 404,
      message: 'RPC function not found.'
    });
  });

  it('passes handler args in order with request context', async () => {
    const registry = createRpcRegistry();
    registry.registerRpc('api_join', ({ args, context, request: handlerRequest }) => {
      expect(context).toBe(user);
      expect(handlerRequest).toBe(request);

      return `${args[0]}:${args[1]}:${args[2]}`;
    });

    await expect(registry.callRpc('api_join', ['A', 2, true], request, user)).resolves.toEqual({
      data: 'A:2:true',
      metadata: { bustClientCache: false }
    });
  });

  it('turns thrown authorization errors into safe user-facing errors', async () => {
    const registry = createRpcRegistry();
    registry.registerRpc('api_secret', () => {
      throw new Error('Admin access requires L6.\nSTACK: database password');
    });

    await expect(registry.callRpc('api_secret', [], request, user)).rejects.toMatchObject({
      code: 'forbidden',
      status: 403,
      message: 'Admin access requires L6.'
    });
  });

  it('marks non-read calls for client cache busting metadata', async () => {
    const registry = createRpcRegistry();
    registry.registerRpc('api_updateCustomer', () => ({ ok: true }), { read: false });

    await expect(registry.callRpc('api_updateCustomer', [], request, user)).resolves.toEqual({
      data: { ok: true },
      metadata: { bustClientCache: true }
    });
  });

  it('preserves explicit RpcError status and safe message', async () => {
    const registry = createRpcRegistry();
    registry.registerRpc('api_known_conflict', () => {
      throw new RpcError('conflict', 'Customer already exists.', 409);
    });

    await expect(registry.callRpc('api_known_conflict', [], request, user)).rejects.toMatchObject({
      code: 'conflict',
      status: 409,
      message: 'Customer already exists.'
    });
  });

  it('surfaces quotation-generation guard messages instead of a generic 500', () => {
    for (const message of [
      'This quotation has no template selected. Create a revision and pick a template.',
      'This template has no {{BOQ_TABLE}} placeholder - add one where the BOQ should appear.',
      'This quotation was uploaded as an external file - there is no template to generate from.'
    ]) {
      const rpcError = normalizeRpcError(new Error(message));
      expect(rpcError.status).toBe(400);
      expect(rpcError.message).toBe(message);
    }
  });

  it('surfaces the Drive-hosted upload message instead of a generic 500', () => {
    const message = 'This quotation is stored in Google Drive - use the "View in Drive" link to open it.';

    const rpcError = normalizeRpcError(new Error(message));

    expect(rpcError.status).toBe(400);
    expect(rpcError.code).toBe('bad_request');
    expect(rpcError.message).toBe(message);
  });

  it('never writes an OAuth access token to the error log', async () => {
    // A GaxiosError carries the bearer token as an own enumerable property, so
    // console.error(error) - Node prints those - would put it in the Vercel log.
    const gaxiosLike = Object.assign(new Error('Invalid Credentials'), {
      code: 401,
      config: {
        url: 'https://www.googleapis.com/drive/v3/files/file-1',
        headers: { Authorization: 'Bearer ya29.a0AfB_leak_me_not', 'Content-Type': 'application/json' }
      },
      response: { status: 401 }
    });

    const logged: unknown[][] = [];
    const spy = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      logged.push(args);
    });

    const registry = createRpcRegistry();
    registry.registerRpc('api_assignTicket', () => {
      throw gaxiosLike;
    });

    const thrown = await registry.callRpc('api_assignTicket', [], request, user).catch((err: unknown) => err);
    spy.mockRestore();

    expect(thrown).toBeInstanceOf(RpcError);
    expect(String((thrown as RpcError).message)).not.toContain('ya29');

    expect(logged).toHaveLength(1);
    const transcript = logged.flat().map((part) => String(part)).join(' ');
    expect(transcript).toContain('RPC error: api_assignTicket');
    expect(transcript).not.toContain('Bearer');
    expect(transcript).not.toContain('Authorization');
    expect(transcript).not.toContain('ya29');
  });

  it('still hides unrelated internal errors that merely mention Drive', () => {
    for (const message of [
      'Drive API returned 503 for folder 1AbC_secretFolderId.',
      'getaddrinfo ENOTFOUND www.googleapis.com'
    ]) {
      const rpcError = normalizeRpcError(new Error(message));
      expect(rpcError.status).toBe(500);
      expect(rpcError.message).toBe('Something went wrong.');
    }
  });
});
