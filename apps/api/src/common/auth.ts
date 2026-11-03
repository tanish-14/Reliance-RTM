import {
  CanActivate,
  createParamDecorator,
  ExecutionContext,
  Injectable,
  SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import type { Role } from '@rtm/shared';
import { DomainError, forbidden } from './errors';

/** What a verified JWT gives every request. */
export interface AuthUser {
  userId: string;
  tenantId: string;
  role: Role;
  name: string;
  hierarchyPath: string;
  distributorId: string | null;
  outletId: string | null;
}

const PUBLIC = 'rtm:public';
const ROLES = 'rtm:roles';
export const Public = () => SetMetadata(PUBLIC, true);
export const Roles = (...roles: Role[]) => SetMetadata(ROLES, roles);

export const CurrentUser = createParamDecorator((_d: unknown, ctx: ExecutionContext): AuthUser => {
  return ctx.switchToHttp().getRequest().user;
});

/** Global guard: every route needs a valid JWT unless marked @Public(). */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly jwt: JwtService,
    private readonly reflector: Reflector,
  ) {}

  canActivate(ctx: ExecutionContext): boolean {
    const isPublic = this.reflector.getAllAndOverride<boolean>(PUBLIC, [ctx.getHandler(), ctx.getClass()]);
    if (isPublic) return true;
    const req = ctx.switchToHttp().getRequest();
    const header: string | undefined = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) throw new DomainError('UNAUTHENTICATED', 'Login required', 401);
    try {
      const claims = this.jwt.verify(header.slice(7));
      req.user = {
        userId: claims.sub,
        tenantId: claims.tid,
        role: claims.role,
        name: claims.name,
        hierarchyPath: claims.hp,
        distributorId: claims.did ?? null,
        outletId: claims.oid ?? null,
      } satisfies AuthUser;
      return true;
    } catch {
      throw new DomainError('UNAUTHENTICATED', 'Session expired, please log in again', 401);
    }
  }
}

/** Global guard: enforces @Roles() where present. Data scoping happens in ScopeService. */
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(ctx: ExecutionContext): boolean {
    const roles = this.reflector.getAllAndOverride<Role[] | undefined>(ROLES, [ctx.getHandler(), ctx.getClass()]);
    if (!roles) return true;
    const user: AuthUser | undefined = ctx.switchToHttp().getRequest().user;
    if (!user || !roles.includes(user.role)) throw forbidden();
    return true;
  }
}
