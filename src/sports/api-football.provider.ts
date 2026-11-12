import { FixtureStatus } from '@prisma/client';
import { FootballProvider, League, ProviderFixture } from './provider';

/**
 * Adapter for API-Football (api-sports.io). Requires API_FOOTBALL_KEY.
 * NOT exercised in CI (no credentials). League ids should be confirmed against the
 * provider's /leagues endpoint before going live — especially the Ethiopian Premier League.
 */
const LEAGUE_IDS: Record<League, number> = { EPL: 39, UCL: 2, ETH_PL: 363, INTL: 10 };

const STATUS: Record<string, FixtureStatus> = {
  TBD: 'SCHEDULED', NS: 'SCHEDULED', '1H': 'LIVE', HT: 'LIVE', '2H': 'LIVE', ET: 'LIVE', BT: 'LIVE', P: 'LIVE', LIVE: 'LIVE', INT: 'LIVE',
  FT: 'FINISHED', AET: 'FINISHED', PEN: 'FINISHED', PST: 'POSTPONED', CANC: 'CANCELLED', ABD: 'ABANDONED', SUSP: 'POSTPONED', AWD: 'FINISHED', WO: 'FINISHED',
};

interface ApiFixture {
  fixture: { id: number; date: string; status: { short: string } };
  teams: { home: { name: string }; away: { name: string } };
  score: { fulltime: { home: number | null; away: number | null } };
  league: { id: number };
}

export class ApiFootballProvider implements FootballProvider {
  readonly name = 'api-football';
  readonly isDemo = false;
  constructor(private readonly key: string, private readonly baseUrl: string) {
    if (!key) throw new Error('API_FOOTBALL_KEY is required for the api-football provider');
  }

  private async get(path: string): Promise<ApiFixture[]> {
    const res = await fetch(`${this.baseUrl}${path}`, { headers: { 'x-apisports-key': this.key }, signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new Error(`api-football ${res.status}`);
    const body = (await res.json()) as { response: ApiFixture[]; errors?: unknown };
    return body.response ?? [];
  }

  private map(f: ApiFixture, league: League): ProviderFixture {
    // score.fulltime = result after 90' (+ stoppage); extra time and penalties are reported separately
    return {
      externalId: String(f.fixture.id), league, homeTeam: f.teams.home.name, awayTeam: f.teams.away.name,
      kickoffAt: new Date(f.fixture.date), status: STATUS[f.fixture.status.short] ?? 'SCHEDULED',
      homeGoals: f.score.fulltime.home, awayGoals: f.score.fulltime.away,
    };
  }

  async upcoming(league: League, days: number) {
    const from = new Date().toISOString().slice(0, 10);
    const to = new Date(Date.now() + days * 86400_000).toISOString().slice(0, 10);
    const season = new Date().getUTCMonth() >= 6 ? new Date().getUTCFullYear() : new Date().getUTCFullYear() - 1;
    const rows = await this.get(`/fixtures?league=${LEAGUE_IDS[league]}&season=${season}&from=${from}&to=${to}`);
    return rows.map((r) => this.map(r, league));
  }

  async fixture(externalId: string) {
    const rows = await this.get(`/fixtures?id=${encodeURIComponent(externalId)}`);
    const league = (Object.entries(LEAGUE_IDS).find(([, id]) => id === rows[0]?.league.id)?.[0] ?? 'INTL') as League;
    return rows[0] ? this.map(rows[0], league) : null;
  }
}
