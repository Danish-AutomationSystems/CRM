import { registerRpc } from '../rpc/registry';
import { customerRepository } from './repository';
import { createCustomerService } from './service';

const service = createCustomerService(customerRepository);

registerRpc('api_myCustomers', ({ context }) => service.myCustomers(context));
registerRpc('api_allCustomers', ({ context }) => service.allCustomers(context));
registerRpc('api_searchCustomers', ({ args, context }) => service.searchCustomers(context, args[0]));
registerRpc('api_getCustomer', ({ args, context }) => service.getCustomer(context, String(args[0] ?? '')));
registerRpc('api_createCustomer', ({ args, context }) => service.createCustomer(context, args[0] ?? {}), {
  read: false
});
registerRpc(
  'api_updateCustomer',
  ({ args, context }) => service.updateCustomer(context, String(args[0] ?? ''), args[1] ?? {}),
  { read: false }
);
registerRpc('api_saveCustomerCells', ({ args, context }) => service.saveCustomerCells(context, args[0] as never), {
  read: false
});
registerRpc('api_bulkCustomers', ({ args, context }) => service.bulkCustomers(context, args[0] as never), {
  read: false
});
registerRpc(
  'api_addContact',
  ({ args, context }) => service.addContact(context, String(args[0] ?? ''), args[1] ?? {}),
  { read: false }
);
registerRpc(
  'api_updateContact',
  ({ args, context }) => service.updateContact(context, String(args[0] ?? ''), args[1] ?? {}),
  { read: false }
);
registerRpc('api_deleteContact', ({ args, context }) => service.deleteContact(context, String(args[0] ?? '')), {
  read: false
});
registerRpc(
  'api_bulkContacts',
  ({ args, context }) => service.bulkContacts(context, String(args[0] ?? ''), args[1] as never),
  { read: false }
);
registerRpc(
  'api_addHandler',
  ({ args, context }) => service.addHandler(context, String(args[0] ?? ''), args[1]),
  { read: false }
);
registerRpc(
  'api_removeHandler',
  ({ args, context }) => service.removeHandler(context, String(args[0] ?? ''), args[1]),
  { read: false }
);
registerRpc('api_deleteCustomers', ({ args, context }) => service.deleteCustomers(context, args[0] as never), {
  read: false
});
