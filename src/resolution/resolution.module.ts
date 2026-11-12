import { Module } from '@nestjs/common';
import { ResolutionService } from './resolution.service';
import { ResolutionController } from './resolution.controller';
import { MarketsModule } from '../markets/markets.module';

@Module({ imports: [MarketsModule], providers: [ResolutionService], controllers: [ResolutionController], exports: [ResolutionService] })
export class ResolutionModule {}
