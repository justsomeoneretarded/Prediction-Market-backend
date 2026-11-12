import { Module } from '@nestjs/common';
import { AdminService } from './admin.service';
import { AdminController } from './admin.controller';
import { MarketsModule } from '../markets/markets.module';
import { ResolutionModule } from '../resolution/resolution.module';
import { SportsModule } from '../sports/sports.module';
import { WalletModule } from '../wallet/wallet.module';
import { SchedulerModule } from '../scheduler/scheduler.module';

@Module({ imports: [MarketsModule, ResolutionModule, SportsModule, WalletModule, SchedulerModule], providers: [AdminService], controllers: [AdminController] })
export class AdminModule {}
