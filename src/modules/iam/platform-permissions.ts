/** Platform (super-admin realm) permissions. Separate from merchant permissions by design. */
export const PLATFORM_PERMISSIONS = {
  'platform.tenants.view': 'View businesses, their plans, usage and health',
  'platform.tenants.manage': 'Suspend, reactivate, extend trials and set demo access',
  'platform.users.view': 'View merchant users',
  'platform.users.manage': 'Lock, unlock and sign out merchant users',
  'platform.users.security': 'Reset merchant two-factor authentication',
  'platform.admins.view': 'View platform admins',
  'platform.admins.manage': 'Create, change and disable platform admins',
  'platform.plans.manage': 'Create and edit plans, modules and prices',
  'platform.billing.view': 'View subscriptions, wallets, credit usage and profit',
  'platform.billing.manage': 'Adjust wallets, set AI credit rates, approve withdrawals',
  'platform.settings.manage': 'Change platform settings such as trials and sign-up',
  'platform.stores.approve': 'Approve or reject stores and custom domains',
  'platform.audit.view': 'View platform and tenant audit logs',
  'platform.support.manage': 'Handle support tickets and live chat',
  'platform.backups.manage': 'Download and restore backups',
  'platform.impersonate': 'Open a business in read-only support mode',
} as const;

export type PlatformPermission = keyof typeof PLATFORM_PERMISSIONS;

export const ALL_PLATFORM_PERMISSIONS = Object.keys(PLATFORM_PERMISSIONS) as PlatformPermission[];

export const PLATFORM_ROLES = ['owner', 'admin', 'finance', 'support', 'readonly'] as const;
export type PlatformRole = (typeof PLATFORM_ROLES)[number];

/** Higher rank can manage lower ranks. Only owners can create or change owners and admins. */
export const PLATFORM_ROLE_RANK: Record<PlatformRole, number> = {
  owner: 100,
  admin: 80,
  finance: 50,
  support: 40,
  readonly: 10,
};

export const PLATFORM_ROLE_PERMISSIONS: Record<PlatformRole, readonly PlatformPermission[]> = {
  owner: ALL_PLATFORM_PERMISSIONS,
  admin: ALL_PLATFORM_PERMISSIONS,
  finance: [
    'platform.tenants.view',
    'platform.users.view',
    'platform.billing.view',
    'platform.billing.manage',
    'platform.plans.manage',
    'platform.audit.view',
  ],
  support: [
    'platform.tenants.view',
    'platform.users.view',
    'platform.users.manage',
    'platform.stores.approve',
    'platform.support.manage',
    'platform.impersonate',
    'platform.audit.view',
  ],
  readonly: ALL_PLATFORM_PERMISSIONS.filter((p) => p.endsWith('.view')),
};

export function platformRoleHas(role: PlatformRole, permission: PlatformPermission): boolean {
  return PLATFORM_ROLE_PERMISSIONS[role].includes(permission);
}
