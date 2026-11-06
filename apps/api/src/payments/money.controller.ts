import { Body, Controller, Get, Headers, HttpCode, Param, Post, Query, Req } from '@nestjs/common';
import type { Request } from 'express';
import { z } from 'zod';
import { ClaimInput, SchemeInput } from '@rtm/shared';
import { PrismaService } from '../prisma.service';
import { CurrentUser, Public, Roles, type AuthUser } from '../common/auth';
import { ZodPipe } from '../common/zod.pipe';
import { DomainError, notFound } from '../common/errors';
import { ScopeService } from '../core/scope.service';
import { CreditService } from '../orders/credit.service';
import { JobsService } from '../jobs/jobs.service';
import { SchemesService } from '../schemes/schemes.service';
import { PaymentsService } from './payments.service';
import { ApprovalsService } from '../approvals/approvals.service';
import { ReconService } from './recon.service';

const IntentBody = z.object({ outletId: z.string(), amountPaise: z.number().int().positive().optional(), purpose: z.enum(['ORDER', 'OUTSTANDING']), orderId: z.string().optional(), distributorId: z.string().optional() });
const RefundBody = z.object({ amountPaise: z.number().int().positive(), reason: z.string().min(3).max(200) });
const BounceBody = z.object({ reason: z.string().min(3).max(200) });
const TransferBody = z.object({ outletId: z.string(), amountPaise: z.number().int().positive(), utr: z.string().min(6).max(40), distributorId: z.string().optional() });
const DepositBody = z.object({ agentId: z.string().optional(), distributorId: z.string().optional(), declaredPaise: z.number().int().nonnegative(), bankRef: z.string().min(4).max(40), slipDate: z.string() });
const StatementBody = z.object({ distributorId: z.string(), csv: z.string().min(10).max(1_000_000) });
const ClaimDecision = z.object({ decision: z.enum(['APPROVE', 'REJECT']), approveRupees: z.number().nonnegative().optional(), note: z.string().max(300).optional() });

@Controller()
export class MoneyController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly payments: PaymentsService,
    private readonly recon: ReconService,
    private readonly credit: CreditService,
    private readonly scope: ScopeService,
    private readonly jobs: JobsService,
    private readonly schemes: SchemesService,
    private readonly approvals: ApprovalsService,
  ) {}

  // ---- online payments
  @Post('payments/intents')
  @Roles('RETAILER', 'DSR', 'DISTRIBUTOR')
  intent(@CurrentUser() u: AuthUser, @Body(new ZodPipe(IntentBody)) b: z.infer<typeof IntentBody>) {
    if (b.purpose === 'OUTSTANDING' && !b.amountPaise) throw new DomainError('VALIDATION', 'amountPaise is required to pay dues', 400);
    return this.payments.createIntent(u, { ...b, amountPaise: b.amountPaise ?? 0 });
  }

  @Get('payments/intents/:id')
  intentStatus(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    return this.payments.intentStatus(u, id);
  }

  /** Local mock checkout only (404 with a real gateway). */
  @Post('payments/intents/:id/mock-complete')
  @HttpCode(200)
  mockComplete(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body(new ZodPipe(z.object({ outcome: z.enum(['success', 'failure']) }))) b: { outcome: 'success' | 'failure' }) {
    return this.payments.mockComplete(u, id, b.outcome);
  }

  /** Gateway webhook — signature over the raw body is the only authentication. */
  @Public()
  @Post('payments/webhook')
  @HttpCode(200)
  webhook(@Req() req: Request & { rawBody?: Buffer }, @Headers('x-razorpay-signature') sig?: string) {
    if (!req.rawBody) throw new DomainError('NO_BODY', 'Raw body unavailable', 400);
    return this.payments.webhook(req.rawBody, sig);
  }

  @Post('payments/mock/settle')
  @Roles('ADMIN')
  mockSettle() {
    return this.payments.mockSettle();
  }

  @Get('payments')
  @Roles('DISTRIBUTOR', 'MANAGER', 'ADMIN', 'RETAILER')
  list(@CurrentUser() u: AuthUser, @Query('mode') mode?: string, @Query('status') status?: string, @Query('outletId') outletId?: string) {
    return this.payments.list(u, { mode, status, outletId });
  }

  @Post('payments/:id/refund')
  @Roles('DISTRIBUTOR', 'ADMIN')
  refund(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body(new ZodPipe(RefundBody)) b: z.infer<typeof RefundBody>) {
    return this.payments.refund(u, id, b.amountPaise, b.reason);
  }

  // ---- cheques & transfers
  @Post('payments/:id/cheque/deposit')
  @Roles('DISTRIBUTOR', 'ADMIN')
  chequeDeposit(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    return this.payments.chequeDeposit(u, id).then(() => ({ ok: true }));
  }

  @Post('payments/:id/cheque/clear')
  @Roles('DISTRIBUTOR', 'ADMIN')
  async chequeClear(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    await this.prisma.tx(async (tx) => {
      const p = await tx.payment.findFirst({ where: { id, tenantId: u.tenantId } });
      if (!p) throw notFound('Payment');
      await this.scope.assertDistributor(tx, u, p.distributorId);
      await this.payments.chequeClear(tx, u, p);
    });
    return { ok: true };
  }

  @Post('payments/:id/cheque/bounce')
  @Roles('DISTRIBUTOR', 'ADMIN')
  bounce(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body(new ZodPipe(BounceBody)) b: z.infer<typeof BounceBody>) {
    return this.payments.chequeBounce(u, id, b.reason).then(() => ({ ok: true }));
  }

  @Post('payments/bank-transfer')
  @Roles('DISTRIBUTOR', 'RETAILER', 'ADMIN')
  transfer(@CurrentUser() u: AuthUser, @Body(new ZodPipe(TransferBody)) b: z.infer<typeof TransferBody>) {
    return this.payments.recordBankTransfer(u, b);
  }

  // ---- cash day-end
  @Get('cash/position')
  @Roles('DSR', 'DISTRIBUTOR', 'MANAGER', 'ADMIN')
  async cashPosition(@CurrentUser() u: AuthUser, @Query('distributorId') distributorId?: string, @Query('agentId') agentId?: string) {
    const dist = distributorId ?? u.distributorId;
    const agent = u.role === 'DSR' ? u.userId : agentId;
    if (!dist || !agent) throw new DomainError('VALIDATION', 'distributorId and agentId are required', 400);
    if (u.role === 'DSR') return { amountPaise: await this.recon.cashPosition({ ...u, role: 'ADMIN' }, dist, agent) };
    return { amountPaise: await this.recon.cashPosition(u, dist, agent) };
  }

  @Post('cash/deposits')
  @Roles('DSR', 'DISTRIBUTOR', 'ADMIN')
  deposit(@CurrentUser() u: AuthUser, @Body(new ZodPipe(DepositBody)) b: z.infer<typeof DepositBody>) {
    return this.recon.deposit(u, b);
  }

  @Get('cash/deposits')
  @Roles('DSR', 'DISTRIBUTOR', 'MANAGER', 'ADMIN')
  deposits(@CurrentUser() u: AuthUser) {
    return this.recon.deposits(u);
  }

  @Post('cash/deposits/:id/write-off')
  @Roles('MANAGER', 'ADMIN')
  writeOff(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body(new ZodPipe(z.object({ note: z.string().min(3) }))) b: { note: string }) {
    return this.recon.writeOffShortage(u, id, b.note).then(() => ({ ok: true }));
  }

  // ---- bank reconciliation
  @Post('recon/statements')
  @Roles('DISTRIBUTOR', 'ADMIN')
  statement(@CurrentUser() u: AuthUser, @Body(new ZodPipe(StatementBody)) b: z.infer<typeof StatementBody>) {
    return this.recon.importStatement(u, b.distributorId, b.csv);
  }

  @Get('recon/lines')
  @Roles('DISTRIBUTOR', 'MANAGER', 'ADMIN')
  lines(@CurrentUser() u: AuthUser, @Query('distributorId') distributorId?: string) {
    const d = distributorId ?? u.distributorId;
    if (!d) throw new DomainError('VALIDATION', 'distributorId required', 400);
    return this.recon.lines(u, d);
  }

  @Get('exceptions')
  @Roles('DISTRIBUTOR', 'MANAGER', 'ADMIN')
  async exceptions(@CurrentUser() u: AuthUser, @Query('status') status = 'OPEN') {
    const ids = await this.scope.distributorIds(this.prisma, u);
    return this.prisma.exceptionItem.findMany({
      where: { tenantId: u.tenantId, status, ...(ids === 'ALL' ? {} : { OR: [{ distributorId: { in: ids } }, ...(u.role === 'DISTRIBUTOR' ? [] : [{ distributorId: null }])] }) },
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
  }

  // ---- credit / khata
  @Get('credit/accounts')
  @Roles('DISTRIBUTOR', 'MANAGER', 'ADMIN', 'RETAILER')
  async creditAccounts(@CurrentUser() u: AuthUser) {
    const ids = await this.scope.distributorIds(this.prisma, u);
    const accounts = await this.prisma.creditAccount.findMany({
      where: { tenantId: u.tenantId, ...(u.role === 'RETAILER' ? { outletId: u.outletId ?? '-' } : ids === 'ALL' ? {} : { distributorId: { in: ids } }) },
    });
    const outlets = new Map((await this.prisma.outlet.findMany({ where: { id: { in: accounts.map((a) => a.outletId) } }, select: { id: true, name: true, code: true } })).map((o) => [o.id, o]));
    const out = [];
    for (const a of accounts) {
      const [pos, age] = await Promise.all([this.credit.position(this.prisma, u.tenantId, a.outletId, a.distributorId), this.credit.ageing(this.prisma, u.tenantId, a.outletId, a.distributorId)]);
      out.push({ ...a, outlet: outlets.get(a.outletId), position: pos, ageing: { buckets: age.buckets, maxDaysPastDue: age.maxDaysPastDue, open: age.open } });
    }
    return out;
  }

  // ---- schemes & claims
  @Get('schemes')
  @Roles('MANAGER', 'ADMIN', 'DISTRIBUTOR')
  schemeList(@CurrentUser() u: AuthUser) {
    return this.schemes.list(u);
  }

  @Post('schemes')
  @Roles('ADMIN')
  schemeUpsert(@CurrentUser() u: AuthUser, @Body(new ZodPipe(SchemeInput)) b: z.infer<typeof SchemeInput>) {
    return this.prisma.tx((tx) => this.schemes.upsert(tx, u, b));
  }

  /** Pause / end directly; activation of a DRAFT goes through the approval workflow. */
  @Post('schemes/:id/status')
  @Roles('MANAGER', 'ADMIN')
  schemeStatus(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body(new ZodPipe(z.object({ status: z.enum(['PAUSED', 'ENDED', 'ACTIVE']) }))) b: { status: 'PAUSED' | 'ENDED' | 'ACTIVE' }) {
    return this.prisma.tx(async (tx) => {
      const s = await tx.scheme.findFirst({ where: { id, tenantId: u.tenantId } });
      if (b.status === 'ACTIVE' && s?.status === 'DRAFT') throw new DomainError('APPROVAL_REQUIRED', 'Request activation through Approvals', 409);
      return this.schemes.setStatus(tx, u, id, b.status);
    });
  }

  @Get('schemes/roi')
  @Roles('MANAGER', 'ADMIN')
  roi(@CurrentUser() u: AuthUser) {
    return this.schemes.roi(u);
  }

  @Post('claims')
  @Roles('DISTRIBUTOR')
  claim(@CurrentUser() u: AuthUser, @Body(new ZodPipe(ClaimInput)) b: z.infer<typeof ClaimInput>) {
    // A validated claim waits in the approval inbox for an approver of the right level.
    return this.schemes.submitClaim(u, b, (tx, claim) => this.approvals.requestClaim(tx, u, claim));
  }

  @Get('claims')
  @Roles('DISTRIBUTOR', 'MANAGER', 'ADMIN')
  claims(@CurrentUser() u: AuthUser) {
    return this.schemes.claims(u);
  }

  @Post('claims/:id/decide')
  @Roles('MANAGER', 'ADMIN')
  async decide(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body(new ZodPipe(ClaimDecision)) b: z.infer<typeof ClaimDecision>) {
    const pending = await this.prisma.approval.findFirst({ where: { tenantId: u.tenantId, refType: 'Claim', refId: id, status: 'PENDING' } });
    if (pending) {
      if (b.approveRupees !== undefined) await this.prisma.approval.update({ where: { id: pending.id }, data: { payload: { approveRupees: b.approveRupees } } });
      await this.approvals.decide(u, pending.id, b.decision, b.note);
      return this.prisma.claim.findUniqueOrThrow({ where: { id } });
    }
    return this.prisma.tx((tx) => this.schemes.decideClaim(tx, u, id, b.decision, b.approveRupees, b.note));
  }

  @Post('claims/:id/settle')
  @Roles('ADMIN')
  settle(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    return this.schemes.settleClaim(u, id);
  }

  @Post('invoices/:id/scheme-correction')
  @Roles('DISTRIBUTOR', 'MANAGER', 'ADMIN')
  correct(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body(new ZodPipe(z.object({ schemeCode: z.string(), reason: z.string().min(3) }))) b: { schemeCode: string; reason: string }) {
    return this.schemes.correct(u, id, b.schemeCode, b.reason);
  }

  // ---- jobs (ops)
  @Get('admin/jobs')
  @Roles('ADMIN')
  jobsList(@Query('status') status?: string) {
    return this.prisma.job.findMany({ where: status ? { status } : {}, orderBy: { createdAt: 'desc' }, take: 100 });
  }

  @Post('admin/jobs/drain')
  @Roles('ADMIN')
  async drain() {
    return { ran: await this.jobs.drain() };
  }
}

