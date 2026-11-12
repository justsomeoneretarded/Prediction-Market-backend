import { Module } from '@nestjs/common';
import { SportsService } from './sports.service';
import { MarketsModule } from '../markets/markets.module';
import { ResolutionModule } from '../resolution/resolution.module';

@Module({ imports: [MarketsModule, ResolutionModule], providers: [SportsService], exports: [SportsService] })
export class SportsModule {}
