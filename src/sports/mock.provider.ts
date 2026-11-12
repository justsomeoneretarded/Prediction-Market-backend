import { FootballProvider, League, ProviderFixture } from './provider';

/**
 * DEMONSTRATION DATA ONLY. These fixtures are invented and are not real scheduled matches.
 * Results are set by an administrator in demo mode (Admin → Sports → "Set demo result").
 */
const TEAMS: Record<League, string[]> = {
  ETH_PL: ['Saint George', 'Fasil Kenema', 'Ethiopia Bunna', 'Mekelle 70 Enderta', 'Hawassa City', 'Bahir Dar Kenema', 'Wolkite City', 'Adama City'],
  EPL: ['Arsenal', 'Liverpool', 'Manchester City', 'Chelsea', 'Manchester United', 'Tottenham', 'Newcastle', 'Aston Villa'],
  UCL: ['Real Madrid', 'Bayern Munich', 'Barcelona', 'Inter', 'PSG', 'Arsenal', 'Liverpool', 'Manchester City'],
  INTL: ['Ethiopia', 'Egypt', 'Nigeria', 'Kenya', 'Morocco', 'Senegal', 'Ghana', 'Uganda'],
};

export class MockFootballProvider implements FootballProvider {
  readonly name = 'mock';
  readonly isDemo = true;

  async upcoming(league: League, days: number): Promise<ProviderFixture[]> {
    const teams = TEAMS[league];
    const out: ProviderFixture[] = [];
    const base = new Date();
    base.setUTCHours(0, 0, 0, 0);
    // deterministic pairings per day so repeated syncs don't duplicate fixtures
    for (let d = 1; d <= Math.min(days, 14); d += 3) {
      const day = new Date(base.getTime() + d * 86400_000);
      const seed = (day.getUTCDate() + league.length) % teams.length;
      const home = teams[seed];
      const away = teams[(seed + 3) % teams.length];
      const kickoff = new Date(day.getTime() + (league === 'ETH_PL' ? 13 : 17) * 3600_000);
      out.push({
        externalId: `demo-${league}-${day.toISOString().slice(0, 10)}`,
        league, homeTeam: home, awayTeam: away, kickoffAt: kickoff, status: 'SCHEDULED', homeGoals: null, awayGoals: null,
      });
    }
    return out;
  }

  /** The mock provider has no remote state; the DB row (edited by admins in demo mode) is the source. */
  async fixture(): Promise<ProviderFixture | null> {
    return null;
  }
}
