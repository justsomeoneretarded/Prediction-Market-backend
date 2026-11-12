import { rate } from '../common/validate';
import { Body, Controller, Post, Req } from '@nestjs/common';
import { Param } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { Auth, CurrentUser } from '../auth/auth.guard';
import { AuthedRequest, AuthUser } from '../auth/auth.types';
import { parse } from '../common/validate';
import { TradingService, quoteSchema, tradeSchema } from './trading.service';

@Controller('markets/:id')
export class TradingController {
  constructor(private readonly trading: TradingService) {}

  @Post('quote')
  @Throttle(rate(120))
  quote(@Param('id') id: string, @Body() body: unknown, @Req() req: AuthedRequest) {
    return this.trading.preview(id, parse(quoteSchema, body), req.user?.id);
  }

  @Post('trade')
  @Auth()
  @Throttle(rate(30))
  trade(@Param('id') id: string, @Body() body: unknown, @CurrentUser() user: AuthUser) {
    return this.trading.execute(user.id, id, parse(tradeSchema, body));
  }
}
