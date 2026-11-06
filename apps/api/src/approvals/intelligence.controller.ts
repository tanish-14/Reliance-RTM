import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import { CurrentUser, Public, Roles, type AuthUser } from '../common/auth';
import { ZodPipe } from '../common/zod.pipe';
import { AnalyticsService } from '../reports/analytics.service';
import { PrivacyService } from '../privacy/privacy.service';
import { ApprovalsService } from './approvals.service';

const Decision = z.object({ decision: z.enum(['APPROVE', 'REJECT']), note: z.string().max(300).optional() });
const LimitRequest = z.object({ newLimitRupees: z.number().positive(), reason: z.string().min(3).max(300) });
const Consents = z.object({ items: z.array(z.object({ purpose: z.string(), granted: z.boolean() })).min(1) });
const DataReq = z.object({ type: z.enum(['ACCESS', 'CORRECTION', 'ERASURE']), details: z.string().max(1000).optional() });
const Complete = z.object({ decision: z.enum(['COMPLETE', 'REJECT']), note: z.string().max(300).optional() });

@Controller()
export class IntelligenceController {
  constructor(
    private readonly analytics: AnalyticsService,
    private readonly approvals: ApprovalsService,
    private readonly privacy: PrivacyService,
  ) {}

  @Get('reports/kpis')
  @Roles('MANAGER', 'ADMIN')
  kpis(@CurrentUser() u: AuthUser, @Query('from') from?: string, @Query('to') to?: string) {
    return this.analytics.kpis(u, from, to);
  }

  // ---- approvals
  @Get('approvals')
  @Roles('MANAGER', 'ADMIN')
  inbox(@CurrentUser() u: AuthUser) {
    return this.approvals.inbox(u);
  }

  @Post('approvals/:id/decide')
  @Roles('MANAGER', 'ADMIN')
  decide(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body(new ZodPipe(Decision)) b: z.infer<typeof Decision>) {
    return this.approvals.decide(u, id, b.decision, b.note);
  }

  @Post('schemes/:id/request-activation')
  @Roles('MANAGER', 'ADMIN')
  activate(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    return this.approvals.requestSchemeActivation(u, id);
  }

  @Post('credit/accounts/:id/limit-request')
  @Roles('DISTRIBUTOR', 'MANAGER', 'ADMIN')
  limit(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body(new ZodPipe(LimitRequest)) b: z.infer<typeof LimitRequest>) {
    return this.approvals.requestCreditLimit(u, id, Math.round(b.newLimitRupees * 100), b.reason);
  }

  // ---- DPDP
  @Public()
  @Get('privacy/notice')
  notice() {
    return this.privacy.notice();
  }

  @Get('privacy/consents')
  consents(@CurrentUser() u: AuthUser) {
    return this.privacy.consents(u);
  }

  @Post('privacy/consents')
  setConsents(@CurrentUser() u: AuthUser, @Body(new ZodPipe(Consents)) b: z.infer<typeof Consents>) {
    return this.privacy.setConsents(u, b.items, 'app');
  }

  @Get('privacy/export')
  export(@CurrentUser() u: AuthUser) {
    return this.privacy.export(u);
  }

  @Post('privacy/requests')
  request(@CurrentUser() u: AuthUser, @Body(new ZodPipe(DataReq)) b: z.infer<typeof DataReq>) {
    return this.privacy.request(u, b.type, b.details);
  }

  @Get('privacy/requests')
  myRequests(@CurrentUser() u: AuthUser) {
    return this.privacy.myRequests(u);
  }

  @Get('admin/privacy/requests')
  @Roles('ADMIN')
  all(@CurrentUser() u: AuthUser) {
    return this.privacy.allRequests(u);
  }

  @Post('admin/privacy/requests/:id/complete')
  @Roles('ADMIN')
  complete(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body(new ZodPipe(Complete)) b: z.infer<typeof Complete>) {
    return this.privacy.complete(u, id, b.decision, b.note);
  }
}
