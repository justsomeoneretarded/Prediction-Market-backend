import { Controller, Get } from '@nestjs/common';
import { Auth, CurrentUser } from '../auth/auth.guard';
import { AuthUser } from '../auth/auth.types';
import { PortfolioService } from './portfolio.service';

@Controller('portfolio')
@Auth()
export class PortfolioController {
  constructor(private readonly p: PortfolioService) {}
  @Get()
  summary(@CurrentUser() u: AuthUser) {
    return this.p.summary(u.id);
  }
  @Get('trades')
  trades(@CurrentUser() u: AuthUser) {
    return this.p.trades(u.id);
  }
  @Get('performance')
  perf(@CurrentUser() u: AuthUser) {
    return this.p.performance(u.id);
  }
}
