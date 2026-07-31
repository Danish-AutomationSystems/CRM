import { registerRpc } from '../rpc/registry';
import { createDriveClient } from '../drive/client';
import { getDriveFolderId } from '../drive/folder';
import { createDriveService } from '../drive/service';
import { quoteRepository } from './repository';
import { createQuoteService } from './service';

const service = createQuoteService(quoteRepository);
const driveService = createDriveService({
  quoteService: service,
  quoteRepository,
  getDriveClient: createDriveClient,
  getFolderId: getDriveFolderId
});

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
registerRpc(
  'api_saveQuotationToDrive',
  ({ args, context }) => driveService.saveQuotationToDrive(context, String(args[0] ?? ''), Number(args[1] ?? 0)),
  { read: false }
);
