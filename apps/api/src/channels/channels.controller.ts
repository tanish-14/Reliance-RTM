import { Body, Controller, Get, Headers, HttpCode, Param, Post, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { CurrentUser, Public, Roles, type AuthUser } from '../common/auth';
import { DomainError } from '../common/errors';
import { IntegrationsService } from '../integrations/integrations.service';
import { ChannelIntakeService } from './channel-intake.service';

@Controller()
export class ChannelsController {
  constructor(
    private readonly intake: ChannelIntakeService,
    private readonly integrations: IntegrationsService,
  ) {}

  /** Partner order intake (MT / e-com / q-com). Authenticated by API key + HMAC signature, not JWT. */
  @Public()
  @Post('integrations/orders/:partner')
  @HttpCode(200)
  async partnerOrder(
    @Param('partner') partner: string,
    @Req() req: Request & { rawBody?: Buffer },
    @Res({ passthrough: true }) res: Response,
    @Headers('x-partner-key') key?: string,
    @Headers('x-partner-signature') sig?: string,
  ) {
    if (!req.rawBody) throw new DomainError('NO_BODY', 'Raw body unavailable', 400);
    const r = await this.intake.intake(partner, req.rawBody, key, sig);
    if (r.status === 'REJECTED') res.status(422);
    return r;
  }

  @Get('admin/partners')
  @Roles('ADMIN')
  partners(@CurrentUser() u: AuthUser) {
    return this.intake.list(u);
  }

  /** Run a payload through the same adapter (no key/signature) — for onboarding a partner's format. */
  @Post('admin/partners/:code/simulate')
  @Roles('ADMIN')
  @HttpCode(200)
  simulate(@CurrentUser() u: AuthUser, @Param('code') code: string, @Body() body: unknown) {
    return this.intake.simulate(u, code, body);
  }

  @Get('admin/integrations/logs')
  @Roles('ADMIN')
  logs() {
    return this.integrations.recent();
  }

  @Post('admin/integrations/catalogue')
  @Roles('ADMIN')
  @HttpCode(200)
  publish() {
    return this.integrations.publishCatalogue();
  }
}
