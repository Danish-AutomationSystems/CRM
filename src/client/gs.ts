type RpcSuccess<T> = {
  ok: true;
  data: T;
  metadata?: {
    bustClientCache?: boolean;
  };
};

type RpcFailure = {
  ok: false;
  error: string;
};

type RpcResponse<T> = RpcSuccess<T> | RpcFailure;

export type GsClient = {
  <T = unknown>(fn: string, ...args: unknown[]): Promise<T>;
  lastCallBustsClientCache: boolean;
};

const gsImplementation = async function <T = unknown>(fn: string, ...args: unknown[]): Promise<T> {
  gs.lastCallBustsClientCache = false;

  const response = await fetch('/api/rpc', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fn, args })
  });
  const payload = (await response.json()) as RpcResponse<T>;

  if (!payload.ok) {
    throw new Error(payload.error);
  }

  gs.lastCallBustsClientCache = payload.metadata?.bustClientCache === true;

  return payload.data;
};

export const gs = Object.assign(gsImplementation, { lastCallBustsClientCache: false }) as GsClient;
