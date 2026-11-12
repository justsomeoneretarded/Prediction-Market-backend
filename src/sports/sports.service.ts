import { Injectable, Logger } from '@nestjs/common';
import { Fixture, FixtureStatus, FinalOutcome, MarketType } from '@prisma/client';
import { PrismaService } from '../common/prisma.service';
import { ClockService } from '../common/clock.service';
import { AuditService } from '../common/audit.service';
import { MarketsService } from '../markets/markets.service';
import { ResolutionService } from '../resolution/resolution.service';
import { DomainError, notFound } from '../common/errors';
import { config } from '../config';
import { FootballProvider, LEAGUES, League } from './provider';
import { MockFootballProvider } from './mock.provider';
import { ApiFootballProvider } from './api-football.provider';

export const FOOTBALL_TYPES: Exclude<MarketType, 'BINARY'>[] = ['FOOTBALL_HOME_WIN', 'FOOTBALL_AWAY_WIN', 'FOOTBALL_OVER_2_5', 'FOOTBALL_BTTS'];
const POSTPONEMENT_GRACE_HOURS = 48;

const REGULAR_TIME =
  'Only the result at the end of regular time counts: 90 minutes plus referee-added stoppage time. Extra time and penalty shoot-outs are NOT included.';

function template(type: Exclude<MarketType, 'BINARY'>, f: Fixture) {
  const t = {
    FOOTBALL_HOME_WIN: { q: `Will ${f.homeTeam} beat ${f.awayTeam}?`, yes: `${f.homeTeam} wins`, rule: `Resolves YES if ${f.homeTeam} scores more goals than ${f.awayTeam}. A draw or an ${f.awayTeam} win resolves NO.` },
    FOOTBALL_AWAY_WIN: { q: `Will ${f.awayTeam} win away at ${f.homeTeam}?`, yes: `${f.awayTeam} wins`, rule: `Resolves YES if ${f.awayTeam} scores more goals than ${f.homeTeam}. A draw or a ${f.homeTeam} win resolves NO.` },
    FOOTBALL_OVER_2_5: { q: `${f.homeTeam} vs ${f.awayTeam}: over 2.5 goals?`, yes: '3+ goals', rule: 'Resolves YES if the two teams score 3 or more goals in total. 0–2 total goals resolves NO.' },
    FOOTBALL_BTTS: { q: `${f.homeTeam} vs ${f.awayTeam}: will both teams score?`, yes: 'Both score', rule: `Resolves YES if ${f.homeTeam} and ${f.awayTeam} each score at least one goal. Own goals count for the team credited.` },
  }[type];
  return t;
}

export function footballOutcome(type: MarketType, home: number, away: number): FinalOutcome {
  switch (type) {
    case 'FOOTBALL_HOME_WIN': return home > away ? 'YES' : 'NO';
    case 'FOOTBALL_AWAY_WIN': return away > home ? 'YES' : 'NO';
    case 'FOOTBALL_OVER_2_5': return home + away >= 3 ? 'YES' : 'NO';
    case 'FOOTBALL_BTTS': return home > 0 && away > 0 ? 'YES' : 'NO';
    default: throw new Error(`not a football market: ${type}`);
  }
}

@Injectable()
export class SportsService {
  private readonly log = new Logger('Sports');
  readonly provider: FootballProvider =
    config().FOOTBALL_PROVIDER === 'api-football'
      ? new ApiFootballProvider(config().API_FOOTBALL_KEY ?? '', config().API_FOOTBALL_BASE_URL)
      : new MockFootballProvider();

  constructor(
    private readonly prisma: PrismaService,
    private readonly clock: ClockService,
    private readonly audit: AuditService,
    private readonly markets: MarketsService,
    private readonly resolution: ResolutionService,
  ) {}

  info() {
    return { provider: this.provider.name, isDemo: this.provider.isDemo, leagues: LEAGUES, configured: config().FOOTBALL_PROVIDER };
  }

  fixtures() {
    return this.prisma.fixture.findMany({ orderBy: { kickoffAt: 'asc' }, take: 200, include: { markets: { select: { id: true, slug: true, type: true, status: true } } } });
  }

  async sync(league: League, actorId: string | null) {
    if (!LEAGUES[league]) throw new DomainError('Unknown league');
    const rows = await this.provider.upcoming(league, 14);
    for (const r of rows) {
      const f = await this.prisma.fixture.upsert({
        where: { provider_externalId: { provider: this.provider.name, externalId: r.externalId } },
        create: { ...r, provider: this.provider.name, isDemo: this.provider.isDemo, lastSyncedAt: new Date() },
        update: { kickoffAt: r.kickoffAt, status: r.status, homeGoals: r.homeGoals, awayGoals: r.awayGoals, lastSyncedAt: new Date() },
      });
      await this.enforceKickoffClose(f);
    }
    await this.audit.log({ actorId, action: 'sports.sync', entityType: 'Fixture', data: { league, count: rows.length, provider: this.provider.name } });
    return { synced: rows.length, provider: this.provider.name, isDemo: this.provider.isDemo };
  }

  /** Create the standard football markets for a fixture. Trading closes at kickoff (no in-play). */
  async createMarkets(fixtureId: string, types: Exclude<MarketType, 'BINARY'>[], actorId: string, opts: { liquidityB?: number; publish?: boolean } = {}) {
    const f = await this.prisma.fixture.findUnique({ where: { id: fixtureId }, include: { markets: true } });
    if (!f) throw notFound('Fixture');
    const now = this.clock.now();
    if (f.kickoffAt <= now) throw new DomainError('Kickoff has passed — in-play markets are not supported');
    const created = [];
    for (const type of types) {
      if (f.markets.some((m) => m.type === type)) continue;
      const t = template(type, f);
      const demo = f.isDemo ? ' [DEMO FIXTURE — invented for demonstration, not a real scheduled match]' : '';
      created.push(
        await this.markets.create(
          {
            question: t.q,
            description: `${LEAGUES[f.league as League]?.name ?? f.league}: ${f.homeTeam} vs ${f.awayTeam}, kickoff ${f.kickoffAt.toUTCString()}.${demo}`,
            category: LEAGUES[f.league as League]?.category ?? 'INTERNATIONAL_FOOTBALL',
            yesLabel: t.yes,
            noLabel: 'No',
            imageEmoji: '⚽',
            featured: false,
            isDemo: f.isDemo,
            opensAt: now,
            closesAt: f.kickoffAt,
            resolvesAt: new Date(f.kickoffAt.getTime() + 4 * 3600_000),
            resolutionRules: `${t.rule} ${REGULAR_TIME}`,
            sourcePrimary: f.isDemo ? 'Demo result entered by Tinbit administrators (demonstration only)' : `${this.provider.name} official match data`,
            sourceBackup: 'Official league / federation match report',
            cancellationRules: `If the match is cancelled or abandoned, or postponed by more than ${POSTPONEMENT_GRACE_HOURS} hours, the market is cancelled and traders are refunded their net cost. If an abandoned match result is officially awarded, reviewers may resolve using the awarded result.`,
            cancellationPolicy: 'REFUND_NET_COST',
            disputeHours: 24,
            initialProbability: type === 'FOOTBALL_HOME_WIN' ? 0.45 : type === 'FOOTBALL_AWAY_WIN' ? 0.3 : 0.5,
            liquidityB: opts.liquidityB ?? 1000,
            feeBps: 100,
            maxTradeAmount: 50_000,
            publish: opts.publish ?? true,
          },
          actorId,
          { type, fixtureId: f.id },
        ),
      );
    }
    return created;
  }

  /** Demo mode: an admin plays the role of the data provider. */
  async setDemoResult(fixtureId: string, input: { status: FixtureStatus; homeGoals?: number | null; awayGoals?: number | null; kickoffAt?: Date }, actorId: string) {
    if (!config().DEMO_MODE) throw new DomainError('Demo results can only be set in demo mode', 403);
    const f0 = await this.prisma.fixture.findUnique({ where: { id: fixtureId } });
    if (!f0) throw notFound('Fixture');
    if (!f0.isDemo) throw new DomainError('Only demonstration fixtures can be edited by hand', 403);
    const f = await this.prisma.fixture.update({
      where: { id: fixtureId },
      data: { status: input.status, homeGoals: input.homeGoals ?? null, awayGoals: input.awayGoals ?? null, ...(input.kickoffAt ? { kickoffAt: input.kickoffAt } : {}) },
    });
    await this.audit.log({ actorId, action: 'sports.demo_result', entityType: 'Fixture', entityId: f.id, data: input });
    await this.enforceKickoffClose(f);
    return f;
  }

  /** If kickoff moves earlier, pull market closing time forward so nobody trades in-play. */
  private async enforceKickoffClose(f: Fixture) {
    await this.prisma.market.updateMany({ where: { fixtureId: f.id, status: { in: ['OPEN', 'SCHEDULED'] }, closesAt: { gt: f.kickoffAt } }, data: { closesAt: f.kickoffAt } });
    if (['LIVE', 'FINISHED', 'CANCELLED', 'ABANDONED'].includes(f.status)) {
      const open = await this.prisma.market.findMany({ where: { fixtureId: f.id, status: { in: ['OPEN', 'SCHEDULED'] } } });
      for (const m of open) await this.markets.close(m.id, null, `Fixture status ${f.status}`).catch(() => undefined);
    }
  }

  /**
   * Automated resolution for football markets:
   *  1. wait for trading to be closed and the fixture to finish
   *  2. pull the final status/result from the provider
   *  3. FINISHED with a regular-time score → AUTOMATED proposal, auto-confirmed (dispute window starts)
   *  4. CANCELLED / ABANDONED / long POSTPONED / inconsistent data → proposal that REQUIRES human review
   */
  async autoResolve() {
    const now = this.clock.now();
    const markets = await this.prisma.market.findMany({
      where: { type: { not: 'BINARY' }, status: { in: ['CLOSED', 'AWAITING_RESOLUTION'] }, fixtureId: { not: null } },
      include: { fixture: true, proposals: { where: { status: { in: ['PENDING_REVIEW', 'CONFIRMED', 'DISPUTED'] } } } },
    });
    let proposed = 0;
    for (const m of markets) {
      if (m.proposals.length || !m.fixture) continue;
      let f = m.fixture;
      if (!this.provider.isDemo) {
        try {
          const remote = await this.provider.fixture(f.externalId);
          if (remote) f = await this.prisma.fixture.update({ where: { id: f.id }, data: { status: remote.status, homeGoals: remote.homeGoals, awayGoals: remote.awayGoals, kickoffAt: remote.kickoffAt, lastSyncedAt: new Date() } });
        } catch (e) {
          this.log.warn(`provider fetch failed for ${f.externalId}: ${(e as Error).message}`);
          continue;
        }
      }
      const evidenceUrl = f.isDemo ? `demo://fixtures/${f.id}` : `${this.provider.name}://fixtures/${f.externalId}`;
      const score = `${f.homeTeam} ${f.homeGoals ?? '?'}–${f.awayGoals ?? '?'} ${f.awayTeam}`;
      try {
        if (f.status === 'FINISHED') {
          if (f.homeGoals == null || f.awayGoals == null || f.homeGoals < 0 || f.awayGoals < 0) {
            await this.resolution.propose(m.id, { outcome: 'CANCELLED', evidenceUrl, evidenceNotes: `Provider reports FINISHED but no valid regular-time score (${score}). Needs manual review — reviewer should reject this and propose the correct result from the backup source.` }, null, 'AUTOMATED', false);
          } else {
            const outcome = footballOutcome(m.type, f.homeGoals, f.awayGoals);
            await this.resolution.propose(m.id, { outcome, evidenceUrl, evidenceNotes: `Final regular-time score: ${score}. Rule applied: ${m.type}.` }, null, 'AUTOMATED', true);
          }
          proposed++;
        } else if (f.status === 'CANCELLED' || f.status === 'ABANDONED') {
          await this.resolution.propose(m.id, { outcome: 'CANCELLED', evidenceUrl, evidenceNotes: `Match ${f.status.toLowerCase()} (${score}). Cancellation per market rules — requires reviewer confirmation.` }, null, 'AUTOMATED', false);
          proposed++;
        } else if (f.status === 'POSTPONED' && now.getTime() - f.kickoffAt.getTime() > POSTPONEMENT_GRACE_HOURS * 3600_000) {
          await this.resolution.propose(m.id, { outcome: 'CANCELLED', evidenceUrl, evidenceNotes: `Match postponed more than ${POSTPONEMENT_GRACE_HOURS}h. Cancellation per market rules — requires reviewer confirmation.` }, null, 'AUTOMATED', false);
          proposed++;
        }
      } catch (e) {
        this.log.warn(`auto-resolve ${m.id}: ${(e as Error).message}`);
      }
    }
    return proposed;
  }
}
