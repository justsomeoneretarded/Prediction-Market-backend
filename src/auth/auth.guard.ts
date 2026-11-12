import { CanActivate, ExecutionContext, Injectable, SetMetadata, UseGuards, applyDecorators, createParamDecorator } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { DomainError } from '../common/errors';
import { config } from '../config';
import { AuthedRequest, Permission, can } from './auth.types';

const PERM_KEY = 'tb:permission';

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}
  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest<AuthedRequest>();
    if (!req.user) throw new DomainError('Please log in', 401, 'UNAUTHENTICATED');
    const perm = this.reflector.get<Permission | undefined>(PERM_KEY, ctx.getHandler())
      ?? this.reflector.get<Permission | undefined>(PERM_KEY, ctx.getClass());
    if (perm) {
      if (!can(req.user.roles, perm)) throw new DomainError('You do not have permission to do that', 403, 'FORBIDDEN');
      // Stronger auth for privileged accounts: TOTP must be enrolled and verified for this session.
      if (config().ADMIN_REQUIRE_2FA && !req.user.twoFactorVerified) {
        throw new DomainError('Two-factor authentication is required for administrative actions', 403, 'TWO_FACTOR_REQUIRED');
      }
    }
    return true;
  }
}

/** Require a logged-in user, optionally with a permission. */
export const Auth = (permission?: Permission) =>
  applyDecorators(...(permission ? [SetMetadata(PERM_KEY, permission)] : []), UseGuards(AuthGuard));

export const CurrentUser = createParamDecorator((_: unknown, ctx: ExecutionContext) => ctx.switchToHttp().getRequest<AuthedRequest>().user);
export const ClientIp = createParamDecorator((_: unknown, ctx: ExecutionContext) => ctx.switchToHttp().getRequest<AuthedRequest>().ip ?? null);
