import { caseRepository } from '../cases/repository';
import { createCaseService } from '../cases/service';
import { customerRepository } from '../customers/repository';
import { createCustomerService } from '../customers/service';
import { registerRpc } from '../rpc/registry';
import { createDashboardService } from './service';

const service = createDashboardService(caseRepository, {
  customerService: createCustomerService(customerRepository),
  caseService: createCaseService(caseRepository)
});

registerRpc('api_bootstrap', ({ context }) => service.bootstrap(context));
registerRpc('api_workspace', ({ args, context }) => service.workspace(context, args[0] ?? {}));
registerRpc('api_dashboard', ({ args, context }) => service.dashboard(context, args[0]));
