import { Module } from '@nestjs/common';
import { SchedulerService } from './scheduler.service';
import { MarketsModule } from '../markets/markets.module';
import { ResolutionModule } from '../resolution/resolution.module';
import { SportsModule } from '../sports/sports.module';

@Module({ imports: [MarketsModule, ResolutionModule, SportsModule], providers: [SchedulerService], exports: [SchedulerService] })
export class SchedulerModule {}
