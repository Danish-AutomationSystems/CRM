import { NextResponse } from 'next/server';

import { getRequestContext } from '../../../server/auth/context';
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

export async function POST(request: Request): Promise<NextResponse> {
  try {
    const body = parseRpcRequestBody((await request.json()) as RpcRequestBody);
    const context = await getRequestContext(request);
    const result = await callRpc(body.fn, body.args, request, context);

    return NextResponse.json({
      ok: true,
      data: result.data,
      metadata: result.metadata
    });
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
