import { registerRpc, type RpcRegistry } from '../rpc/registry';
import { adminRepository, createAdminService, type AdminService } from './service';

const service = createAdminService(adminRepository);

export function registerAdminRpcs(registry: Pick<RpcRegistry, 'registerRpc'>, adminService: AdminService): void {
  registry.registerRpc('api_admin_listUsers', ({ context }) => adminService.listUsers(context));
  registry.registerRpc('api_admin_saveUser', ({ args, context }) => adminService.saveUser(context, args[0] ?? {}), {
    read: false
  });
  registry.registerRpc(
    'api_admin_saveSettings',
    ({ args, context }) => adminService.saveSettings(context, args[0] ?? {}),
    { read: false }
  );
  registry.registerRpc('api_admin_links', ({ context }) => adminService.links(context));
  registry.registerRpc('api_admin_runImport', ({ context }) => adminService.runImport(context), { read: false });
  registry.registerRpc('api_admin_runImportContacts', ({ context }) => adminService.runImportContacts(context), {
    read: false
  });
  registry.registerRpc('api_admin_listRecycle', ({ context }) => adminService.listRecycle(context));
  registry.registerRpc(
    'api_admin_addConfigItem',
    ({ args, context }) => adminService.addConfigItem(context, args[0], args[1]),
    { read: false }
  );
  registry.registerRpc(
    'api_admin_deleteConfigItem',
    ({ args, context }) => adminService.deleteConfigItem(context, args[0], args[1]),
    { read: false }
  );
  registry.registerRpc(
    'api_admin_restoreCustomer',
    ({ args, context }) => adminService.restoreCustomer(context, String(args[0] ?? '')),
    { read: false }
  );
  registry.registerRpc(
    'api_admin_purgeCustomer',
    ({ args, context }) => adminService.purgeCustomer(context, String(args[0] ?? '')),
    { read: false }
  );
}

registerAdminRpcs({ registerRpc }, service);
