import { z } from 'zod';
import { DomainError } from './errors';

export function parse<T extends z.ZodType>(schema: T, data: unknown): z.infer<T> {
  const r = schema.safeParse(data);
  if (!r.success) {
    const msg = r.error.issues.map((i) => (i.path.length ? `${i.path.join('.')}: ` : '') + i.message).join('; ');
    throw new DomainError(msg, 400, 'VALIDATION');
  }
  return r.data;
}

/** Decimal string with up to `dp` places — never a JS float. */
export const decimalString = (dp: number) =>
  z
    .union([z.string(), z.number()])
    .transform((v) => String(v).trim())
    .refine((v) => new RegExp(`^\\d+(\\.\\d{1,${dp}})?$`).test(v), `must be a positive number with at most ${dp} decimals`);

export const idempotencyKey = z.string().min(8).max(100).regex(/^[A-Za-z0-9_\-:.]+$/);

/** Per-route rate limit; relaxed under automated tests (which hammer endpoints from one IP). */
export const rate = (limit: number, ttl = 60_000) => ({ default: { limit: process.env.NODE_ENV === 'test' ? limit * 1000 : limit, ttl } });
