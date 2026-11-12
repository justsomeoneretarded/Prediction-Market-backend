import { Injectable } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { PrismaService, Tx } from '../common/prisma.service';
import type { RealtimeGateway } from '../realtime/realtime.gateway';

export interface NotifyInput {
  type: string;
  title: string;
  body: string;
  link?: string;
}

@Injectable()
export class NotificationsService {
  private gateway?: RealtimeGateway;
  constructor(private readonly prisma: PrismaService, private readonly moduleRef: ModuleRef) {}

  private rt(): RealtimeGateway | undefined {
    if (!this.gateway) {
      try {
        // resolved lazily to avoid a module cycle (auth ↔ realtime ↔ notifications)
        const { RealtimeGateway } = require('../realtime/realtime.gateway');
        this.gateway = this.moduleRef.get(RealtimeGateway, { strict: false });
      } catch {
        return undefined;
      }
    }
    return this.gateway;
  }

  async notify(userId: string, n: NotifyInput, tx?: Tx) {
    const row = await (tx ?? this.prisma).notification.create({ data: { userId, ...n } });
    if (!tx) this.rt()?.emitUser(userId, 'notification', row);
    return row;
  }

  /** Push already-committed notifications to sockets (used after a transaction). */
  push(userId: string, payload: unknown) {
    this.rt()?.emitUser(userId, 'notification', payload);
  }

  list(userId: string) {
    return this.prisma.notification.findMany({ where: { userId }, orderBy: { createdAt: 'desc' }, take: 50 });
  }

  async markRead(userId: string, ids?: string[]) {
    await this.prisma.notification.updateMany({
      where: { userId, readAt: null, ...(ids?.length ? { id: { in: ids } } : {}) },
      data: { readAt: new Date() },
    });
    return { ok: true };
  }
}
