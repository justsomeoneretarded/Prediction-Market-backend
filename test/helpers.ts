import { execSync } from 'child_process';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createApp } from '../src/main';
import { PrismaService } from '../src/common/prisma.service';
import { LedgerService } from '../src/ledger/ledger.service';
import { AuthService } from '../src/auth/auth.service';
import { MarketsService } from '../src/markets/markets.service';
import { TradingService } from '../src/trading/trading.service';
import { ResolutionService } from '../src/resolution/resolution.service';
import { ClockService } from '../src/common/clock.service';
import { Role } from '@prisma/client';

let migrated = false;

export interface Ctx {
  app: INestApplication;
  prisma: PrismaService;
  ledger: LedgerService;
  auth: AuthService;
  markets: MarketsService;
  trading: TradingService;
  resolution: ResolutionService;
  clock: ClockService;
}

export async function setup(): Promise<Ctx> {
  if (!migrated) {
    execSync('npx prisma migrate deploy', { env: process.env, stdio: 'ignore' });
    migrated = true;
  }
  const app = await createApp();
  await app.init();
  const ctx: Ctx = {
    app,
    prisma: app.get(PrismaService),
    ledger: app.get(LedgerService),
    auth: app.get(AuthService),
    markets: app.get(MarketsService),
    trading: app.get(TradingService),
    resolution: app.get(ResolutionService),
    clock: app.get(ClockService),
  };
  await reset(ctx);
  return ctx;
}

export async function reset(ctx: Ctx) {
  await ctx.trading.idle();
  const tables = await ctx.prisma.$queryRaw<{ tablename: string }[]>`SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename <> '_prisma_migrations'`;
  for (let i = 0; ; i++) {
    try {
      await ctx.prisma.$executeRawUnsafe(`TRUNCATE ${tables.map((t) => `"${t.tablename}"`).join(',')} RESTART IDENTITY CASCADE`);
      break;
    } catch (e) {
      if (i > 10) throw e;
      await new Promise((r) => setTimeout(r, 200)); // let stragglers from a failed test finish
    }
  }
  ctx.ledger.clearCache();
  await ctx.clock.reset();
  // genesis reserve
  await ctx.prisma.atomic(async (tx) => {
    const eq = await ctx.ledger.account(tx, 'EQUITY');
    const res = await ctx.ledger.account(tx, 'COMPANY_RESERVE');
    await ctx.ledger.account(tx, 'FEE_REVENUE');
    await ctx.ledger.post(tx, { kind: 'GENESIS', memo: 'test reserve', lines: [{ accountId: eq, amount: '-1000000' }, { accountId: res, amount: '1000000' }] });
  });
}

let n = 0;
export async function user(ctx: Ctx, roles: Role[] = [], name?: string) {
  const username = name ?? `u${Date.now().toString(36)}${n++}`;
  const u = await ctx.auth.register(
    { email: `${username}@test.local`, username, password: 'password123', dateOfBirth: '1990-05-05', country: 'ET', locale: 'en', acceptTerms: true },
    null,
  );
  if (roles.length) await ctx.prisma.user.update({ where: { id: u.id }, data: { roles: ['USER', ...roles] } });
  return u;
}

export async function market(ctx: Ctx, over: Partial<Parameters<MarketsService['create']>[0]> = {}, actorId: string | null = null) {
  const now = ctx.clock.now();
  return ctx.markets.create(
    {
      question: 'Will the test event happen before the deadline?',
      description: 'A market created by the automated test-suite.',
      category: 'OTHER', yesLabel: 'Yes', noLabel: 'No', featured: false, isDemo: true,
      opensAt: new Date(now.getTime() - 1000), closesAt: new Date(now.getTime() + 86400_000), resolvesAt: new Date(now.getTime() + 2 * 86400_000),
      resolutionRules: 'Resolves YES if the test says so.', sourcePrimary: 'The test suite', cancellationRules: 'Cancelled if the test says so.',
      cancellationPolicy: 'REFUND_NET_COST', disputeHours: 24, initialProbability: 0.5, liquidityB: 1000, feeBps: 0, maxTradeAmount: 50000, publish: true,
      ...over,
    },
    actorId,
  );
}

export async function balance(ctx: Ctx, userId: string) {
  const a = await ctx.prisma.account.findFirstOrThrow({ where: { type: 'USER_AVAILABLE', userId } });
  return a.balance.toFixed(2);
}

export async function sys(ctx: Ctx, type: 'COMPANY_RESERVE' | 'FEE_REVENUE') {
  return (await ctx.ledger.balance(ctx.prisma, await ctx.ledger.account(ctx.prisma, type))).toFixed(2);
}

export async function escrow(ctx: Ctx, marketId: string) {
  return (await ctx.ledger.balance(ctx.prisma, await ctx.ledger.account(ctx.prisma, 'MARKET_ESCROW', { marketId }))).toFixed(2);
}

let k = 0;
export const key = () => `test-${Date.now()}-${k++}`;

export function buy(ctx: Ctx, userId: string, marketId: string, outcome: 'YES' | 'NO', value: string, mode: 'AMOUNT' | 'SHARES' = 'AMOUNT') {
  return ctx.trading.execute(userId, marketId, { side: 'BUY', outcome, mode, value, idempotencyKey: key(), maxSlippage: 1 });
}
export function sell(ctx: Ctx, userId: string, marketId: string, outcome: 'YES' | 'NO', value: string, mode: 'AMOUNT' | 'SHARES' = 'SHARES') {
  return ctx.trading.execute(userId, marketId, { side: 'SELL', outcome, mode, value, idempotencyKey: key(), maxSlippage: 1 });
}

/** Resolve a market through the full workflow (propose → review → window → finalize). */
export async function resolve(ctx: Ctx, marketId: string, outcome: 'YES' | 'NO' | 'CANCELLED') {
  const resolver = await user(ctx, ['RESOLVER']);
  const reviewer = await user(ctx, ['REVIEWER']);
  const m = await ctx.prisma.market.findUniqueOrThrow({ where: { id: marketId } });
  if (m.status === 'OPEN') await ctx.markets.close(marketId, null);
  const p = await ctx.resolution.propose(marketId, { outcome, evidenceUrl: 'https://example.org/result', evidenceNotes: 'Official result' }, resolver.id);
  await ctx.resolution.review(p.id, true, 'Evidence checked', reviewer.id);
  await ctx.clock.advance(25 * 3600_000);
  return ctx.resolution.finalize(p.id, reviewer.id);
}

/** supertest agent that handles the CSRF double-submit cookie. */
export async function agent(ctx: Ctx) {
  const a = request.agent(ctx.app.getHttpServer());
  const res = await a.get('/api/auth/me');
  const cookie = ([] as string[]).concat(res.headers['set-cookie'] ?? []).find((c) => c.startsWith('tb_csrf='))!;
  const csrf = cookie.split(';')[0].split('=')[1];
  return {
    get: (url: string) => a.get(url),
    post: (url: string, body?: object) => a.post(url).set('x-csrf-token', csrf).send(body ?? {}),
    patch: (url: string, body?: object) => a.patch(url).set('x-csrf-token', csrf).send(body ?? {}),
    raw: a,
  };
}
