import { caseRepository } from '../cases/repository';
import { createCaseService } from '../cases/service';
import { customerRepository } from '../customers/repository';
import { createCustomerService } from '../customers/service';
import { memoizeRepository } from '../db/memoize-repository';
import { CASE_READ_METHODS, CUSTOMER_READ_METHODS } from '../db/repository-reads';
import { registerRpc } from '../rpc/registry';
import { createDashboardService } from './service';

// Built per request: the memoized repositories must not outlive one request,
// and the three services must share them to deduplicate against each other.
function dashboardService() {
  const cases = memoizeRepository(caseRepository, CASE_READ_METHODS);
  const customers = memoizeRepository(customerRepository, CUSTOMER_READ_METHODS);
  return createDashboardService(cases, {
    customerService: createCustomerService(customers),
    caseService: createCaseService(cases)
  });
}

registerRpc('api_bootstrap', ({ context }) => dashboardService().bootstrap(context));
registerRpc('api_workspace', ({ args, context }) => dashboardService().workspace(context, args[0] ?? {}));
registerRpc('api_dashboard', ({ args, context }) => dashboardService().dashboard(context, args[0]));
