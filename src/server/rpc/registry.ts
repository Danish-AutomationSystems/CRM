import type { CrmContext } from '../auth/context';
import { RpcError, normalizeRpcError, rpcNotFound } from './errors';

export { RpcError } from './errors';

export type RpcMetadata = {
  bustClientCache: boolean;
};

export type RpcHandlerInput = {
  args: unknown[];
  context: CrmContext;
  request: Request;
};

export type RpcHandler<T = unknown> = (input: RpcHandlerInput) => T | Promise<T>;

export type RpcRegistrationOptions = {
  read?: boolean;
};

export type RpcResult<T = unknown> = {
  data: T;
  metadata: RpcMetadata;
};

type RegisteredRpc = {
  handler: RpcHandler;
  options: Required<RpcRegistrationOptions>;
};

export type RpcRegistry = {
  registerRpc: (name: string, handler: RpcHandler, options?: RpcRegistrationOptions) => void;
  callRpc: <T = unknown>(
    name: string,
    args: unknown[],
    request: Request,
    context: CrmContext
  ) => Promise<RpcResult<T>>;
  hasRpc: (name: string) => boolean;
  listRegisteredRpcs: () => string[];
};

function normalizeName(name: string): string {
  return name.trim();
}

export function createRpcRegistry(): RpcRegistry {
  const handlers = new Map<string, RegisteredRpc>();

  return {
    registerRpc(name, handler, options = {}) {
      const normalizedName = normalizeName(name);
      if (!normalizedName) throw new RpcError('bad_request', 'RPC function name is required.', 400);

      handlers.set(normalizedName, {
        handler,
        options: { read: options.read ?? true }
      });
    },

    async callRpc<T = unknown>(
      name: string,
      args: unknown[],
      request: Request,
      context: CrmContext
    ): Promise<RpcResult<T>> {
      const registered = handlers.get(normalizeName(name));
      if (!registered) throw rpcNotFound();

      try {
        const data = (await registered.handler({ args, context, request })) as T;

        return {
          data,
          metadata: { bustClientCache: !registered.options.read }
        };
      } catch (error) {
        // Message and stack only - NEVER the error object itself. Node prints an
        // object's own enumerable properties, and a GaxiosError from googleapis
        // carries the OAuth access token at .config.headers.Authorization, so
        // `console.error(name, error)` writes "Bearer ya29..." into the Vercel
        // logs. `stack` is a plain string and carries no request config, so it
        // stays: it is the part that is actually useful for debugging.
        console.error(
          'RPC error:',
          name,
          error instanceof Error ? error.stack || error.message : String(error)
        );
        throw normalizeRpcError(error);
      }
    },

    hasRpc(name) {
      return handlers.has(normalizeName(name));
    },

    listRegisteredRpcs() {
      return [...handlers.keys()].sort((a, b) => a.localeCompare(b));
    }
  };
}

const defaultRegistry = createRpcRegistry();

export const registerRpc = defaultRegistry.registerRpc;
export const callRpc = defaultRegistry.callRpc;
export const hasRpc = defaultRegistry.hasRpc;
export const listRegisteredRpcs = defaultRegistry.listRegisteredRpcs;
