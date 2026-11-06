import { Body, Controller, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import {
  CancelSchema,
  DeliverSchema,
  FulfilSchema,
  LoginSchema,
  ReturnDecisionSchema,
  ReviewDecisionSchema,
  SyncPushSchema,
  type LoginInput,
  type SyncPushInput,
} from '@rtm/shared';
import { z } from 'zod';
import { PrismaService } from './prisma.service';
import { CurrentUser, Public, Roles, type AuthUser } from './common/auth';
import { ZodPipe } from './common/zod.pipe';
import { DomainError, notFound } from './common/errors';
import { AuthService } from './auth/auth.service';
import { SyncService } from './sync/sync.service';
import { MastersService } from './sync/masters.service';
import { OrdersService } from './orders/orders.service';
import { FulfilmentService } from './orders/fulfilment.service';
import { ReturnsService } from './field/returns.service';
import { ReportsService } from './reports/reports.service';
import { ScopeService } from './core/scope.service';
import { LedgerService } from './core/ledger.service';
import { ReviewService } from './core/review.service';
import { AuditService } from './core/audit.service';

@Controller()
export class HealthController {
  constructor(private readonly prisma: PrismaService) {}

  @Public()
  @Get('health')
  async health() {
    await this.prisma.$queryRaw`SELECT 1`;
    return { ok: true, time: new Date().toISOString() };
  }
}

@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Public()
  @Post('login')
  @HttpCode(200)
  login(@Body(new ZodPipe(LoginSchema)) body: LoginInput) {
    return this.auth.login(body);
  }

  @Public()
  @Post('mfa/verify')
  @HttpCode(200)
  verify(@Body(new ZodPipe(z.object({ mfaToken: z.string(), code: z.string() }))) body: { mfaToken: string; code: string }) {
    return this.auth.verifyMfa(body.mfaToken, body.code);
  }

  @Get('me')
  me(@CurrentUser() user: AuthUser) {
    return user;
  }
}

@Controller('sync')
@Roles('DSR', 'RETAILER')
export class SyncController {
  constructor(
    private readonly sync: SyncService,
    private readonly masters: MastersService,
    private readonly prisma: PrismaService,
  ) {}

  /** Masters pull (server wins). */
  @Get('pull')
  pull(@CurrentUser() user: AuthUser) {
    return this.masters.bundle(this.prisma, user);
  }

  /** Outbox push. Always 200 with a per-mutation result; the device acts on each status. */
  @Post('push')
  @HttpCode(200)
  push(@CurrentUser() user: AuthUser, @Body(new ZodPipe(SyncPushSchema)) body: SyncPushInput) {
    return this.sync.push(user, body);
  }
}

@Controller('orders')
export class OrdersController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly orders: OrdersService,
    private readonly fulfilment: FulfilmentService,
  ) {}

  @Get()
  list(@CurrentUser() user: AuthUser, @Query('status') status?: string) {
    return this.orders.list(this.prisma, user, status);
  }

  @Get(':id')
  detail(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.orders.detail(this.prisma, user, id);
  }

  @Post(':id/fulfil')
  @Roles('DISTRIBUTOR', 'ADMIN')
  fulfil(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body(new ZodPipe(FulfilSchema)) body: z.infer<typeof FulfilSchema>) {
    const caps = body.lines ? Object.fromEntries(body.lines.map((l) => [l.orderLineId, l.qty])) : undefined;
    return this.prisma.tx((tx) => this.fulfilment.fulfil(tx, user, id, { caps }));
  }

  @Post(':id/review')
  @Roles('MANAGER', 'ADMIN')
  review(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body(new ZodPipe(ReviewDecisionSchema)) body: z.infer<typeof ReviewDecisionSchema>) {
    return this.prisma.tx((tx) => this.orders.review(tx, user, id, body.decision, body.note)).then(() => ({ ok: true }));
  }

  @Post(':id/cancel')
  @Roles('DISTRIBUTOR', 'MANAGER', 'ADMIN')
  cancel(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body(new ZodPipe(CancelSchema)) body: z.infer<typeof CancelSchema>) {
    return this.prisma.tx((tx) => this.orders.cancel(tx, user, id, body.reason)).then(() => ({ ok: true }));
  }

  @Post(':id/close-short')
  @Roles('DISTRIBUTOR', 'ADMIN')
  closeShort(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body(new ZodPipe(CancelSchema)) body: z.infer<typeof CancelSchema>) {
    return this.prisma.tx((tx) => this.orders.closeShort(tx, user, id, body.reason)).then(() => ({ ok: true }));
  }
}

@Controller()
export class DistributionController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly fulfilment: FulfilmentService,
    private readonly returns: ReturnsService,
    private readonly scope: ScopeService,
    private readonly ledger: LedgerService,
  ) {}

  @Post('deliveries/:id/deliver')
  @Roles('DISTRIBUTOR', 'ADMIN')
  deliver(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body(new ZodPipe(DeliverSchema)) body: z.infer<typeof DeliverSchema>) {
    return this.prisma.tx((tx) => this.fulfilment.deliver(tx, user, id, body.podNote, body.cod)).then(() => ({ ok: true }));
  }

  @Get('returns')
  @Roles('DISTRIBUTOR', 'MANAGER', 'ADMIN')
  async listReturns(@CurrentUser() user: AuthUser) {
    const ids = await this.scope.distributorIds(this.prisma, user);
    const rows = await this.prisma.return.findMany({
      where: { tenantId: user.tenantId, ...(ids === 'ALL' ? {} : { distributorId: { in: ids } }) },
      include: { lines: true },
      orderBy: { capturedAt: 'desc' },
      take: 100,
    });
    const [outlets, products, notes] = await Promise.all([
      this.prisma.outlet.findMany({ where: { id: { in: rows.map((r) => r.outletId) } }, select: { id: true, name: true } }),
      this.prisma.product.findMany({ where: { tenantId: user.tenantId }, select: { id: true, name: true } }),
      this.prisma.creditNote.findMany({ where: { returnId: { in: rows.map((r) => r.id) } } }),
    ]);
    const on = new Map(outlets.map((o) => [o.id, o.name]));
    const pn = new Map(products.map((p) => [p.id, p.name]));
    const cn = new Map(notes.map((n) => [n.returnId, n]));
    return rows.map((r) => ({
      ...r,
      outlet: on.get(r.outletId),
      creditNote: cn.get(r.id) ?? null,
      lines: r.lines.map((l) => ({ ...l, product: pn.get(l.productId) })),
    }));
  }

  @Post('returns/:id/decide')
  @Roles('DISTRIBUTOR', 'ADMIN')
  decide(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body(new ZodPipe(ReturnDecisionSchema)) body: z.infer<typeof ReturnDecisionSchema>) {
    return this.prisma.tx((tx) => this.returns.decide(tx, user, id, body.decision, body.note));
  }

  @Get('inventory')
  @Roles('DISTRIBUTOR', 'MANAGER', 'ADMIN')
  async inventory(@CurrentUser() user: AuthUser) {
    const ids = await this.scope.distributorIds(this.prisma, user);
    const batches = await this.prisma.inventoryBatch.findMany({
      where: { tenantId: user.tenantId, ...(ids === 'ALL' ? {} : { location: { distributorId: { in: ids } } }), qtyOnHand: { gt: 0 } },
      include: { location: { select: { code: true, name: true, type: true } } },
      orderBy: [{ productId: 'asc' }, { expiryDate: 'asc' }],
    });
    const products = await this.prisma.product.findMany({ where: { tenantId: user.tenantId }, select: { id: true, code: true, name: true } });
    const pm = new Map(products.map((p) => [p.id, p]));
    return batches.map((b) => ({ ...b, product: pm.get(b.productId) }));
  }

  /** Outlet statement in a distributor's books — straight from the ledger. */
  @Get('ledger/statement')
  @Roles('DISTRIBUTOR', 'MANAGER', 'ADMIN')
  async statement(@CurrentUser() user: AuthUser, @Query('outletId') outletId: string, @Query('distributorId') distributorId?: string) {
    const dist = distributorId ?? user.distributorId;
    if (!dist || !outletId) throw new DomainError('VALIDATION', 'outletId and distributorId are required', 400);
    await this.scope.assertDistributor(this.prisma, user, dist);
    const entries = await this.prisma.ledgerEntry.findMany({
      where: { account: { tenantId: user.tenantId, bookOwner: dist, code: `AR:${outletId}` } },
      include: { journal: true },
      orderBy: { journal: { postedAt: 'asc' } },
    });
    let running = 0n;
    return {
      balancePaise: await this.ledger.balance(this.prisma, user.tenantId, dist, `AR:${outletId}`),
      entries: entries.map((e) => {
        running += e.debitPaise - e.creditPaise;
        return { at: e.journal.postedAt, docType: e.journal.docType, narration: e.journal.narration, debitPaise: e.debitPaise, creditPaise: e.creditPaise, runningPaise: running, reversal: !!e.journal.reversalOfId };
      }),
    };
  }
}

@Controller()
export class HqController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly reports: ReportsService,
    private readonly review: ReviewService,
    private readonly audit: AuditService,
    private readonly scope: ScopeService,
    private readonly ledger: LedgerService,
  ) {}

  @Get('reports/summary')
  @Roles('MANAGER', 'ADMIN')
  summary(@CurrentUser() user: AuthUser) {
    return this.reports.summary(user);
  }

  @Post('exceptions/:id/resolve')
  @Roles('MANAGER', 'ADMIN')
  async resolve(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body(new ZodPipe(z.object({ resolution: z.string().min(2).max(300) }))) body: { resolution: string }) {
    const item = await this.prisma.exceptionItem.findFirst({ where: { id, tenantId: user.tenantId } });
    if (!item) throw notFound('Exception');
    if (item.kind === 'ORDER_HOLD') throw new DomainError('USE_ORDER_REVIEW', 'Approve or reject the order instead', 409);
    await this.prisma.tx(async (tx) => {
      await this.review.resolveFor(tx, user.tenantId, item.refType, item.refId, user.userId, body.resolution);
      await this.audit.record(tx, user, 'EXCEPTION_RESOLVED', 'ExceptionItem', id, { meta: body });
    });
    return { ok: true };
  }

  @Get('audit')
  @Roles('ADMIN', 'MANAGER')
  auditLog(@CurrentUser() user: AuthUser, @Query('entityType') entityType?: string, @Query('entityId') entityId?: string) {
    return this.prisma.auditLog.findMany({
      where: { tenantId: user.tenantId, ...(entityType ? { entityType } : {}), ...(entityId ? { entityId } : {}) },
      orderBy: { id: 'desc' },
      take: 200,
    });
  }

  @Get('admin/masters')
  @Roles('ADMIN')
  async masters(@CurrentUser() user: AuthUser) {
    const t = { tenantId: user.tenantId };
    const [channels, rtmModels, distributors, outlets, products, priceLists, schemes, marginRules, users, beats] = await Promise.all([
      this.prisma.channel.findMany({ where: t }),
      this.prisma.rtmModel.findMany({ where: t }),
      this.prisma.distributor.findMany({ where: t }),
      this.prisma.outlet.findMany({ where: t, include: { channel: true, services: { include: { rtmModel: true, distributor: { select: { code: true } } } } }, orderBy: { code: 'asc' } }),
      this.prisma.product.findMany({ where: t, include: { brand: true }, orderBy: { code: 'asc' } }),
      this.prisma.priceList.findMany({ where: t, include: { _count: { select: { items: true } } }, orderBy: [{ code: 'asc' }, { validFrom: 'asc' }] }),
      this.prisma.scheme.findMany({ where: t }),
      this.prisma.marginRule.findMany({ where: t }),
      this.prisma.user.findMany({ where: t, select: { id: true, name: true, email: true, role: true, title: true, hierarchyPath: true } }),
      this.prisma.beat.findMany({ where: t, include: { dsr: { select: { name: true } }, _count: { select: { outlets: true } } } }),
    ]);
    const brandCode = new Map(products.map((p) => [p.brandId, p.brand.code]));
    const withBrands = outlets.map((o) => ({ ...o, services: o.services.map((s) => ({ ...s, brandCodes: s.brandIds.map((b) => brandCode.get(b) ?? b) })) }));
    return { channels, rtmModels, distributors, outlets: withBrands, products, priceLists, schemes, marginRules, users, beats };
  }

  /** Retailer shell placeholder until eB2B (Phase 5): own orders + outstanding. */
  @Get('retailer/summary')
  @Roles('RETAILER')
  async retailer(@CurrentUser() user: AuthUser) {
    if (!user.outletId) throw notFound('Outlet');
    const outlet = await this.prisma.outlet.findUnique({ where: { id: user.outletId }, include: { services: { include: { distributor: true } } } });
    const orders = await this.prisma.order.findMany({ where: await this.scope.orderWhere(this.prisma, user), orderBy: { receivedAt: 'desc' }, take: 20 });
    const balances = [];
    for (const s of outlet?.services ?? []) {
      balances.push({ distributor: s.distributor.name, outstandingPaise: await this.ledger.balance(this.prisma, user.tenantId, s.distributorId, `AR:${user.outletId}`) });
    }
    return { outlet, orders, balances };
  }
}
