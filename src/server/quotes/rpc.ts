import { registerRpc } from '../rpc/registry';
import { quoteRepository } from './repository';
import { createQuoteService } from './service';

const service = createQuoteService(quoteRepository);

registerRpc('api_listTemplates', ({ context }) => service.listTemplates(context));
registerRpc('api_createQuotation', ({ args, context }) => service.createQuotation(context, (args[0] ?? {}) as never), {
  read: false
});
registerRpc('api_uploadQuotation', ({ args, context }) => service.uploadQuotation(context, (args[0] ?? {}) as never), {
  read: false
});
registerRpc('api_getQuotation', ({ args, context }) =>
  service.getQuotation(context, String(args[0] ?? ''), Number(args[1] ?? 0))
);
registerRpc(
  'api_setQuoteStatus',
  ({ args, context }) => service.setQuoteStatus(context, String(args[0] ?? ''), Number(args[1] ?? 0), args[2]),
  { read: false }
);
registerRpc(
  'api_generateQuoteDoc',
  ({ args, context }) => service.generateQuoteDoc(context, String(args[0] ?? ''), Number(args[1] ?? 0)),
  { read: false }
);
