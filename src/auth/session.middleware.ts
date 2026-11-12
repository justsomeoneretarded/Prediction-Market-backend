import { Injectable, NestMiddleware } from '@nestjs/common';
import type { NextFunction, Response } from 'express';
import { randomBytes } from 'crypto';
import { AuthService } from './auth.service';
import { AuthedRequest, CSRF_COOKIE, CSRF_HEADER, SESSION_COOKIE } from './auth.types';
import { config } from '../config';

const SAFE = new Set(['GET', 'HEAD', 'OPTIONS']);
// Endpoints that are called by machines rather than browsers.
const CSRF_EXEMPT = [/^\/api\/payments\/webhook\//];

/**
 * 1. Resolves the session cookie into req.user.
 * 2. Double-submit CSRF protection: mutating requests must echo the tb_csrf cookie
 *    in the X-CSRF-Token header (SameSite=Lax cookies + this header defeat CSRF).
 */
@Injectable()
export class SessionMiddleware implements NestMiddleware {
  constructor(private readonly auth: AuthService) {}

  async use(req: AuthedRequest, res: Response, next: NextFunction) {
    let csrf = req.cookies?.[CSRF_COOKIE] as string | undefined;
    if (!csrf) {
      csrf = randomBytes(24).toString('base64url');
      res.cookie(CSRF_COOKIE, csrf, { httpOnly: false, sameSite: 'lax', secure: config().COOKIE_SECURE, path: '/' });
    }
    if (!SAFE.has(req.method) && !CSRF_EXEMPT.some((r) => r.test(req.path))) {
      const header = req.headers[CSRF_HEADER];
      if (!header || header !== csrf) {
        return res.status(403).json({ error: 'CSRF', message: 'Missing or invalid CSRF token. Refresh the page and try again.' });
      }
    }
    const token = req.cookies?.[SESSION_COOKIE] as string | undefined;
    if (token) {
      const user = await this.auth.resolveSession(token);
      if (user) req.user = user;
      else res.clearCookie(SESSION_COOKIE, { path: '/' });
    }
    next();
  }
}
