import { NextResponse } from 'next/server';

import { getRequestContext } from '../../../server/auth/context';
import '../../../server/admin/rpc';
import '../../../server/cases/rpc';
import '../../../server/customers/rpc';
import '../../../server/dashboard/rpc';
import '../../../server/quotes/rpc';
import { callRpc } from '../../../server/rpc/registry';
import { normalizeRpcError, rpcBadRequest } from '../../../server/rpc/errors';

type RpcRequestBody = {
  fn?: unknown;
  args?: unknown;
};

function parseRpcRequestBody(body: RpcRequestBody): { fn: string; args: unknown[] } {
  if (typeof body.fn !== 'string' || !body.fn.trim()) {
    throw rpcBadRequest('RPC function name is required.');
  }

  if (body.args !== undefined && !Array.isArray(body.args)) {
    throw rpcBadRequest('RPC args must be an array.');
  }

  return {
    fn: body.fn,
    args: body.args ?? []
  };
}

// A stalled stage would otherwise sit until the platform's function limit and
// return nothing useful; this surfaces which stage stalled while the client is
// still listening.
async function withStageTimeout<T>(stage: string, ms: number, run: () => Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      run(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`The ${stage} step timed out. Please retry.`)), ms);
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function POST(request: Request): Promise<NextResponse> {
  try {
    const body = parseRpcRequestBody((await request.json()) as RpcRequestBody);
    const context = await withStageTimeout('sign-in', 15000, () => getRequestContext(request));
    const result = await withStageTimeout('data', 25000, () =>
      callRpc(body.fn, body.args, request, context)
    );

    return NextResponse.json(
      {
        ok: true,
        data: result.data,
        metadata: result.metadata
      },
      {
        headers: {
          'Vary': 'Accept-Encoding',
          'Cache-Control': 'no-store, max-age=0'
        }
      }
    );
  } catch (error) {
    const rpcError = normalizeRpcError(error);

    return NextResponse.json(
      {
        ok: false,
        error: rpcError.message
      },
      { status: rpcError.status }
    );
  }
}
