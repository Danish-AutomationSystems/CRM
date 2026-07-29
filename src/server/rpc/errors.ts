export type RpcErrorCode = 'bad_request' | 'not_found' | 'unauthorized' | 'forbidden' | 'conflict' | 'internal';

const USER_FACING_PATTERNS = [
  /sign in/i,
  /automation systems google account/i,
  /not registered/i,
  /not active/i,
  /not an account handler/i,
  /access to this case/i,
  /admin access requires/i,
  /duplicate/i,
  /already exists/i,
  /invalid/i,
  /required/i,
  /denied/i
];

export class RpcError extends Error {
  readonly code: RpcErrorCode;
  readonly status: number;

  constructor(code: RpcErrorCode, message: string, status: number) {
    super(safeFirstLine(message));
    this.name = 'RpcError';
    this.code = code;
    this.status = status;
  }
}

export function safeFirstLine(message: string): string {
  return message.split(/\r?\n/)[0]?.trim() || 'Something went wrong.';
}

export function rpcNotFound(): RpcError {
  return new RpcError('not_found', 'RPC function not found.', 404);
}

export function rpcBadRequest(message: string): RpcError {
  return new RpcError('bad_request', message, 400);
}

export function normalizeRpcError(error: unknown): RpcError {
  if (error instanceof RpcError) return error;

  if (!(error instanceof Error)) {
    return new RpcError('internal', 'Something went wrong.', 500);
  }

  const message = safeFirstLine(error.message);
  if (!USER_FACING_PATTERNS.some((pattern) => pattern.test(message))) {
    return new RpcError('internal', 'Something went wrong.', 500);
  }

  if (
    /sign in/i.test(message) ||
    /automation systems google account/i.test(message) ||
    /not registered/i.test(message) ||
    /not active/i.test(message)
  ) {
    return new RpcError('unauthorized', message, 401);
  }

  if (/already exists/i.test(message) || /duplicate/i.test(message)) {
    return new RpcError('conflict', message, 409);
  }

  if (/admin access requires/i.test(message) || /not an account handler/i.test(message) || /access to this case/i.test(message) || /denied/i.test(message)) {
    return new RpcError('forbidden', message, 403);
  }

  return new RpcError('bad_request', message, 400);
}
