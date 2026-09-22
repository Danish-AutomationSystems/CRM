import { memoizeRepository } from '../db/memoize-repository';
import { CASE_READ_METHODS } from '../db/repository-reads';
import { registerRpc } from '../rpc/registry';
import { createDriveClient } from '../drive/client';
import { getDriveAttachmentsFolderId } from '../drive/attachments-folder';
import { caseRepository } from './repository';
import { createCaseService } from './service';

// Built per request: the memoized repository must not outlive one request.
function service() {
  return createCaseService(memoizeRepository(caseRepository, CASE_READ_METHODS), {
    getDriveClient: createDriveClient,
    getAttachmentsFolderId: getDriveAttachmentsFolderId
  });
}

registerRpc('api_listAssignableUsers', ({ context }) => service().listAssignableUsers(context));
registerRpc(
  'api_createCase',
  ({ args, context }) => service().createCase(context, String(args[0] ?? ''), args[1] ?? {}),
  { read: false }
);
registerRpc(
  'api_updateCase',
  ({ args, context }) => service().updateCase(context, String(args[0] ?? ''), args[1] ?? {}),
  { read: false }
);
registerRpc(
  'api_setCaseStage',
  ({ args, context }) => service().setCaseStage(context, String(args[0] ?? ''), args[1], args[2]),
  { read: false }
);
registerRpc(
  'api_setCasePriority',
  ({ args, context }) => service().setCasePriority(context, String(args[0] ?? ''), args[1]),
  { read: false }
);
registerRpc(
  'api_setCaseOutcome',
  ({ args, context }) => service().setCaseOutcome(context, String(args[0] ?? ''), args[1], args[2] ?? {}),
  { read: false }
);
registerRpc(
  'api_assignTicket',
  ({ args, context }) => service().assignTicket(context, String(args[0] ?? ''), args[1], args[2], args[3], args[4] === true),
  { read: false }
);
registerRpc(
  'api_beginAttachmentUpload',
  ({ args, context }) => service().beginAttachmentUpload(context, String(args[0] ?? ''), args[1], args[2] === true),
  { read: false }
);
registerRpc('api_getCase', ({ args, context }) => service().getCase(context, String(args[0] ?? '')));
registerRpc('api_listCases', ({ args, context }) => service().listCases(context, args[0] as never));
registerRpc('api_quickLog', ({ args, context }) => service().quickLog(context, args[0] ?? {}), {
  read: false
});
