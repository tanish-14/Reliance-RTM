import { Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcryptjs';
import type { User } from '@prisma/client';
import { ROLE_HOME, type LoginInput, type Role } from '@rtm/shared';
import { PrismaService } from '../prisma.service';
import { DomainError } from '../common/errors';
import { AuditService } from '../core/audit.service';
import { newSecret, otpauthUrl, totp, verifyTotp } from './totp';

/** Roles that must pass a second factor (HQ / managers and admins). Off with MFA_REQUIRED=0. */
const MFA_ROLES = new Set(process.env.MFA_REQUIRED === '0' ? [] : ['MANAGER', 'ADMIN']);
/** Demo only: echo the current code so the app can be explored without an authenticator. */
const DEMO = process.env.DEMO_MODE === '1' && process.env.NODE_ENV !== 'production';

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly audit: AuditService,
  ) {}

  private actor(u: User) {
    return { userId: u.id, tenantId: u.tenantId, role: u.role as Role };
  }

  private async session(user: User) {
    const token = await this.jwt.signAsync({
      sub: user.id,
      tid: user.tenantId,
      role: user.role,
      name: user.name,
      hp: user.hierarchyPath,
      did: user.distributorId,
      oid: user.outletId,
      mfa: MFA_ROLES.has(user.role),
    });
    await this.prisma.tx((tx) => this.audit.record(tx, this.actor(user), 'LOGIN', 'User', user.id, { meta: { mfa: MFA_ROLES.has(user.role) } }));
    return {
      token,
      home: ROLE_HOME[user.role as Role],
      user: { id: user.id, name: user.name, email: user.email, role: user.role, title: user.title, distributorId: user.distributorId, outletId: user.outletId },
    };
  }

  async login(input: LoginInput) {
    const tenant = await this.prisma.tenant.findUnique({ where: { code: input.tenant } });
    const user = tenant
      ? await this.prisma.user.findUnique({ where: { tenantId_email: { tenantId: tenant.id, email: input.email.toLowerCase() } } })
      : null;
    // Same error for unknown user and bad password; system (integration) users can never log in.
    if (!user || !user.active || user.role === 'SYSTEM' || !(await bcrypt.compare(input.password, user.passwordHash))) {
      throw new DomainError('BAD_CREDENTIALS', 'Email or password is incorrect', 401);
    }
    if (!MFA_ROLES.has(user.role)) return this.session(user);

    // Second factor: a short-lived token that only /auth/mfa/verify accepts.
    let secret = user.mfaSecret;
    const enroll = !user.mfaEnabled;
    if (enroll && !secret) {
      secret = newSecret();
      await this.prisma.user.update({ where: { id: user.id }, data: { mfaSecret: secret } });
    }
    const mfaToken = await this.jwt.signAsync({ sub: user.id, purpose: 'mfa' }, { expiresIn: '5m' });
    return {
      mfaRequired: true,
      enroll,
      ...(enroll ? { secret, otpauthUrl: otpauthUrl(secret!, user.email) } : {}),
      mfaToken,
      ...(DEMO ? { demoCode: totp(secret!) } : {}),
    };
  }

  async verifyMfa(mfaToken: string, code: string) {
    let claims: { sub: string; purpose?: string };
    try {
      claims = this.jwt.verify(mfaToken);
    } catch {
      throw new DomainError('MFA_EXPIRED', 'Sign in again', 401);
    }
    if (claims.purpose !== 'mfa') throw new DomainError('BAD_TOKEN', 'Not an MFA token', 401);
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: claims.sub } });
    if (!user.mfaSecret || !verifyTotp(user.mfaSecret, code)) {
      await this.prisma.tx((tx) => this.audit.record(tx, this.actor(user), 'MFA_FAILED', 'User', user.id));
      throw new DomainError('BAD_CODE', 'That code is not valid — check your authenticator app', 401);
    }
    if (!user.mfaEnabled) {
      await this.prisma.user.update({ where: { id: user.id }, data: { mfaEnabled: true } });
      await this.prisma.tx((tx) => this.audit.record(tx, this.actor(user), 'MFA_ENROLLED', 'User', user.id));
    }
    return this.session(user);
  }
}
