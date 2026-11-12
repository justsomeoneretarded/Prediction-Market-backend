import { Controller, Get, Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ScheduleModule } from '@nestjs/schedule';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { CommonModule } from './common/common.module';
import { LedgerModule } from './ledger/ledger.module';
import { AuthModule } from './auth/auth.module';
import { RealtimeModule } from './realtime/realtime.module';
import { NotificationsModule } from './notifications/notifications.module';
import { WalletModule } from './wallet/wallet.module';
import { MarketsModule } from './markets/markets.module';
import { PortfolioModule } from './portfolio/portfolio.module';
import { TradingModule } from './trading/trading.module';
import { ResolutionModule } from './resolution/resolution.module';
import { SportsModule } from './sports/sports.module';
import { SchedulerModule } from './scheduler/scheduler.module';
import { AdminModule } from './admin/admin.module';
import { PrismaService } from './common/prisma.service';
import { config } from './config';

@Controller()
class HealthController {
  constructor(private readonly prisma: PrismaService) {}
  /** Liveness + DB readiness (used by Docker health checks). */
  @Get('health')
  async health() {
    await this.prisma.$queryRaw`SELECT 1`;
    return { status: 'ok', demoMode: config().DEMO_MODE, realMoney: false, time: new Date() };
  }
}

@Module({
  imports: [
    ScheduleModule.forRoot(),
    ThrottlerModule.forRoot([{ name: 'default', ttl: 60_000, limit: process.env.NODE_ENV === 'test' ? 100_000 : 300 }]),
    CommonModule,
    LedgerModule,
    NotificationsModule,
    RealtimeModule,
    AuthModule,
    WalletModule,
    PortfolioModule,
    MarketsModule,
    TradingModule,
    ResolutionModule,
    SportsModule,
    SchedulerModule,
    AdminModule,
  ],
  controllers: [HealthController],
  providers: [{ provide: APP_GUARD, useClass: ThrottlerGuard }],
})
export class AppModule {}
