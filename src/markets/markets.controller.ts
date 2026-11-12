import { Controller, Get, Param, Query } from '@nestjs/common';
import { MarketsService } from './markets.service';

@Controller('markets')
export class MarketsController {
  constructor(private readonly markets: MarketsService) {}

  @Get()
  list(
    @Query('category') category?: string,
    @Query('q') search?: string,
    @Query('sort') sort?: string,
    @Query('status') status?: string,
    @Query('limit') limit?: string,
    @Query('featured') featured?: string,
  ) {
    return this.markets.list({ category, search: search?.slice(0, 100), sort, status, limit: Number(limit) || undefined, featured: featured === 'true' });
  }

  /** Everything the homepage needs in one request. */
  @Get('home')
  async home() {
    const [featured, trending, top, fresh, closing, football, entertainment] = await Promise.all([
      this.markets.list({ featured: true, sort: 'volume', limit: 6 }),
      this.markets.list({ sort: 'trending', limit: 8 }),
      this.markets.list({ sort: 'volume', limit: 8 }),
      this.markets.list({ sort: 'new', limit: 8 }),
      this.markets.list({ sort: 'closing', limit: 8 }),
      this.markets.list({ category: 'FOOTBALL', sort: 'volume', limit: 8 }),
      this.markets.list({ category: 'ENTERTAINMENT_ALL', sort: 'volume', limit: 8 }),
    ]);
    return { featured, trending, top, fresh, closing, football, entertainment };
  }

  @Get(':id')
  get(@Param('id') id: string) {
    return this.markets.get(id);
  }

  @Get(':id/history')
  history(@Param('id') id: string, @Query('range') range = 'all') {
    return this.markets.priceHistory(id, range);
  }

  @Get(':id/trades')
  trades(@Param('id') id: string) {
    return this.markets.getRaw(id).then((m) => this.markets.recentTrades(m.id, 50));
  }
}
