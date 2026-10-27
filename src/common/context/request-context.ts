import { AsyncLocalStorage } from 'node:async_hooks';

export type ActorType = 'user' | 'platform' | 'system' | 'visitor' | 'anonymous';

export interface Actor {
  type: ActorType;
  /** User, platform user, visitor id or system job name. */
  id: string;
  sessionId?: string;
  /** Authentication methods used for this session (pwd, totp, recovery, passkey). */
  amr?: string[];
  /** Platform role for platform actors. */
  platformRole?: string;
  /** Set when a platform admin acts inside a tenant (support access). */
  impersonatedBy?: string;
}

export interface TenantScope {
  orgId: string;
  membershipId?: string;
  roleKey?: string;
  permissions: ReadonlySet<string>;
}

export interface RequestContextStore {
  requestId: string;
  ip?: string;
  userAgent?: string;
  actor: Actor;
  tenant?: TenantScope;
}

const storage = new AsyncLocalStorage<RequestContextStore>();

/**
 * Per-request (or per-job) context carried through async calls. Repositories read the
 * tenant scope from here, so a query can never silently run without a tenant.
 */
export const RequestContext = {
  run<T>(store: RequestContextStore, fn: () => T): T {
    return storage.run(store, fn);
  },

  current(): RequestContextStore | undefined {
    return storage.getStore();
  },

  require(): RequestContextStore {
    const store = storage.getStore();
    if (!store) throw new Error('RequestContext is not available outside a request or job');
    return store;
  },

  actor(): Actor {
    return storage.getStore()?.actor ?? { type: 'anonymous', id: 'anonymous' };
  },

  setActor(actor: Actor): void {
    const store = RequestContext.require();
    store.actor = actor;
  },

  setTenant(tenant: TenantScope): void {
    const store = RequestContext.require();
    store.tenant = tenant;
  },

  tenant(): TenantScope | undefined {
    return storage.getStore()?.tenant;
  },

  /**
   * Runs `fn` with an explicit tenant scope. Used by workers, webhooks and the platform
   * realm when they need to touch one tenant's data deliberately.
   */
  withTenant<T>(orgId: string, fn: () => T, actor?: Actor): T {
    const parent = storage.getStore();
    const store: RequestContextStore = {
      requestId: parent?.requestId ?? `job-${Date.now().toString(36)}`,
      ip: parent?.ip,
      userAgent: parent?.userAgent,
      actor: actor ?? parent?.actor ?? { type: 'system', id: 'system' },
      tenant: { orgId, permissions: new Set(['*']) },
    };
    return storage.run(store, fn);
  },
};
