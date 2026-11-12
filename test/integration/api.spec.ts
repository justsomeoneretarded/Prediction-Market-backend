import { authenticator } from 'otplib';
import { Ctx, setup, reset, user, market, agent } from '../helpers';

const reg = (o: Record<string, unknown> = {}) => ({
  email: `p${Math.random().toString(36).slice(2, 8)}@test.local`, username: `p${Math.random().toString(36).slice(2, 10)}`,
  password: 'password123', dateOfBirth: '1995-03-03', country: 'ET', locale: 'am', acceptTerms: true, ...o,
});

describe('HTTP API: auth, security, RBAC, wallet', () => {
  let ctx: Ctx;
  beforeAll(async () => (ctx = await setup()));
  beforeEach(() => reset(ctx));
  afterAll(() => ctx.app.close());

  test('register → welcome balance → me → logout', async () => {
    const a = await agent(ctx);
    const r = await a.post('/api/auth/register', reg());
    expect(r.status).toBe(201);
    expect(r.body.balances.available).toBe('10000.00');
    expect(r.body.user.locale).toBe('am');
    expect((await a.get('/api/auth/me')).body.user.id).toBe(r.body.user.id);
    await a.post('/api/auth/logout');
    expect((await a.get('/api/auth/me')).body.user).toBeNull();
  });

  test('age gate, jurisdiction block, validation and duplicate accounts', async () => {
    const a = await agent(ctx);
    expect((await a.post('/api/auth/register', reg({ dateOfBirth: '2012-01-01' }))).body.error).toBe('AGE_RESTRICTED');
    process.env.BLOCKED_COUNTRIES = 'XX';
    const { config } = await import('../../src/config');
    (config() as { BLOCKED_COUNTRIES: string }).BLOCKED_COUNTRIES = 'XX';
    expect((await a.post('/api/auth/register', reg({ country: 'XX' }))).body.error).toBe('JURISDICTION_BLOCKED');
    expect((await a.post('/api/auth/register', reg({ password: 'short' }))).status).toBe(400);
    expect((await a.post('/api/auth/register', reg({ acceptTerms: false }))).status).toBe(400);
    const body = reg();
    expect((await a.post('/api/auth/register', body)).status).toBe(201);
    expect((await (await agent(ctx)).post('/api/auth/register', body)).status).toBe(409);
  });

  test('wrong password is rejected; mutating requests without CSRF token are refused', async () => {
    const a = await agent(ctx);
    const body = reg();
    await a.post('/api/auth/register', body);
    expect((await (await agent(ctx)).post('/api/auth/login', { login: body.username, password: 'nope-nope' })).status).toBe(401);
    const noCsrf = await a.raw.post('/api/auth/logout').send({});
    expect(noCsrf.status).toBe(403);
    expect(noCsrf.body.error).toBe('CSRF');
  });

  test('trade over HTTP with preview, then portfolio & transaction history', async () => {
    const m = await market(ctx, { feeBps: 100 });
    const a = await agent(ctx);
    await a.post('/api/auth/register', reg());
    const q = await a.post(`/api/markets/${m.slug}/quote`, { side: 'BUY', outcome: 'YES', value: '101' });
    expect(q.body.fee).toBe('1.00');
    expect(q.body.warnings).toEqual([]);
    const t = await a.post(`/api/markets/${m.slug}/trade`, { side: 'BUY', outcome: 'YES', value: '101', idempotencyKey: 'http-trade-0001', expectedYesPrice: q.body.yesPriceBefore });
    expect(t.status).toBe(201);
    expect(t.body.trade.shares).toBe(q.body.shares);
    const replay = await a.post(`/api/markets/${m.slug}/trade`, { side: 'BUY', outcome: 'YES', value: '101', idempotencyKey: 'http-trade-0001' });
    expect(replay.body.replayed).toBe(true);
    const p = await a.get('/api/portfolio');
    expect(p.body.openPositions).toHaveLength(1);
    expect(p.body.cash.available).toBe('9899.00');
    const tx = await a.get('/api/wallet/transactions');
    expect(tx.body.map((l: { kind: string }) => l.kind)).toEqual(['TRADE_BUY', 'SIGNUP_BONUS']);
    expect((await a.post(`/api/markets/${m.slug}/trade`, { side: 'BUY', outcome: 'YES', value: '-5', idempotencyKey: 'http-trade-0002' })).status).toBe(400);
    expect((await (await agent(ctx)).post(`/api/markets/${m.slug}/trade`, { side: 'BUY', outcome: 'YES', value: '5', idempotencyKey: 'anon-trade-0001' })).status).toBe(401);
  });

  test('role-based access control on admin endpoints', async () => {
    const pw = 'password123';
    const login = async (roles: ('ADMIN' | 'RESOLVER' | 'REVIEWER')[]) => {
      const u = await user(ctx, roles);
      const a = await agent(ctx);
      await a.post('/api/auth/login', { login: u.username, password: pw });
      return { a, u };
    };
    const plain = await login([]);
    const resolver = await login(['RESOLVER']);
    const reviewer = await login(['REVIEWER']);
    const admin = await login(['ADMIN']);
    expect((await plain.a.get('/api/admin/overview')).status).toBe(403);
    expect((await resolver.a.get('/api/admin/overview')).status).toBe(200);
    const body = { question: 'Will the RBAC test market be created?', description: 'Created in RBAC test.', category: 'OTHER', opensAt: new Date().toISOString(), closesAt: new Date(Date.now() + 864e5).toISOString(), resolvesAt: new Date(Date.now() + 2 * 864e5).toISOString(), resolutionRules: 'YES if created.', sourcePrimary: 'tests', cancellationRules: 'Never cancelled.', publish: true };
    expect((await resolver.a.post('/api/admin/markets', body)).status).toBe(403);
    const created = await admin.a.post('/api/admin/markets', body);
    expect(created.status).toBe(201);
    expect(created.body.status).toBe('OPEN');
    await admin.a.post(`/api/admin/markets/${created.body.id}/close`, {});
    expect((await reviewer.a.post(`/api/admin/markets/${created.body.id}/propose`, { outcome: 'YES', evidenceUrl: 'x://e', evidenceNotes: 'evidence' })).status).toBe(403);
    const prop = await resolver.a.post(`/api/admin/markets/${created.body.id}/propose`, { outcome: 'YES', evidenceUrl: 'x://e', evidenceNotes: 'evidence' });
    expect(prop.status).toBe(201);
    expect((await resolver.a.post(`/api/admin/proposals/${prop.body.id}/review`, { approve: true, note: 'self' })).status).toBe(403);
    expect((await reviewer.a.post(`/api/admin/proposals/${prop.body.id}/review`, { approve: true, note: 'looks good' })).status).toBe(200);
    expect((await reviewer.a.post(`/api/admin/users/${plain.u.id}/adjust`, { amount: '100', reason: 'trying to cheat here' })).status).toBe(403);
  });

  test('wallet adjustments require a reason and are audited; simulated deposit & withdrawal approval', async () => {
    const admin = await user(ctx, ['ADMIN']);
    const target = await user(ctx);
    const a = await agent(ctx);
    await a.post('/api/auth/login', { login: admin.username, password: 'password123' });
    expect((await a.post(`/api/admin/users/${target.id}/adjust`, { amount: '250.50' })).status).toBe(400);
    expect((await a.post(`/api/admin/users/${target.id}/adjust`, { amount: '250.50', reason: 'Compensation for outage #12' })).status).toBe(200);
    expect((await a.post(`/api/admin/users/${target.id}/adjust`, { amount: '-50.50', reason: 'Correction of duplicate credit' })).status).toBe(200);
    const audit = await ctx.prisma.auditLog.findMany({ where: { action: 'wallet.adjust', entityId: target.id } });
    expect(audit).toHaveLength(2);
    expect(audit[0].reason).toBe('Compensation for outage #12');

    const t = await agent(ctx);
    await t.post('/api/auth/login', { login: target.username, password: 'password123' });
    expect((await t.get('/api/wallet')).body.balances.available).toBe('10200.00');
    const dep = await t.post('/api/wallet/deposit', { amount: '500', idempotencyKey: 'dep-000001' });
    expect(dep.body.status).toBe('COMPLETED');
    expect(dep.body.simulated).toBe(true);
    await t.post('/api/wallet/deposit', { amount: '500', idempotencyKey: 'dep-000001' }); // replay
    const w = await t.post('/api/wallet/withdraw', { amount: '700', idempotencyKey: 'wd-000001' });
    expect(w.body.status).toBe('REQUIRES_APPROVAL');
    let bal = (await t.get('/api/wallet')).body.balances;
    expect(bal).toMatchObject({ available: '10000.00', reserved: '700.00' });
    expect((await a.post(`/api/admin/payments/${w.body.id}/review`, { approve: true, note: 'KYC ok' })).body.status).toBe('COMPLETED');
    bal = (await t.get('/api/wallet')).body.balances;
    expect(bal).toMatchObject({ available: '10000.00', reserved: '0.00' });
    expect((await t.post('/api/wallet/withdraw', { amount: '999999', idempotencyKey: 'wd-000002' })).status).toBe(400);
    const recon = (await a.get('/api/admin/reconciliation')).body;
    expect(recon.ok).toBe(true);
  });

  test('TOTP two-factor enrolment marks the session as verified', async () => {
    const admin = await user(ctx, ['ADMIN']);
    const a = await agent(ctx);
    await a.post('/api/auth/login', { login: admin.username, password: 'password123' });
    const setupRes = await a.post('/api/auth/2fa/setup');
    expect((await a.post('/api/auth/2fa/verify', { code: '000000' })).status).toBe(401);
    expect((await a.post('/api/auth/2fa/verify', { code: authenticator.generate(setupRes.body.secret) })).status).toBe(200);
    expect((await a.get('/api/auth/me')).body.user.twoFactorVerified).toBe(true);
  });

  test('public market endpoints', async () => {
    const m = await market(ctx);
    const a = await agent(ctx);
    expect((await a.get('/api/markets')).body).toHaveLength(1);
    const home = (await a.get('/api/markets/home')).body;
    expect(Object.keys(home)).toEqual(['featured', 'trending', 'top', 'fresh', 'closing', 'football', 'entertainment']);
    const detail = (await a.get(`/api/markets/${m.slug}`)).body;
    expect(detail.yesPrice).toBe('0.5000');
    expect(detail.liquidity.maxLossBound).toBe('693.15');
    expect((await a.get(`/api/markets/${m.slug}/history`)).body.length).toBeGreaterThan(0);
    expect((await a.get('/api/markets/does-not-exist')).status).toBe(404);
    expect((await a.get('/api/health')).body.status).toBe('ok');
  });
});
