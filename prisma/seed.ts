/**
 * Seed: system accounts, staff/demo users and DEMONSTRATION markets.
 *
 * Everything below is invented demo data and is labelled isDemo=true. Demo trading history is
 * produced by running real trades through the TradingService (with a back-dated clock), so
 * prices, ledgers and charts are internally consistent.
 *
 * Usage:  pnpm db:seed          (idempotent: skips if the admin already exists)
 */
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { PrismaClient, Category } from '@prisma/client';
import { AppModule } from '../src/app.module';
import { AuthService } from '../src/auth/auth.service';
import { LedgerService } from '../src/ledger/ledger.service';
import { MarketsService } from '../src/markets/markets.service';
import { TradingService } from '../src/trading/trading.service';
import { SportsService } from '../src/sports/sports.service';
import { ClockService } from '../src/common/clock.service';
import { PrismaService } from '../src/common/prisma.service';

const PASSWORD = process.env.SEED_PASSWORD ?? 'tinbit-demo-123';
const RESERVE = process.env.SEED_RESERVE ?? '5000000';
const DAY = 86400_000;

type Seed = {
  q: string; am: string; cat: Category; emoji: string; p: number; b: number; days: number; featured?: boolean; yes?: string; no?: string;
  rules: string; source: string; backup?: string; desc: string;
};

const MARKETS: Seed[] = [
  { q: 'Will Saint George win the 2026/27 Ethiopian Premier League title?', am: 'ቅዱስ ጊዮርጊስ የ2019 ዓ.ም. የኢትዮጵያ ፕሪሚየር ሊግ ዋንጫን ያሸንፋል?', cat: 'ETHIOPIAN_FOOTBALL', emoji: '🏆', p: 0.42, b: 2000, days: 200, featured: true,
    desc: 'Season-long market on the Ethiopian Premier League champion.', rules: 'Resolves YES if Saint George is officially declared 2026/27 Ethiopian Premier League champion. Any other champion resolves NO.', source: 'Ethiopian Football Federation official announcement', backup: 'Ethiopian Premier League official website' },
  { q: 'Will Ethiopia qualify for the 2027 Africa Cup of Nations?', am: 'ኢትዮጵያ ለ2027 የአፍሪካ ዋንጫ ታልፋለች?', cat: 'INTERNATIONAL_FOOTBALL', emoji: '🇪🇹', p: 0.35, b: 3000, days: 120, featured: true,
    desc: 'Will the Walias secure a place at AFCON 2027?', rules: 'Resolves YES if Ethiopia is listed by CAF as a qualified team for AFCON 2027 by the end of qualifying. Otherwise NO.', source: 'CAF official website (cafonline.com)', backup: 'Ethiopian Football Federation' },
  { q: 'Will Arsenal finish top of the 2026/27 Premier League?', am: 'አርሰናል የ2026/27 ፕሪሚየር ሊግን በአንደኛነት ያጠናቅቃል?', cat: 'PREMIER_LEAGUE', emoji: '⚽', p: 0.3, b: 3000, days: 190, featured: true,
    desc: 'English Premier League title race.', rules: 'Resolves YES if Arsenal are confirmed as Premier League champions for 2026/27. Otherwise NO.', source: 'premierleague.com final table', backup: 'BBC Sport' },
  { q: 'Will a Premier League club win the 2026/27 Champions League?', am: 'የፕሪሚየር ሊግ ክለብ የ2026/27 ቻምፒየንስ ሊግን ያሸንፋል?', cat: 'CHAMPIONS_LEAGUE', emoji: '⭐', p: 0.45, b: 2000, days: 200,
    desc: 'Will the trophy go to England?', rules: 'Resolves YES if the 2026/27 UEFA Champions League final is won by a club from the English Premier League. Otherwise NO.', source: 'uefa.com', backup: 'Reuters' },
  { q: 'Will the next Teddy Afro single pass 5 million YouTube views within 30 days of release?', am: 'የቴዲ አፍሮ ቀጣዩ ነጠላ ዜማ በ30 ቀናት ውስጥ በዩቲዩብ 5 ሚሊዮን እይታ ያልፋል?', cat: 'MUSIC', emoji: '🎵', p: 0.55, b: 1500, days: 90, featured: true,
    desc: 'A YouTube milestone market on the official channel.', rules: 'Resolves YES if the official video of the first new single released after market creation shows ≥ 5,000,000 views on the artist’s official YouTube channel 30 days after release (checked by screenshot with timestamp). If no single is released before the closing date, the market is cancelled.', source: 'Artist’s official YouTube channel view counter', backup: 'Social Blade archive' },
  { q: 'Will an Amharic song top the Ethiopian YouTube music trending chart on Enkutatash 2027?', am: 'በ2020 እንቁጣጣሽ የአማርኛ ዘፈን በኢትዮጵያ የዩቲዩብ ሙዚቃ ትሬንዲንግ አንደኛ ይሆናል?', cat: 'MUSIC', emoji: '🎶', p: 0.7, b: 1000, days: 300,
    desc: 'New-year music trends.', rules: 'Resolves YES if the #1 entry on YouTube Trending (Music, Ethiopia) at 12:00 EAT on 11 September 2027 is an Amharic-language song. Otherwise NO.', source: 'YouTube Trending — Music, Ethiopia (screenshot)', backup: 'Kworb YouTube chart archive' },
  { q: 'Will the [DEMO] "Ethiopian Voice Season 5" final be won by a contestant from Addis Ababa?', am: '[ማሳያ] የ"ኢትዮጵያን ቮይስ ምዕራፍ 5" ፍፃሜ በአዲስ አበባ ተወዳዳሪ ይሸነፋል?', cat: 'TELEVISION', emoji: '📺', p: 0.4, b: 1000, days: 60, featured: true,
    desc: 'DEMONSTRATION: an invented TV singing competition used to show manual resolution.', rules: 'Resolves YES if the winner announced on the live final broadcast is listed by the show as being from Addis Ababa. Otherwise NO. If the final is postponed beyond the closing date the market is cancelled.', source: 'Official broadcast of the final (recording)', backup: 'Show’s official social media announcement' },
  { q: 'Will the [DEMO] Ethiopian Music Awards 2027 name a female artist “Artist of the Year”?', am: '[ማሳያ] የ2027 የኢትዮጵያ ሙዚቃ ሽልማት “የአመቱ ምርጥ አርቲስት”ን ለሴት አርቲስት ይሰጣል?', cat: 'ENTERTAINMENT', emoji: '🎤', p: 0.5, b: 1000, days: 150,
    desc: 'DEMONSTRATION: invented awards show for showing manual evidence-based settlement.', rules: 'Resolves YES if the official winners list names a woman as Artist of the Year. Otherwise NO.', source: 'Official winners announcement', backup: 'Ethiopian Broadcasting Corporation report' },
  { q: 'Will the Great Ethiopian Run 2026 men’s winner finish under 28:30?', am: 'የ2026 ታላቁ ሩጫ የወንዶች አሸናፊ ከ28:30 በታች ይጨርሳል?', cat: 'CULTURE', emoji: '🏃', p: 0.5, b: 1000, days: 10,
    desc: 'The 10km road race in Addis Ababa.', rules: 'Resolves YES if the official men’s winning time is strictly below 28:30.00. Otherwise NO. If the race is cancelled, the market is cancelled.', source: 'Great Ethiopian Run official results', backup: 'World Athletics results' },
  { q: 'Will an Ethiopian athlete win the 2027 London Marathon (men or women)?', am: 'ኢትዮጵያዊ አትሌት የ2027 የለንደን ማራቶንን ያሸንፋል?', cat: 'CULTURE', emoji: '🥇', p: 0.6, b: 1500, days: 160,
    desc: 'Ethiopian distance running.', rules: 'Resolves YES if either the elite men’s or elite women’s official winner represents Ethiopia. Otherwise NO.', source: 'London Marathon official results', backup: 'World Athletics' },
  { q: 'Will a film by an Ethiopian director be selected for Cannes 2027 Official Selection?', am: 'የኢትዮጵያዊ ዳይሬክተር ፊልም በ2027 የካን ፊልም ፌስቲቫል ይመረጣል?', cat: 'ENTERTAINMENT', emoji: '🎬', p: 0.15, b: 800, days: 180,
    desc: 'Ethiopian cinema on the world stage.', rules: 'Resolves YES if the Festival de Cannes official 2027 selection (any section of the Official Selection) includes a film directed by an Ethiopian-born or Ethiopian-national director.', source: 'festival-cannes.com official selection', backup: 'Variety' },
  { q: 'Will Ethiopia win 3+ gold medals at the 2027 World Athletics Championships?', am: 'ኢትዮጵያ በ2027 የዓለም አትሌቲክስ ሻምፒዮና 3 ወይም ከዚያ በላይ ወርቅ ታገኛለች?', cat: 'OTHER', emoji: '🏅', p: 0.4, b: 1500, days: 280,
    desc: 'Medal count market.', rules: 'Resolves YES if Ethiopia’s official gold medal count at the end of the championships is 3 or more.', source: 'World Athletics medal table', backup: 'Ethiopian Athletics Federation' },
];

async function main() {
  const raw = new PrismaClient();
  if (await raw.user.findUnique({ where: { username: 'admin' } })) {
    console.log('Seed already applied (admin exists) — skipping. Use `pnpm db:reset` to start over.');
    await raw.$disconnect();
    return;
  }
  await raw.$disconnect();

  process.env.SCHEDULER = 'off';
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error', 'warn'] });
  const prisma = app.get(PrismaService);
  const auth = app.get(AuthService);
  const ledger = app.get(LedgerService);
  const markets = app.get(MarketsService);
  const trading = app.get(TradingService);
  const sports = app.get(SportsService);
  const clock = app.get(ClockService);

  // 1. Genesis: virtual capital → company liquidity reserve
  await prisma.atomic(async (tx) => {
    const equity = await ledger.account(tx, 'EQUITY');
    const reserve = await ledger.account(tx, 'COMPANY_RESERVE');
    await ledger.account(tx, 'FEE_REVENUE');
    await ledger.post(tx, { kind: 'GENESIS', memo: 'Initial virtual liquidity reserve (no real-world value)', lines: [{ accountId: equity, amount: `-${RESERVE}` }, { accountId: reserve, amount: RESERVE }] });
  });

  // 2. Users
  const mk = async (username: string, roles: ('ADMIN' | 'RESOLVER' | 'REVIEWER')[] = [], displayName?: string) => {
    const u = await auth.register(
      { email: `${username}@tinbit.test`, username, password: PASSWORD, displayName: displayName ?? username, dateOfBirth: '1995-01-01', country: 'ET', locale: 'en', acceptTerms: true },
      null,
    );
    if (roles.length) await prisma.user.update({ where: { id: u.id }, data: { roles: ['USER', ...roles] } });
    return u;
  };
  const admin = await mk('admin', ['ADMIN'], 'Tinbit Admin');
  await mk('resolver', ['RESOLVER'], 'Resolution Officer');
  await mk('reviewer', ['REVIEWER'], 'Resolution Reviewer');
  const bots = [await mk('abebe', [], 'Abebe K.'), await mk('selam', [], 'Selam T.'), await mk('dawit', [], 'Dawit M.'), await mk('hanna', [], 'Hanna G.')];
  await mk('alice', [], 'Alice (test)');
  await mk('bob', [], 'Bob (test)');

  // 3. Markets (back-dated a few days so there is price history)
  const clockAny = clock as unknown as { offsetMs: number };
  const historyDays = 6;
  clockAny.offsetMs = -historyDays * DAY;
  const created = [];
  for (const s of MARKETS) {
    const now = clock.now();
    const m = await markets.create(
      {
        question: s.q, questionAm: s.am, description: `${s.desc} Demonstration market — virtual birr only.`, category: s.cat, yesLabel: s.yes ?? 'Yes', noLabel: s.no ?? 'No',
        imageEmoji: s.emoji, featured: !!s.featured, isDemo: true, opensAt: now, closesAt: new Date(Date.now() + s.days * DAY), resolvesAt: new Date(Date.now() + (s.days + 7) * DAY),
        resolutionRules: s.rules, sourcePrimary: s.source, sourceBackup: s.backup ?? null,
        cancellationRules: 'If the event does not take place or the official source does not publish a result within 30 days of the expected resolution date, the market is cancelled and traders are refunded their net cost.',
        cancellationPolicy: 'REFUND_NET_COST', disputeHours: 24, initialProbability: s.p, liquidityB: s.b, feeBps: 100, maxTradeAmount: 50000, publish: true,
      },
      admin.id,
    );
    created.push(m);
  }

  // 4. Demo football fixtures (mock provider — clearly labelled demo)
  for (const league of ['ETH_PL', 'EPL', 'UCL'] as const) await sports.sync(league, admin.id);
  const fixtures = await prisma.fixture.findMany({ orderBy: { kickoffAt: 'asc' }, take: 6 });
  for (const f of fixtures.slice(0, 4)) created.push(...(await sports.createMarkets(f.id, ['FOOTBALL_HOME_WIN', 'FOOTBALL_OVER_2_5', 'FOOTBALL_BTTS'], admin.id)));

  // 5. Simulated trading by demo bots, spread across the last few days
  let seed = 42;
  const rand = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
  const steps = 60;
  for (let i = 0; i < steps; i++) {
    clockAny.offsetMs = -historyDays * DAY + (i / steps) * historyDays * DAY;
    for (const m of created) {
      if (rand() < 0.55) continue;
      const fresh = await prisma.market.findUniqueOrThrow({ where: { id: m.id } });
      if (fresh.status !== 'OPEN' || fresh.closesAt <= clock.now()) continue;
      const bot = bots[Math.floor(rand() * bots.length)];
      const outcome = rand() < 0.5 + (Number(fresh.initialProbability) - Number(fresh.lastYesPrice)) ? 'YES' : 'NO';
      const amount = (10 + Math.floor(rand() * 120)).toString();
      await trading
        .execute(bot.id, m.id, { side: 'BUY', outcome, mode: 'AMOUNT', value: amount, idempotencyKey: `seed-${i}-${m.id}`, maxSlippage: 1 })
        .catch(() => undefined);
    }
  }
  clockAny.offsetMs = 0;

  const count = await prisma.trade.count();
  console.log(`Seeded ${created.length} demo markets, ${count} demo trades.`);
  console.log(`Logins (password "${PASSWORD}"): admin, resolver, reviewer, alice, bob`);
  await app.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
