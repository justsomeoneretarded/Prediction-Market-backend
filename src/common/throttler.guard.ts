import { Injectable } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';

/**
 * Rate-limit key = client IP + targeted account (for login/register). Brute force against one
 * account stays capped, while many people behind one NAT (common on mobile networks) are not
 * locked out by each other.
 */
@Injectable()
export class AppThrottlerGuard extends ThrottlerGuard {
  protected async getTracker(req: Record<string, any>): Promise<string> {
    const who = typeof req.body?.login === 'string' ? req.body.login : typeof req.body?.email === 'string' ? req.body.email : '';
    return `${req.ip}:${String(who).toLowerCase().slice(0, 100)}`;
  }
}
