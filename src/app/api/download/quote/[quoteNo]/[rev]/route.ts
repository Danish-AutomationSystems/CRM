import { NextResponse } from 'next/server';

import { getRequestContext } from '../../../../../../server/auth/context';
import { normalizeRpcError } from '../../../../../../server/rpc/errors';
import { buildQuoteAttachmentResponse } from '../../../../../../server/quotes/render';
import { quoteRepository } from '../../../../../../server/quotes/repository';
import { createQuoteService } from '../../../../../../server/quotes/service';

const service = createQuoteService(quoteRepository);

type RouteContext = {
  params:
    | Promise<{
        quoteNo: string;
        rev: string;
      }>
    | {
        quoteNo: string;
        rev: string;
      };
};

export async function GET(request: Request, context: RouteContext): Promise<Response> {
  try {
    const params = await context.params;
    const user = await getRequestContext(request);
    const artifact = await service.getDownloadArtifact(user, params.quoteNo, Number(params.rev));
    return buildQuoteAttachmentResponse(artifact);
  } catch (error) {
    const rpcError = normalizeRpcError(error);
    return NextResponse.json({ ok: false, error: rpcError.message }, { status: rpcError.status });
  }
}
