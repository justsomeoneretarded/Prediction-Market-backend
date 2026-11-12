import { Global, Module } from '@nestjs/common';
import { PrismaService } from './prisma.service';
import { ClockService } from './clock.service';
import { AuditService } from './audit.service';

@Global()
@Module({
  providers: [PrismaService, ClockService, AuditService],
  exports: [PrismaService, ClockService, AuditService],
})
export class CommonModule {}
