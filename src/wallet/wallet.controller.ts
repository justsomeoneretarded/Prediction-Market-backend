import { rate } from '../common/validate';
import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import { Throttle } from '@nestjs/throttler';
import { Auth, CurrentUser } from '../auth/auth.guard';
import { AuthUser } from '../auth/auth.types';
import { WalletService } from './wallet.service';
import { decimalString, idempotencyKey, parse } from '../common/validate';
import { DomainError } from '../common/errors';

const moneyBody = z.object({ amount: decimalString(2), idempotencyKey });

@Controller()
export class WalletController {
  constructor(private readonly wallet: WalletService) {}

  @Get('wallet')
  @Auth()
  async get(@CurrentUser() user: AuthUser) {
    return { balances: await this.wallet.balances(user.id), payments: await this.wallet.payments(user.id), provider: this.wallet.provider.name };
  }

  @Get('wallet/transactions')
  @Auth()
  tx(@CurrentUser() user: AuthUser, @Query('cursor') cursor?: string, @Query('take') take?: string) {
    return this.wallet.transactions(user.id, Number(take) || 50, cursor);
  }

  @Post('wallet/deposit')
  @Auth()
  @Throttle(rate(10))
  deposit(@CurrentUser() user: AuthUser, @Body() body: unknown) {
    const b = parse(moneyBody, body);
    return this.wallet.deposit(user.id, b.amount, b.idempotencyKey);
  }

  @Post('wallet/withdraw')
  @Auth()
  @Throttle(rate(10))
  withdraw(@CurrentUser() user: AuthUser, @Body() body: unknown) {
    const b = parse(moneyBody, body);
    return this.wallet.requestWithdrawal(user.id, b.amount, b.idempotencyKey);
  }

  /** Future: real provider confirmations land here (signature verified by the provider adapter). */
  @Post('payments/webhook/:provider')
  webhook(@Param('provider') provider: string) {
    throw new DomainError(`No webhook handler is enabled for provider "${provider}". Real-money payments are disabled.`, 404);
  }
}
