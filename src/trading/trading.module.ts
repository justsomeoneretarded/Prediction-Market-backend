import { Module } from '@nestjs/common';
import { TradingService } from './trading.service';
import { TradingController } from './trading.controller';
import { MarketsModule } from '../markets/markets.module';

@Module({ imports: [MarketsModule], providers: [TradingService], controllers: [TradingController], exports: [TradingService] })
export class TradingModule {}
