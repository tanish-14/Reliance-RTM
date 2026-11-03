import { ArgumentsHost, Catch, ExceptionFilter, HttpException } from '@nestjs/common';
import type { Response } from 'express';
import { Prisma } from '@prisma/client';

/** A business-rule failure. Carries a stable machine code for clients. */
export class DomainError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status = 422,
    public readonly details?: unknown,
  ) {
    super(message);
  }
}

export const notFound = (what: string) => new DomainError('NOT_FOUND', `${what} not found`, 404);
export const forbidden = (msg = 'Not allowed for your role or scope') => new DomainError('FORBIDDEN', msg, 403);

export function isUniqueViolation(e: unknown, target?: string): boolean {
  if (!(e instanceof Prisma.PrismaClientKnownRequestError) || e.code !== 'P2002') return false;
  if (!target) return true;
  return JSON.stringify(e.meta ?? {}).includes(target);
}

@Catch()
export class ErrorFilter implements ExceptionFilter {
  catch(err: unknown, host: ArgumentsHost) {
    const res = host.switchToHttp().getResponse<Response>();
    if (err instanceof DomainError) {
      res.status(err.status).json({ code: err.code, message: err.message, details: err.details });
      return;
    }
    if (err instanceof HttpException) {
      const body = err.getResponse();
      res.status(err.getStatus()).json(typeof body === 'string' ? { code: 'HTTP_ERROR', message: body } : body);
      return;
    }
    // Unexpected: logged by pino-http via res.err; never leak internals.
    (res as Response & { err?: Error }).err = err as Error;
    res.status(500).json({ code: 'INTERNAL', message: 'Something went wrong' });
  }
}
