import { FixtureStatus } from '@prisma/client';

/** Normalised fixture shape every football data adapter must return. */
export interface ProviderFixture {
  externalId: string;
  league: League;
  homeTeam: string;
  awayTeam: string;
  kickoffAt: Date;
  status: FixtureStatus;
  /** Goals at the end of REGULAR TIME (90' + stoppage). Extra time & penalties are excluded. */
  homeGoals: number | null;
  awayGoals: number | null;
}

export type League = 'ETH_PL' | 'EPL' | 'UCL' | 'INTL';
export const LEAGUES: Record<League, { name: string; category: 'ETHIOPIAN_FOOTBALL' | 'PREMIER_LEAGUE' | 'CHAMPIONS_LEAGUE' | 'INTERNATIONAL_FOOTBALL' }> = {
  ETH_PL: { name: 'Ethiopian Premier League', category: 'ETHIOPIAN_FOOTBALL' },
  EPL: { name: 'English Premier League', category: 'PREMIER_LEAGUE' },
  UCL: { name: 'UEFA Champions League', category: 'CHAMPIONS_LEAGUE' },
  INTL: { name: 'International football', category: 'INTERNATIONAL_FOOTBALL' },
};

export interface FootballProvider {
  readonly name: string;
  readonly isDemo: boolean;
  upcoming(league: League, days: number): Promise<ProviderFixture[]>;
  fixture(externalId: string): Promise<ProviderFixture | null>;
}
