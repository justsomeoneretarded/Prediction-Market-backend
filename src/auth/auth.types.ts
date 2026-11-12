import type { Request } from 'express';
import type { Role } from '@prisma/client';

export interface AuthUser {
  id: string;
  email: string;
  username: string;
  displayName: string;
  roles: Role[];
  locale: string;
  totpEnabled: boolean;
  sessionId: string;
  twoFactorVerified: boolean;
}

export type AuthedRequest = Request & { user?: AuthUser };

export const SESSION_COOKIE = 'tb_session';
export const CSRF_COOKIE = 'tb_csrf';
export const CSRF_HEADER = 'x-csrf-token';

/** What each role is allowed to do. ADMIN implies everything. */
export const PERMISSIONS = {
  'market:manage': ['ADMIN'],
  'market:resolve:propose': ['ADMIN', 'RESOLVER'],
  'market:resolve:review': ['ADMIN', 'REVIEWER'],
  'dispute:resolve': ['ADMIN', 'REVIEWER'],
  'wallet:adjust': ['ADMIN'],
  'payments:approve': ['ADMIN'],
  'admin:read': ['ADMIN', 'RESOLVER', 'REVIEWER'],
  'users:manage': ['ADMIN'],
  'system:clock': ['ADMIN'],
} as const satisfies Record<string, Role[]>;
export type Permission = keyof typeof PERMISSIONS;

export const can = (roles: Role[], p: Permission) =>
  roles.some((r) => (PERMISSIONS[p] as readonly Role[]).includes(r));
