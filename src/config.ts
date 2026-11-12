import { z } from 'zod';

const bool = z
  .string()
  .optional()
  .transform((v) => v === 'true' || v === '1');

const schema = z.object({
  NODE_ENV: z.string().default('development'),
  PORT: z.coerce.number().default(4000),
  DATABASE_URL: z.string().min(1),
  WEB_ORIGIN: z.string().default('http://localhost:3000'),
  SESSION_TTL_HOURS: z.coerce.number().default(168),
  COOKIE_SECURE: bool,
  SIGNUP_BONUS: z.coerce.number().min(0).default(10000),
  MIN_AGE: z.coerce.number().default(18),
  BLOCKED_COUNTRIES: z.string().default(''),
  ADMIN_REQUIRE_2FA: bool,
  DEMO_MODE: bool,
  PAYMENTS_PROVIDER: z.enum(['simulated', 'disabled']).default('simulated'),
  WITHDRAWAL_APPROVAL_THRESHOLD: z.coerce.number().default(0),
  FOOTBALL_PROVIDER: z.enum(['mock', 'api-football']).default('mock'),
  API_FOOTBALL_KEY: z.string().optional(),
  API_FOOTBALL_BASE_URL: z.string().default('https://v3.football.api-sports.io'),
});

export type Config = z.infer<typeof schema>;

let cached: Config | undefined;
export function config(): Config {
  if (!cached) {
    const parsed = schema.safeParse(process.env);
    if (!parsed.success) {
      throw new Error('Invalid environment: ' + parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
    }
    cached = parsed.data;
  }
  return cached;
}
export const blockedCountries = () =>
  config().BLOCKED_COUNTRIES.split(',').map((c) => c.trim().toUpperCase()).filter(Boolean);
