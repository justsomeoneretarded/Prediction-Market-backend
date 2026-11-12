import { rate } from '../common/validate';
import { Body, Controller, Get, HttpCode, Patch, Post, Req, Res } from '@nestjs/common';
import type { Response } from 'express';
import { z } from 'zod';
import { Throttle } from '@nestjs/throttler';
import { AuthService, loginSchema, registerSchema } from './auth.service';
import { Auth, ClientIp, CurrentUser } from './auth.guard';
import { AuthedRequest, AuthUser, SESSION_COOKIE } from './auth.types';
import { parse } from '../common/validate';
import { config } from '../config';
import { PrismaService } from '../common/prisma.service';
import { WalletService } from '../wallet/wallet.service';

@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly prisma: PrismaService,
    private readonly wallet: WalletService,
  ) {}

  @Post('register')
  @Throttle(rate(5))
  async register(@Body() body: unknown, @ClientIp() ip: string | null, @Req() req: AuthedRequest, @Res({ passthrough: true }) res: Response) {
    const input = parse(registerSchema, body);
    await this.auth.register(input, ip);
    const s = await this.auth.login(input.email, input.password, { ip, userAgent: req.headers['user-agent'] });
    this.setCookie(res, s.token, s.ttl);
    return this.me((await this.auth.resolveSession(s.token))!);
  }

  @Post('login')
  @HttpCode(200)
  @Throttle(rate(10))
  async login(@Body() body: unknown, @ClientIp() ip: string | null, @Req() req: AuthedRequest, @Res({ passthrough: true }) res: Response) {
    const input = parse(loginSchema, body);
    const s = await this.auth.login(input.login, input.password, { ip, userAgent: req.headers['user-agent'] });
    this.setCookie(res, s.token, s.ttl);
    return this.me((await this.auth.resolveSession(s.token))!);
  }

  @Post('logout')
  @HttpCode(200)
  async logout(@Req() req: AuthedRequest, @Res({ passthrough: true }) res: Response) {
    await this.auth.logout(req.cookies?.[SESSION_COOKIE]);
    res.clearCookie(SESSION_COOKIE, { path: '/' });
    return { ok: true };
  }

  @Get('me')
  async meRoute(@Req() req: AuthedRequest) {
    return req.user ? this.me(req.user) : { user: null };
  }

  @Patch('me')
  @Auth()
  async update(@CurrentUser() user: AuthUser, @Body() body: unknown) {
    const input = parse(z.object({ displayName: z.string().trim().min(1).max(60).optional(), locale: z.enum(['en', 'am']).optional() }), body);
    await this.prisma.user.update({ where: { id: user.id }, data: input });
    return this.me({ ...user, ...input });
  }

  @Post('2fa/setup')
  @Auth()
  setup2fa(@CurrentUser() user: AuthUser) {
    return this.auth.beginTotp(user);
  }

  @Post('2fa/verify')
  @HttpCode(200)
  @Throttle(rate(10))
  @Auth()
  verify2fa(@CurrentUser() user: AuthUser, @Body() body: unknown) {
    const { code } = parse(z.object({ code: z.string().regex(/^\d{6}$/) }), body);
    return this.auth.verifyTotp(user, code);
  }

  private async me(user: AuthUser) {
    const balances = await this.wallet.balances(user.id);
    const unread = await this.prisma.notification.count({ where: { userId: user.id, readAt: null } });
    return {
      user: {
        id: user.id, email: user.email, username: user.username, displayName: user.displayName,
        roles: user.roles, locale: user.locale, totpEnabled: user.totpEnabled, twoFactorVerified: user.twoFactorVerified,
      },
      balances,
      unreadNotifications: unread,
      requires2fa: config().ADMIN_REQUIRE_2FA && user.roles.some((r) => r !== 'USER') && !user.twoFactorVerified,
    };
  }

  private setCookie(res: Response, token: string, ttl: number) {
    res.cookie(SESSION_COOKIE, token, {
      httpOnly: true, sameSite: 'lax', secure: config().COOKIE_SECURE, maxAge: ttl, path: '/',
    });
  }
}
