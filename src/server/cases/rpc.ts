import { registerRpc } from '../rpc/registry';
import { caseRepository } from './repository';
import { createCaseService } from './service';

const service = createCaseService(caseRepository);

registerRpc('api_listAssignableUsers', ({ context }) => service.listAssignableUsers(context));
registerRpc(
  'api_createCase',
  ({ args, context }) => service.createCase(context, String(args[0] ?? ''), args[1] ?? {}),
  { read: false }
);
registerRpc(
  'api_updateCase',
  ({ args, context }) => service.updateCase(context, String(args[0] ?? ''), args[1] ?? {}),
  { read: false }
);
registerRpc(
  'api_setCaseStage',
  ({ args, context }) => service.setCaseStage(context, String(args[0] ?? ''), args[1], args[2]),
  { read: false }
);
registerRpc(
  'api_setCaseOutcome',
  ({ args, context }) => service.setCaseOutcome(context, String(args[0] ?? ''), args[1], args[2] ?? {}),
  { read: false }
);
registerRpc(
  'api_addCaseOwner',
  ({ args, context }) => service.addCaseOwner(context, String(args[0] ?? ''), args[1]),
  { read: false }
);
registerRpc(
  'api_removeCaseOwner',
  ({ args, context }) => service.removeCaseOwner(context, String(args[0] ?? ''), args[1]),
  { read: false }
);
registerRpc(
  'api_assignTicket',
  ({ args, context }) => service.assignTicket(context, String(args[0] ?? ''), args[1], args[2]),
  { read: false }
);
registerRpc('api_getCase', ({ args, context }) => service.getCase(context, String(args[0] ?? '')));
registerRpc('api_listCases', ({ args, context }) => service.listCases(context, args[0] as never));
registerRpc('api_quickLog', ({ args, context }) => service.quickLog(context, args[0] ?? {}), {
  read: false
});
