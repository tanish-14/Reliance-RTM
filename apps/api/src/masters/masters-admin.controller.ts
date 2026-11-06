import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { z } from 'zod';
import {
  BeatInput,
  ChannelInput,
  DistributorInput,
  IMPORT_ENTITIES,
  ImportRequest,
  MarginRuleInput,
  OutletInput,
  PriceListInput,
  PriceRevisionInput,
  ProductInput,
  RtmModelInput,
  UserInput,
  type ImportEntity,
} from '@rtm/shared';
import { PrismaService } from '../prisma.service';
import { CurrentUser, Roles, type AuthUser } from '../common/auth';
import { ZodPipe } from '../common/zod.pipe';
import { DomainError, notFound } from '../common/errors';
import { MastersAdminService } from './masters-admin.service';

@Controller('admin')
@Roles('ADMIN')
export class MastersAdminController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly svc: MastersAdminService,
  ) {}

  @Post('products')
  product(@CurrentUser() u: AuthUser, @Body(new ZodPipe(ProductInput)) b: z.infer<typeof ProductInput>) {
    return this.prisma.tx((tx) => this.svc.upsertProduct(tx, u, b));
  }

  @Post('distributors')
  distributor(@CurrentUser() u: AuthUser, @Body(new ZodPipe(DistributorInput)) b: z.infer<typeof DistributorInput>) {
    return this.prisma.tx((tx) => this.svc.upsertDistributor(tx, u, b));
  }

  @Post('outlets')
  outlet(@CurrentUser() u: AuthUser, @Body(new ZodPipe(OutletInput)) b: z.infer<typeof OutletInput>) {
    return this.prisma.tx((tx) => this.svc.upsertOutlet(tx, u, b));
  }

  @Post('users')
  user(@CurrentUser() u: AuthUser, @Body(new ZodPipe(UserInput)) b: z.infer<typeof UserInput>) {
    return this.prisma.tx((tx) => this.svc.upsertUser(tx, u, b));
  }

  @Post('beats')
  beat(@CurrentUser() u: AuthUser, @Body(new ZodPipe(BeatInput)) b: z.infer<typeof BeatInput>) {
    return this.prisma.tx((tx) => this.svc.upsertBeat(tx, u, b));
  }

  @Post('channels')
  channel(@CurrentUser() u: AuthUser, @Body(new ZodPipe(ChannelInput)) b: z.infer<typeof ChannelInput>) {
    return this.prisma.tx((tx) => this.svc.upsertChannel(tx, u, b));
  }

  @Post('rtm-models')
  rtmModel(@CurrentUser() u: AuthUser, @Body(new ZodPipe(RtmModelInput)) b: z.infer<typeof RtmModelInput>) {
    return this.prisma.tx((tx) => this.svc.upsertRtmModel(tx, u, b));
  }

  @Post('margin-rules')
  margin(@CurrentUser() u: AuthUser, @Body(new ZodPipe(MarginRuleInput)) b: z.infer<typeof MarginRuleInput>) {
    return this.prisma.tx((tx) => this.svc.createMarginRule(tx, u, b));
  }

  @Post('margin-rules/:id/end')
  endMargin(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    return this.prisma.tx((tx) => this.svc.endMarginRule(tx, u, id, new Date()));
  }

  @Post('price-lists')
  priceList(@CurrentUser() u: AuthUser, @Body(new ZodPipe(PriceListInput)) b: z.infer<typeof PriceListInput>) {
    return this.prisma.tx((tx) => this.svc.createPriceList(tx, u, b));
  }

  @Get('price-lists/:id')
  async priceListDetail(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    const l = await this.prisma.priceList.findFirst({ where: { id, tenantId: u.tenantId }, include: { items: { include: { product: { select: { code: true, name: true } } } } } });
    if (!l) throw notFound('Price list');
    return l;
  }

  @Post('price-lists/:id/revise')
  revise(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body(new ZodPipe(PriceRevisionInput)) b: z.infer<typeof PriceRevisionInput>) {
    return this.prisma.tx((tx) => this.svc.revisePriceList(tx, u, id, b));
  }

  @Post('import/:entity')
  import(@CurrentUser() u: AuthUser, @Param('entity') entity: string, @Body(new ZodPipe(ImportRequest)) b: z.infer<typeof ImportRequest>) {
    if (!(IMPORT_ENTITIES as readonly string[]).includes(entity)) throw new DomainError('VALIDATION', `Import supports ${IMPORT_ENTITIES.join(', ')}`, 400);
    return this.svc.import(u, entity as ImportEntity, b);
  }

  @Get('imports')
  imports(@CurrentUser() u: AuthUser) {
    return this.prisma.importJob.findMany({ where: { tenantId: u.tenantId }, orderBy: { createdAt: 'desc' }, take: 20 });
  }
}
