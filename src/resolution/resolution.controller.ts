import { Body, Controller, Post, Param } from '@nestjs/common';
import { z } from 'zod';
import { Auth, CurrentUser } from '../auth/auth.guard';
import { AuthUser } from '../auth/auth.types';
import { parse } from '../common/validate';
import { ResolutionService } from './resolution.service';

@Controller('proposals')
export class ResolutionController {
  constructor(private readonly r: ResolutionService) {}

  /** Any trader in the market can dispute a confirmed result during the dispute window. */
  @Post(':id/dispute')
  @Auth()
  dispute(@Param('id') id: string, @Body() body: unknown, @CurrentUser() u: AuthUser) {
    const b = parse(z.object({ reason: z.string().trim().min(10).max(2000), evidenceUrl: z.string().url().max(500).optional() }), body);
    return this.r.dispute(id, u.id, b.reason, b.evidenceUrl);
  }
}
