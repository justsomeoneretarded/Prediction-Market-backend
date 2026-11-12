import { Injectable, OnModuleInit } from '@nestjs/common';
import { PrismaService } from './prisma.service';
import { config } from '../config';
import { DomainError } from './errors';

/**
 * Single source of "now" for business rules (market open/close, dispute windows).
 * In DEMO_MODE an admin can shift it forward to simulate the passage of time.
 */
@Injectable()
export class ClockService implements OnModuleInit {
  private offsetMs = 0;
  constructor(private readonly prisma: PrismaService) {}

  async onModuleInit() {
    await this.reload();
  }
  async reload() {
    const s = await this.prisma.systemSetting.findUnique({ where: { key: 'clockOffsetMs' } });
    this.offsetMs = s && config().DEMO_MODE ? Number(s.value) : 0;
  }
  now(): Date {
    return new Date(Date.now() + this.offsetMs);
  }
  get offset() {
    return this.offsetMs;
  }
  async advance(ms: number) {
    if (!config().DEMO_MODE) throw new DomainError('Time travel is only available in demo mode', 403);
    if (ms < 0) throw new DomainError('Time can only move forward');
    this.offsetMs += ms;
    await this.prisma.systemSetting.upsert({
      where: { key: 'clockOffsetMs' },
      update: { value: String(this.offsetMs) },
      create: { key: 'clockOffsetMs', value: String(this.offsetMs) },
    });
    return this.now();
  }
  async reset() {
    if (!config().DEMO_MODE) throw new DomainError('Demo mode only', 403);
    this.offsetMs = 0;
    await this.prisma.systemSetting.deleteMany({ where: { key: 'clockOffsetMs' } });
  }
}
