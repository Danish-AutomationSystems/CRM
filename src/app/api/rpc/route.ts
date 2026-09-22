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

// Fails a stalled stage fast, and names it, instead of letting the whole
// request sit until the platform's function limit with nothing to show for it.
async function withStageTimeout<T>(
  stage: string,
  fn: string,
  ms: number,
  run: () => Promise<T>
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      run(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`DIAG: ${stage} stage stalled >${ms}ms (fn=${fn})`)),
          ms
        );
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function POST(request: Request): Promise<NextResponse> {
  const t0 = Date.now();
  let fnName = '(unparsed)';
  try {
    const body = parseRpcRequestBody((await request.json()) as RpcRequestBody);
    fnName = body.fn;
    const t1 = Date.now();
    console.log(`RPC-STAGE fn=${fnName} stage=auth-start parse=${t1 - t0}ms`);

    const context = await withStageTimeout('auth', fnName, 15000, () => getRequestContext(request));
    const t2 = Date.now();
    console.log(`RPC-STAGE fn=${fnName} stage=handler-start auth=${t2 - t1}ms`);

    const result = await withStageTimeout('handler', fnName, 25000, () =>
      callRpc(body.fn, body.args, request, context)
    );
    const t3 = Date.now();
    console.log(`RPC-STAGE fn=${fnName} stage=done handler=${t3 - t2}ms total=${t3 - t0}ms`);

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
    console.log(`RPC-TIMING fn=${fnName} FAILED after ${Date.now() - t0}ms`);
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
