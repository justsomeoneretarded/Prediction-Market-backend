import { Body, Controller, Get, HttpCode, Post } from '@nestjs/common';
import { z } from 'zod';
import { Auth, CurrentUser } from '../auth/auth.guard';
import { AuthUser } from '../auth/auth.types';
import { parse } from '../common/validate';
import { NotificationsService } from './notifications.service';

@Controller('notifications')
@Auth()
export class NotificationsController {
  constructor(private readonly n: NotificationsService) {}
  @Get()
  list(@CurrentUser() u: AuthUser) {
    return this.n.list(u.id);
  }
  @Post('read')
  @HttpCode(200)
  read(@CurrentUser() u: AuthUser, @Body() body: unknown) {
    const { ids } = parse(z.object({ ids: z.array(z.string()).max(100).optional() }), body ?? {});
    return this.n.markRead(u.id, ids);
  }
}
