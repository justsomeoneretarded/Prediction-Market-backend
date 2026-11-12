import { Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { MarketsService } from '../markets/markets.service';
import { ResolutionService } from '../resolution/resolution.service';
import { SportsService } from '../sports/sports.service';
import { PortfolioService } from '../portfolio/portfolio.service';

/**
 * In-process scheduler (instead of BullMQ+Redis) — one less service to run while Tinbit is small.
 * Every job is idempotent and DB-locked, so running two API instances is still safe; move to a
 * queue when there are many instances or long-running jobs.
 */
@Injectable()
export class SchedulerService {
  private readonly log = new Logger('Scheduler');
  private running = false;
  private readonly enabled = process.env.SCHEDULER !== 'off' && process.env.NODE_ENV !== 'test';

  constructor(
    private readonly markets: MarketsService,
    private readonly resolution: ResolutionService,
    private readonly sports: SportsService,
    private readonly portfolio: PortfolioService,
  ) {}

  @Interval(15_000)
  async tick() {
    if (!this.enabled || this.running) return;
    await this.runAll().catch((e) => this.log.error(e));
  }

  @Interval(3600_000)
  async hourly() {
    if (!this.enabled) return;
    const n = await this.portfolio.snapshotActive().catch(() => 0);
    this.log.log(`portfolio snapshots: ${n}`);
  }

  async runAll() {
    this.running = true;
    try {
      const lifecycle = await this.markets.lifecycleTick();
      const autoProposed = await this.sports.autoResolve();
      const finalized = await this.resolution.finalizeDue();
      return { ...lifecycle, autoProposed, finalized };
    } finally {
      this.running = false;
    }
  }
}
