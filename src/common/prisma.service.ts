import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Prisma, PrismaClient } from '@prisma/client';

export type Tx = Prisma.TransactionClient;

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  async onModuleInit() {
    await this.$connect();
  }
  async onModuleDestroy() {
    await this.$disconnect();
  }

  /**
   * Run `fn` in a single atomic DB transaction. Retries on serialization failures /
   * deadlocks, so callers must make `fn` free of external side effects.
   */
  async atomic<T>(fn: (tx: Tx) => Promise<T>, opts: { retries?: number } = {}): Promise<T> {
    const retries = opts.retries ?? 4;
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.$transaction(fn, {
          isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
          timeout: 15000,
          maxWait: 10000,
        });
      } catch (e) {
        if (attempt < retries && isRetryable(e)) {
          await new Promise((r) => setTimeout(r, 20 * 2 ** attempt + Math.random() * 20));
          continue;
        }
        throw e;
      }
    }
  }
}

function isRetryable(e: unknown): boolean {
  const msg = String((e as Error)?.message ?? '');
  const code = (e as { code?: string })?.code;
  return code === 'P2034' || /40001|40P01|deadlock detected|could not serialize/i.test(msg);
}
