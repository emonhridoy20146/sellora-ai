'use client';

import { createContext, useContext } from 'react';
import type { OrgWithRole } from '@/lib/api/types';

interface OrgContextValue {
  org: OrgWithRole;
  can: (permission: string) => boolean;
  /** Plan modules the business can use right now (from billing entitlements). */
  modules: string[] | null;
}

const OrgContext = createContext<OrgContextValue | null>(null);

export const OrgProvider = OrgContext.Provider;

export function useOrg(): OrgContextValue {
  const ctx = useContext(OrgContext);
  if (!ctx) throw new Error('useOrg must be used inside a business page');
  return ctx;
}

/** Renders children only when the member has the permission (the API enforces it anyway). */
export function Can({ permission, children }: { permission: string; children: React.ReactNode }) {
  const { can } = useOrg();
  return can(permission) ? <>{children}</> : null;
}
