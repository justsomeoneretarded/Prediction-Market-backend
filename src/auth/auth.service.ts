import { Injectable } from '@nestjs/common';
import { hash, verify } from '@node-rs/argon2';
import { createHash, randomBytes } from 'crypto';
import { authenticator } from 'otplib';
import { z } from 'zod';
import { PrismaService } from '../common/prisma.service';
import { ClockService } from '../common/clock.service';
import { AuditService } from '../common/audit.service';
import { LedgerService } from '../ledger/ledger.service';
import { DomainError } from '../common/errors';
import { blockedCountries, config } from '../config';
import { AuthUser } from './auth.types';
import { money } from '../common/money';

export const registerSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(200),
  username: z.string().trim().min(3).max(24).regex(/^[a-zA-Z0-9_]+$/, 'letters, numbers and _ only'),
  password: z.string().min(8, 'at least 8 characters').max(200),
  displayName: z.string().trim().min(1).max(60).optional(),
  dateOfBirth: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'use YYYY-MM-DD'),
  country: z.string().trim().length(2).toUpperCase(),
  locale: z.enum(['en', 'am']).default('en'),
  acceptTerms: z.literal(true, { message: 'You must accept the terms' }),
});

export const loginSchema = z.object({
  login: z.string().trim().min(1).max(200),
  password: z.string().min(1).max(200),
});

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const ARGON = { memoryCost: 19456, timeCost: 2, parallelism: 1 };

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly clock: ClockService,
    private readonly ledger: LedgerService,
    private readonly audit: AuditService,
  ) {}

  hashPassword(pw: string) {
    return hash(pw, ARGON);
  }

  async register(input: z.infer<typeof registerSchema>, ip: string | null) {
    const dob = new Date(input.dateOfBirth + 'T00:00:00Z');
    if (isNaN(dob.getTime())) throw new DomainError('Invalid date of birth');
    const age = ageOn(dob, new Date());
    if (age < config().MIN_AGE) throw new DomainError(`You must be at least ${config().MIN_AGE} years old to use Tinbit`, 403, 'AGE_RESTRICTED');
    if (blockedCountries().includes(input.country)) {
      throw new DomainError('Tinbit is not available in your country yet', 403, 'JURISDICTION_BLOCKED');
    }
    const exists = await this.prisma.user.findFirst({
      where: { OR: [{ email: input.email }, { username: { equals: input.username, mode: 'insensitive' } }] },
    });
    if (exists) throw new DomainError('That email or username is already taken', 409, 'CONFLICT');
    const passwordHash = await this.hashPassword(input.password);

    const bonus = config().SIGNUP_BONUS;
    const user = await this.prisma.atomic(async (tx) => {
      const u = await tx.user.create({
        data: {
          email: input.email,
          username: input.username,
          displayName: input.displayName || input.username,
          passwordHash,
          dateOfBirth: dob,
          country: input.country,
          locale: input.locale,
        },
      });
      const wallet = await this.ledger.account(tx, 'USER_AVAILABLE', { userId: u.id });
      if (bonus > 0) {
        const promo = await this.ledger.account(tx, 'PROMOTIONS');
        // virtual issuance from the promotions account (its negative balance = total bonuses issued)
        await this.ledger.post(tx, {
          kind: 'SIGNUP_BONUS',
          memo: `Welcome bonus (virtual birr, no cash value)`,
          referenceId: u.id,
          lines: [
            { accountId: promo, amount: money(-bonus) },
            { accountId: wallet, amount: money(bonus) },
          ],
        });
      }
      await tx.notification.create({
        data: {
          userId: u.id, type: 'WELCOME', title: 'Welcome to Tinbit',
          body: `You received ${bonus.toLocaleString()} virtual birr to start predicting. Virtual birr has no cash value.`,
        },
      });
      await this.audit.log({ actorId: u.id, action: 'user.register', entityType: 'User', entityId: u.id, ip }, tx);
      return u;
    });
    return user;
  }

  async login(login: string, password: string, meta: { ip: string | null; userAgent?: string }) {
    const user = await this.prisma.user.findFirst({
      where: { OR: [{ email: login.toLowerCase() }, { username: { equals: login, mode: 'insensitive' } }] },
    });
    // constant-ish work even when the user does not exist
    const ok = user ? await verify(user.passwordHash, password).catch(() => false) : (await this.hashPassword(password), false);
    if (!user || !ok) {
      await this.audit.log({ action: 'auth.login_failed', entityType: 'User', entityId: user?.id, ip: meta.ip, data: { login } });
      throw new DomainError('Incorrect email/username or password', 401, 'BAD_CREDENTIALS');
    }
    if (user.isSuspended) throw new DomainError('This account is suspended. Contact support.', 403, 'SUSPENDED');
    const token = randomBytes(32).toString('base64url');
    const ttl = config().SESSION_TTL_HOURS * 3600_000;
    await this.prisma.session.create({
      data: { id: sha(token), userId: user.id, expiresAt: new Date(Date.now() + ttl), ip: meta.ip, userAgent: meta.userAgent?.slice(0, 300) },
    });
    await this.prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });
    await this.audit.log({ actorId: user.id, action: 'auth.login', entityType: 'User', entityId: user.id, ip: meta.ip });
    return { token, ttl, user };
  }

  async logout(token: string | undefined) {
    if (token) await this.prisma.session.deleteMany({ where: { id: sha(token) } });
  }

  async resolveSession(token: string): Promise<AuthUser | null> {
    const s = await this.prisma.session.findUnique({ where: { id: sha(token) }, include: { user: true } });
    if (!s || s.expiresAt < new Date() || s.user.isSuspended) return null;
    return {
      id: s.user.id,
      email: s.user.email,
      username: s.user.username,
      displayName: s.user.displayName,
      roles: s.user.roles,
      locale: s.user.locale,
      totpEnabled: s.user.totpEnabled,
      sessionId: s.id,
      twoFactorVerified: s.twoFactorVerified,
    };
  }

  // ── TOTP two-factor (required for privileged roles when ADMIN_REQUIRE_2FA=true) ──
  async beginTotp(user: AuthUser) {
    const secret = authenticator.generateSecret();
    await this.prisma.user.update({ where: { id: user.id }, data: { totpSecret: secret, totpEnabled: false } });
    return { secret, otpauthUrl: authenticator.keyuri(user.email, 'Tinbit', secret) };
  }

  async verifyTotp(user: AuthUser, code: string) {
    const u = await this.prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    if (!u.totpSecret || !authenticator.verify({ token: code, secret: u.totpSecret })) {
      throw new DomainError('Invalid authentication code', 401, 'BAD_TOTP');
    }
    await this.prisma.$transaction([
      this.prisma.user.update({ where: { id: u.id }, data: { totpEnabled: true } }),
      this.prisma.session.update({ where: { id: user.sessionId }, data: { twoFactorVerified: true } }),
    ]);
    await this.audit.log({ actorId: u.id, action: 'auth.totp_verified', entityType: 'User', entityId: u.id });
    return { ok: true };
  }
}

export function ageOn(dob: Date, on: Date) {
  let age = on.getUTCFullYear() - dob.getUTCFullYear();
  const m = on.getUTCMonth() - dob.getUTCMonth();
  if (m < 0 || (m === 0 && on.getUTCDate() < dob.getUTCDate())) age--;
  return age;
}
