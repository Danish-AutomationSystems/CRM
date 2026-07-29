import { describe, expect, it } from 'vitest';

import { RpcError, callRpc, createRpcRegistry } from './registry';
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
});
