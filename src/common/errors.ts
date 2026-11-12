import {
  ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus, Logger,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { Response } from 'express';

/** A business-rule violation with a user-facing message. */
export class DomainError extends Error {
  constructor(message: string, public readonly status = 400, public readonly code = 'DOMAIN_ERROR') {
    super(message);
  }
}
export const notFound = (what: string) => new DomainError(`${what} not found`, 404, 'NOT_FOUND');
export const forbidden = (msg = 'You do not have permission to do that') => new DomainError(msg, 403, 'FORBIDDEN');
export const conflict = (msg: string) => new DomainError(msg, 409, 'CONFLICT');

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly log = new Logger('Error');
  catch(err: unknown, host: ArgumentsHost) {
    const res = host.switchToHttp().getResponse<Response>();
    if (err instanceof DomainError) {
      return res.status(err.status).json({ error: err.code, message: err.message });
    }
    if (err instanceof HttpException) {
      const body = err.getResponse();
      const message = typeof body === 'string' ? body : (body as { message?: unknown }).message ?? err.message;
      return res.status(err.getStatus()).json({ error: 'HTTP_ERROR', message: Array.isArray(message) ? message.join(', ') : message });
    }
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      return res.status(409).json({ error: 'CONFLICT', message: 'That record already exists' });
    }
    if (/account_non_negative|position_non_negative/.test(String((err as Error)?.message))) {
      return res.status(400).json({ error: 'INSUFFICIENT_FUNDS', message: 'Insufficient balance' });
    }
    this.log.error(err instanceof Error ? err.stack : String(err));
    return res.status(HttpStatus.INTERNAL_SERVER_ERROR).json({ error: 'INTERNAL', message: 'Something went wrong. Nothing was charged.' });
  }
}
