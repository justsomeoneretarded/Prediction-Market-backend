import { Body, Controller, Get, HttpCode, Param, Patch, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import { Role } from '@prisma/client';
import { Auth, CurrentUser } from '../auth/auth.guard';
import { AuthUser } from '../auth/auth.types';
import { parse } from '../common/validate';
import { AdminService } from './admin.service';
import { MarketsService, createMarketSchema, updateMarketSchema } from '../markets/markets.service';
import { ResolutionService } from '../resolution/resolution.service';
import { SportsService, FOOTBALL_TYPES } from '../sports/sports.service';
import { WalletService } from '../wallet/wallet.service';
import { ClockService } from '../common/clock.service';
import { SchedulerService } from '../scheduler/scheduler.service';

const reason = z.string().trim().min(5, 'please give a reason (min 5 chars)').max(500);
const signedMoney = z.string().regex(/^-?\d+(\.\d{1,2})?$/, 'signed amount with ≤ 2 decimals');

@Controller('admin')
@Auth('admin:read')
export class AdminController {
  constructor(
    private readonly admin: AdminService,
    private readonly markets: MarketsService,
    private readonly resolution: ResolutionService,
    private readonly sports: SportsService,
    private readonly wallet: WalletService,
    private readonly clock: ClockService,
    private readonly scheduler: SchedulerService,
  ) {}

  @Get('overview') overview() { return this.admin.overview(); }
  @Get('health') health() { return this.admin.health(); }
  @Get('risk') risk() { return this.admin.riskAll(); }
  @Get('reconciliation') recon() { return this.admin.reconciliation(); }
  @Get('ledger') ledger(@Query('take') take?: string) { return this.admin.ledgerEntries(Number(take) || 100); }
  @Get('trades') trades(@Query('take') take?: string) { return this.admin.trades(Number(take) || 100); }
  @Get('audit') audit(@Query('entityType') entityType?: string, @Query('entityId') entityId?: string, @Query('action') action?: string) {
    return this.admin.auditLogs({ entityType, entityId, action });
  }

  // ── markets ──
  @Get('markets') list(@Query('status') status?: string) { return this.admin.allMarkets(status); }
  @Get('markets/:id') async get(@Param('id') id: string) { return this.markets.get(id, { includeDraft: true }); }
  @Get('markets/:id/risk') mrisk(@Param('id') id: string) { return this.markets.risk(id); }

  @Post('markets') @Auth('market:manage')
  create(@Body() body: unknown, @CurrentUser() u: AuthUser) { return this.markets.create(parse(createMarketSchema, body), u.id); }

  @Patch('markets/:id') @Auth('market:manage')
  update(@Param('id') id: string, @Body() body: unknown, @CurrentUser() u: AuthUser) { return this.markets.update(id, parse(updateMarketSchema, body), u.id); }

  @Post('markets/:id/publish') @Auth('market:manage')
  publish(@Param('id') id: string, @CurrentUser() u: AuthUser) { return this.markets.getRaw(id).then((m) => this.markets.publish(m.id, u.id)); }

  @Post('markets/:id/halt') @Auth('market:manage') @HttpCode(200)
  halt(@Param('id') id: string, @Body() body: unknown, @CurrentUser() u: AuthUser) {
    const b = parse(z.object({ halted: z.boolean(), reason }), body);
    return this.markets.getRaw(id).then((m) => this.markets.setHalt(m.id, b.halted, b.reason, u.id));
  }

  @Post('markets/:id/close') @Auth('market:manage') @HttpCode(200)
  close(@Param('id') id: string, @Body() body: unknown, @CurrentUser() u: AuthUser) {
    const b = parse(z.object({ reason: reason.default('Closed by administrator') }), body ?? {});
    return this.markets.getRaw(id).then((m) => this.markets.close(m.id, u.id, b.reason));
  }

  @Post('markets/:id/cancel') @Auth('market:manage') @HttpCode(200)
  cancel(@Param('id') id: string, @Body() body: unknown, @CurrentUser() u: AuthUser) {
    const b = parse(z.object({ reason }), body);
    return this.resolution.cancelUntraded(id, b.reason, u.id).then(() => ({ ok: true }));
  }

  // ── resolution ──
  @Get('proposals') proposals(@Query('status') status?: string) { return this.resolution.listProposals(status); }

  @Post('markets/:id/propose') @Auth('market:resolve:propose')
  propose(@Param('id') id: string, @Body() body: unknown, @CurrentUser() u: AuthUser) {
    const b = parse(z.object({ outcome: z.enum(['YES', 'NO', 'CANCELLED']), evidenceUrl: z.string().trim().min(3).max(500), evidenceNotes: z.string().trim().min(5).max(4000) }), body);
    return this.resolution.propose(id, b, u.id, 'MANUAL');
  }

  @Post('proposals/:id/review') @Auth('market:resolve:review') @HttpCode(200)
  review(@Param('id') id: string, @Body() body: unknown, @CurrentUser() u: AuthUser) {
    const b = parse(z.object({ approve: z.boolean(), note: z.string().trim().min(3).max(2000) }), body);
    return this.resolution.review(id, b.approve, b.note, u.id);
  }

  @Post('proposals/:id/finalize') @Auth('market:resolve:review') @HttpCode(200)
  finalize(@Param('id') id: string, @CurrentUser() u: AuthUser) { return this.resolution.finalize(id, u.id); }

  @Post('disputes/:id/resolve') @Auth('dispute:resolve') @HttpCode(200)
  resolveDispute(@Param('id') id: string, @Body() body: unknown, @CurrentUser() u: AuthUser) {
    const b = parse(z.object({ uphold: z.boolean(), note: z.string().trim().min(3).max(2000) }), body);
    return this.resolution.resolveDispute(id, b.uphold, b.note, u.id);
  }

  // ── users & money ──
  @Get('users') users(@Query('q') q?: string) { return this.admin.users(q); }
  @Get('users/:id') user(@Param('id') id: string) { return this.admin.userDetail(id); }

  @Post('users/:id/roles') @Auth('users:manage') @HttpCode(200)
  roles(@Param('id') id: string, @Body() body: unknown, @CurrentUser() u: AuthUser) {
    const b = parse(z.object({ roles: z.array(z.enum(Role)), reason }), body);
    return this.admin.setRoles(id, b.roles, u.id, b.reason);
  }

  @Post('users/:id/suspend') @Auth('users:manage') @HttpCode(200)
  suspend(@Param('id') id: string, @Body() body: unknown, @CurrentUser() u: AuthUser) {
    const b = parse(z.object({ suspended: z.boolean(), reason }), body);
    return this.admin.setSuspended(id, b.suspended, u.id, b.reason);
  }

  @Post('users/:id/adjust') @Auth('wallet:adjust') @HttpCode(200)
  adjust(@Param('id') id: string, @Body() body: unknown, @CurrentUser() u: AuthUser) {
    const b = parse(z.object({ amount: signedMoney, reason: z.string().trim().min(10, 'reason must be at least 10 characters').max(500) }), body);
    return this.admin.adjust(id, b.amount, b.reason, u.id);
  }

  @Post('reserve/topup') @Auth('wallet:adjust') @HttpCode(200)
  topup(@Body() body: unknown, @CurrentUser() u: AuthUser) {
    const b = parse(z.object({ amount: z.string().regex(/^\d+(\.\d{1,2})?$/), reason }), body);
    return this.admin.topUpReserve(b.amount, b.reason, u.id);
  }

  @Get('payments') payments(@Query('status') status?: string) { return this.wallet.payments(undefined, status); }

  @Post('payments/:id/review') @Auth('payments:approve') @HttpCode(200)
  reviewPayment(@Param('id') id: string, @Body() body: unknown, @CurrentUser() u: AuthUser) {
    const b = parse(z.object({ approve: z.boolean(), note: z.string().trim().min(3).max(500) }), body);
    return this.wallet.reviewWithdrawal(id, u.id, b.approve, b.note).then((p) => this.wallet.view(p));
  }

  // ── sports ──
  @Get('sports') sportsInfo() { return Promise.all([this.sports.info(), this.sports.fixtures()]).then(([info, fixtures]) => ({ ...info, fixtures })); }

  @Post('sports/sync') @Auth('market:manage') @HttpCode(200)
  sync(@Body() body: unknown, @CurrentUser() u: AuthUser) {
    const b = parse(z.object({ league: z.enum(['ETH_PL', 'EPL', 'UCL', 'INTL']) }), body);
    return this.sports.sync(b.league, u.id);
  }

  @Post('sports/fixtures/:id/markets') @Auth('market:manage')
  fixtureMarkets(@Param('id') id: string, @Body() body: unknown, @CurrentUser() u: AuthUser) {
    const b = parse(z.object({ types: z.array(z.enum(FOOTBALL_TYPES as [string, ...string[]])).min(1).default([...FOOTBALL_TYPES]), liquidityB: z.number().min(10).optional() }), body ?? {});
    return this.sports.createMarkets(id, b.types as typeof FOOTBALL_TYPES, u.id, { liquidityB: b.liquidityB });
  }

  @Post('sports/fixtures/:id/demo-result') @Auth('market:manage') @HttpCode(200)
  demoResult(@Param('id') id: string, @Body() body: unknown, @CurrentUser() u: AuthUser) {
    const b = parse(z.object({ status: z.enum(['SCHEDULED', 'LIVE', 'FINISHED', 'POSTPONED', 'CANCELLED', 'ABANDONED']), homeGoals: z.number().int().min(0).max(50).nullable().optional(), awayGoals: z.number().int().min(0).max(50).nullable().optional() }), body);
    return this.sports.setDemoResult(id, b, u.id);
  }

  // ── demo clock & jobs ──
  @Get('clock') getClock() { return { now: this.clock.now(), offsetMs: this.clock.offset }; }

  @Post('clock/advance') @Auth('system:clock') @HttpCode(200)
  async advance(@Body() body: unknown) {
    const b = parse(z.object({ hours: z.number().min(0).max(24 * 365) }), body);
    await this.clock.advance(b.hours * 3600_000);
    const jobs = await this.scheduler.runAll();
    return { now: this.clock.now(), offsetMs: this.clock.offset, jobs };
  }

  @Post('clock/reset') @Auth('system:clock') @HttpCode(200)
  async resetClock() { await this.clock.reset(); return { now: this.clock.now() }; }

  @Post('jobs/run') @Auth('market:manage') @HttpCode(200)
  run() { return this.scheduler.runAll(); }
}
