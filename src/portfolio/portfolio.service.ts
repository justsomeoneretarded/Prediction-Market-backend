import { Injectable } from '@nestjs/common';
import { Market, Position } from '@prisma/client';
import { PrismaService } from '../common/prisma.service';
import { ClockService } from '../common/clock.service';
import { D, dec } from '../lmsr/lmsr';
import { money, shares } from '../common/money';

const LIVE = ['OPEN', 'SCHEDULED', 'CLOSED', 'AWAITING_RESOLUTION', 'DISPUTED'];

@Injectable()
export class PortfolioService {
  constructor(private readonly prisma: PrismaService, private readonly clock: ClockService) {}

  /** Mark-to-market a position at the current marginal price (or the final outcome). */
  viewPositionRaw(p: Position, m: Market) {
    const yesP = m.resolvedOutcome === 'YES' ? new D(1) : m.resolvedOutcome === 'NO' ? new D(0) : dec(m.lastYesPrice);
    const y = dec(p.yesShares);
    const n = dec(p.noShares);
    const value = y.mul(yesP).plus(n.mul(new D(1).minus(yesP)));
    const cost = dec(p.yesCost).plus(p.noCost);
    return {
      marketId: m.id,
      slug: m.slug,
      question: m.question,
      questionAm: m.questionAm,
      status: m.status,
      resolvedOutcome: m.resolvedOutcome,
      yesShares: shares(y),
      noShares: shares(n),
      yesAvgPrice: y.gt(0) ? dec(p.yesCost).div(y).toFixed(4) : null,
      noAvgPrice: n.gt(0) ? dec(p.noCost).div(n).toFixed(4) : null,
      yesPrice: yesP.toFixed(4),
      costBasis: money(cost),
      value: money(value),
      unrealizedPnl: money(value.minus(cost)),
      realizedPnl: money(p.realizedPnl),
      settledPayout: p.settledPayout ? money(p.settledPayout) : null,
      payoutIfYes: money(y),
      payoutIfNo: money(n),
    };
  }

  async summary(userId: string) {
    const [accs, positions] = await Promise.all([
      this.prisma.account.findMany({ where: { userId } }),
      this.prisma.position.findMany({ where: { userId }, include: { market: true }, orderBy: { updatedAt: 'desc' } }),
    ]);
    const available = dec(accs.find((a) => a.type === 'USER_AVAILABLE')?.balance ?? 0);
    const reserved = dec(accs.find((a) => a.type === 'USER_RESERVED')?.balance ?? 0);
    const views = positions.map((p) => ({ raw: p, v: this.viewPositionRaw(p, p.market) }));
    const open = views.filter((x) => LIVE.includes(x.raw.market.status) && (dec(x.raw.yesShares).gt(0) || dec(x.raw.noShares).gt(0)));
    const closed = views.filter((x) => !open.includes(x));
    const positionsValue = open.reduce((s, x) => s.plus(x.v.value), new D(0));
    const unrealized = open.reduce((s, x) => s.plus(x.v.unrealizedPnl), new D(0));
    const realized = views.reduce((s, x) => s.plus(x.raw.realizedPnl), new D(0));
    return {
      cash: { available: money(available), reserved: money(reserved) },
      positionsValue: money(positionsValue),
      portfolioValue: money(available.plus(reserved).plus(positionsValue)),
      unrealizedPnl: money(unrealized),
      realizedPnl: money(realized),
      openPositions: open.map((x) => x.v),
      closedPositions: closed.map((x) => x.v),
    };
  }

  async trades(userId: string, take = 100) {
    const rows = await this.prisma.trade.findMany({
      where: { userId }, orderBy: { createdAt: 'desc' }, take: Math.min(take, 500),
      include: { market: { select: { slug: true, question: true } } },
    });
    return rows.map((t) => ({
      id: t.id, slug: t.market.slug, question: t.market.question, side: t.side, outcome: t.outcome,
      shares: shares(t.shares), amount: money(t.amount), fee: money(t.fee), avgPrice: dec(t.avgPrice).toFixed(4),
      total: money(t.side === 'BUY' ? dec(t.amount).plus(t.fee) : dec(t.amount).minus(t.fee)), createdAt: t.createdAt,
    }));
  }

  async snapshot(userId: string) {
    const s = await this.summary(userId);
    await this.prisma.portfolioSnapshot.create({
      data: { userId, cash: dec(s.cash.available).plus(s.cash.reserved).toFixed(2), value: s.portfolioValue, at: this.clock.now() },
    });
  }

  async performance(userId: string) {
    const rows = await this.prisma.portfolioSnapshot.findMany({ where: { userId }, orderBy: { at: 'asc' }, take: 2000, select: { value: true, at: true } });
    const step = Math.max(1, Math.ceil(rows.length / 200));
    return rows.filter((_, i) => i % step === 0 || i === rows.length - 1).map((r) => ({ t: r.at.getTime(), v: Number(money(r.value)) }));
  }

  /** Hourly job: snapshot everyone with an open position. */
  async snapshotActive() {
    const users = await this.prisma.position.findMany({
      where: { OR: [{ yesShares: { gt: 0 } }, { noShares: { gt: 0 } }] }, distinct: ['userId'], select: { userId: true }, take: 5000,
    });
    for (const u of users) await this.snapshot(u.userId);
    return users.length;
  }
}
