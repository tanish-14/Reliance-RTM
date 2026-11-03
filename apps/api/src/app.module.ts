import { INestApplication, Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, NestFactory } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';
import { LoggerModule, Logger } from 'nestjs-pino';
import { randomUUID } from 'node:crypto';
import { PrismaService } from './prisma.service';
import { ErrorFilter } from './common/errors';
import { JwtAuthGuard, RolesGuard } from './common/auth';
import { installBigIntJson } from './common/json';
import { AuditService } from './core/audit.service';
import { LedgerService } from './core/ledger.service';
import { SequenceService } from './core/sequence.service';
import { ScopeService } from './core/scope.service';
import { ReviewService } from './core/review.service';
import { AuthService } from './auth/auth.service';
import { PricingService } from './orders/pricing.service';
import { CreditService } from './orders/credit.service';
import { OrderStateService } from './orders/order-state.service';
import { FulfilmentService } from './orders/fulfilment.service';
import { OrdersService } from './orders/orders.service';
import { AttendanceService } from './field/attendance.service';
import { CollectionsService } from './field/collections.service';
import { ReturnsService } from './field/returns.service';
import { SyncService } from './sync/sync.service';
import { MastersService } from './sync/masters.service';
import { ReportsService } from './reports/reports.service';
import {
  AuthController,
  DistributionController,
  HealthController,
  HqController,
  OrdersController,
  SyncController,
} from './controllers';

const secret = process.env.JWT_SECRET;
if (!secret || secret.length < 16) throw new Error('JWT_SECRET must be set (16+ chars) — see .env.example');

@Module({
  imports: [
    LoggerModule.forRoot({
      pinoHttp: {
        level: process.env.LOG_LEVEL ?? 'info',
        genReqId: (req) => (req.headers['x-request-id'] as string) ?? randomUUID(),
        redact: ['req.headers.authorization', 'req.body.password'],
        transport: process.env.NODE_ENV === 'production' || process.env.LOG_PRETTY === '0' ? undefined : { target: 'pino-pretty', options: { singleLine: true } },
        autoLogging: { ignore: (req) => req.url === '/api/health' },
      },
    }),
    JwtModule.register({ global: true, secret, signOptions: { expiresIn: (process.env.JWT_TTL ?? '12h') as any } }),
  ],
  controllers: [HealthController, AuthController, SyncController, OrdersController, DistributionController, HqController],
  providers: [
    PrismaService,
    AuditService,
    LedgerService,
    SequenceService,
    ScopeService,
    ReviewService,
    AuthService,
    PricingService,
    CreditService,
    OrderStateService,
    FulfilmentService,
    OrdersService,
    AttendanceService,
    CollectionsService,
    ReturnsService,
    SyncService,
    MastersService,
    ReportsService,
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
    { provide: APP_FILTER, useClass: ErrorFilter },
  ],
})
export class AppModule {}

export async function createApp(): Promise<INestApplication> {
  installBigIntJson();
  const app = await NestFactory.create(AppModule, { bufferLogs: true });
  app.useLogger(app.get(Logger));
  app.setGlobalPrefix('api');
  app.enableCors({ origin: process.env.CORS_ORIGIN?.split(',') ?? true });
  app.enableShutdownHooks();
  return app;
}
