import { Global, Module } from '@nestjs/common';
import { PortfolioService } from './portfolio.service';
import { PortfolioController } from './portfolio.controller';

@Global()
@Module({ providers: [PortfolioService], controllers: [PortfolioController], exports: [PortfolioService] })
export class PortfolioModule {}
