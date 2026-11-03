import { Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcryptjs';
import { ROLE_HOME, type LoginInput, type Role } from '@rtm/shared';
import { PrismaService } from '../prisma.service';
import { DomainError } from '../common/errors';
import { AuditService } from '../core/audit.service';

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly audit: AuditService,
  ) {}

  async login(input: LoginInput) {
    const tenant = await this.prisma.tenant.findUnique({ where: { code: input.tenant } });
    const user = tenant
      ? await this.prisma.user.findUnique({ where: { tenantId_email: { tenantId: tenant.id, email: input.email.toLowerCase() } } })
      : null;
    // Same error for unknown user and bad password.
    if (!user || !user.active || !(await bcrypt.compare(input.password, user.passwordHash))) {
      throw new DomainError('BAD_CREDENTIALS', 'Email or password is incorrect', 401);
    }
    const token = await this.jwt.signAsync({
      sub: user.id,
      tid: user.tenantId,
      role: user.role,
      name: user.name,
      hp: user.hierarchyPath,
      did: user.distributorId,
      oid: user.outletId,
    });
    await this.prisma.tx((tx) =>
      this.audit.record(tx, { userId: user.id, tenantId: user.tenantId, role: user.role as Role }, 'LOGIN', 'User', user.id),
    );
    return {
      token,
      home: ROLE_HOME[user.role as Role],
      user: { id: user.id, name: user.name, email: user.email, role: user.role, title: user.title, distributorId: user.distributorId, outletId: user.outletId },
    };
  }
}
