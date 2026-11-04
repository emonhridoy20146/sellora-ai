/**
 * Merchant (tenant) permission catalog. Permissions are checked by PermissionGuard via
 * @RequirePermissions. Custom roles can only contain permissions from this catalog, and a
 * member can only grant permissions they hold themselves.
 */
export const PERMISSION_GROUPS = {
  organization: {
    label: 'Business',
    permissions: {
      'org.view': 'View business profile',
      'org.settings.manage': 'Edit business settings',
      'org.members.view': 'View staff',
      'org.members.manage': 'Invite, remove and change staff roles',
      'org.roles.manage': 'Create and edit custom roles',
      'org.audit.view': 'View the activity log',
      'org.integrations.manage': 'Connect channels, couriers, payment and SMS gateways',
      'org.backups.manage': 'Download backups and manage Google Drive backup',
      'org.api_keys.manage': 'Manage API keys and webhooks',
    },
  },
  billing: {
    label: 'Billing',
    permissions: {
      'billing.view': 'View plan, invoices, wallet and AI usage',
      'billing.manage': 'Change plan, top up wallet and request withdrawals',
    },
  },
  stores: {
    label: 'Stores and pages',
    permissions: {
      'stores.view': 'View stores and landing pages',
      'stores.manage': 'Edit store design, pages and domains',
      'stores.publish': 'Publish stores and landing pages',
    },
  },
  catalog: {
    label: 'Products',
    permissions: {
      'catalog.view': 'View products',
      'catalog.manage': 'Create and edit products',
      'inventory.manage': 'Adjust stock',
    },
  },
  customers: {
    label: 'Customers',
    permissions: {
      'customers.view': 'View customers',
      'customers.manage': 'Edit customers and notes',
      'customers.export': 'Export customer data',
    },
  },
  orders: {
    label: 'Orders',
    permissions: {
      'orders.view': 'View orders',
      'orders.create': 'Create manual orders',
      'orders.manage': 'Edit orders and change status',
      'orders.cancel': 'Cancel orders',
      'orders.print': 'Print invoices, receipts and labels',
      'orders.export': 'Export orders',
    },
  },
  inbox: {
    label: 'Inbox',
    permissions: {
      'inbox.view': 'View all conversations',
      'inbox.view_assigned': 'View conversations assigned to them',
      'inbox.reply': 'Reply to customers',
      'inbox.assign': 'Assign conversations',
      'inbox.ai_control': 'Pause and resume the AI in conversations',
    },
  },
  ai: {
    label: 'AI',
    permissions: {
      'ai.settings.manage': 'Configure the AI agent, tone and replies',
      'ai.knowledge.manage': 'Manage AI knowledge and data sync',
    },
  },
  marketing: {
    label: 'Marketing',
    permissions: {
      'marketing.view': 'View campaigns, ads and SEO',
      'marketing.manage': 'Manage campaigns, ads, SEO and follow-ups',
    },
  },
  analytics: {
    label: 'Reports',
    permissions: {
      'analytics.view': 'View reports and dashboards',
    },
  },
} as const;

type Groups = typeof PERMISSION_GROUPS;
export type Permission = {
  [G in keyof Groups]: Extract<keyof Groups[G]['permissions'], string>;
}[keyof Groups];

export const ALL_PERMISSIONS: readonly Permission[] = Object.values(PERMISSION_GROUPS).flatMap(
  (g) => Object.keys(g.permissions) as Permission[],
);

const ALL = new Set<string>(ALL_PERMISSIONS);

export function isPermission(value: string): value is Permission {
  return ALL.has(value);
}

export interface SystemRole {
  key: string;
  name: string;
  description: string;
  permissions: readonly Permission[];
}

const views = ALL_PERMISSIONS.filter((p) => p.endsWith('.view'));

export const OWNER_ROLE_KEY = 'owner';

/** Built-in roles every business gets. The owner role is assigned only by ownership transfer. */
export const SYSTEM_ROLES: readonly SystemRole[] = [
  {
    key: OWNER_ROLE_KEY,
    name: 'Owner',
    description: 'Full access, including billing and ownership. One per business.',
    permissions: ALL_PERMISSIONS,
  },
  {
    key: 'admin',
    name: 'Admin',
    description: 'Full access except transferring or closing the business.',
    permissions: ALL_PERMISSIONS,
  },
  {
    key: 'manager',
    name: 'Manager',
    description: 'Runs daily operations: products, orders, customers, inbox and stores.',
    permissions: [
      'org.view',
      'org.members.view',
      'org.audit.view',
      'billing.view',
      'stores.view',
      'stores.manage',
      'stores.publish',
      'catalog.view',
      'catalog.manage',
      'inventory.manage',
      'customers.view',
      'customers.manage',
      'orders.view',
      'orders.create',
      'orders.manage',
      'orders.cancel',
      'orders.print',
      'orders.export',
      'inbox.view',
      'inbox.reply',
      'inbox.assign',
      'inbox.ai_control',
      'ai.knowledge.manage',
      'marketing.view',
      'marketing.manage',
      'analytics.view',
    ],
  },
  {
    key: 'sales_agent',
    name: 'Sales agent',
    description: 'Answers customers and creates orders from the inbox.',
    permissions: [
      'org.view',
      'catalog.view',
      'customers.view',
      'customers.manage',
      'orders.view',
      'orders.create',
      'orders.print',
      'inbox.view_assigned',
      'inbox.reply',
      'inbox.ai_control',
    ],
  },
  {
    key: 'fulfillment',
    name: 'Fulfillment',
    description: 'Packs and ships orders and keeps stock accurate.',
    permissions: [
      'org.view',
      'catalog.view',
      'inventory.manage',
      'customers.view',
      'orders.view',
      'orders.manage',
      'orders.print',
    ],
  },
  {
    key: 'accountant',
    name: 'Accountant',
    description: 'Sees money: orders, billing, wallet and reports.',
    permissions: [
      'org.view',
      'billing.view',
      'orders.view',
      'orders.export',
      'customers.view',
      'analytics.view',
    ],
  },
  {
    key: 'viewer',
    name: 'Viewer',
    description: 'Read-only access.',
    permissions: views,
  },
];

export function systemRole(key: string): SystemRole | undefined {
  return SYSTEM_ROLES.find((r) => r.key === key);
}
