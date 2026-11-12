import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService, Tx } from './prisma.service';

export interface AuditInput {
  actorId?: string | null;
  action: string;
  entityType: string;
  entityId?: string | null;
  reason?: string | null;
  data?: unknown;
  ip?: string | null;
}

/** Append-only audit trail (DB trigger forbids UPDATE/DELETE on AuditLog). */
@Injectable()
export class AuditService {
  constructor(private readonly prisma: PrismaService) {}
  log(input: AuditInput, tx?: Tx) {
    const db = tx ?? this.prisma;
    return db.auditLog.create({
      data: {
        actorId: input.actorId ?? null,
        action: input.action,
        entityType: input.entityType,
        entityId: input.entityId ?? null,
        reason: input.reason ?? null,
        data: input.data === undefined ? Prisma.JsonNull : (JSON.parse(JSON.stringify(input.data)) as Prisma.InputJsonValue),
        ip: input.ip ?? null,
      },
    });
  }
}
