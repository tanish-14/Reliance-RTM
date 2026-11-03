import { PipeTransform } from '@nestjs/common';
import type { ZodSchema } from 'zod';
import { DomainError } from './errors';

/** Validates a request body against a shared zod schema (same schema the client uses). */
export class ZodPipe<T> implements PipeTransform<unknown, T> {
  constructor(private readonly schema: ZodSchema<T>) {}

  transform(value: unknown): T {
    const r = this.schema.safeParse(value);
    if (!r.success) {
      throw new DomainError('VALIDATION', 'Invalid request', 400, r.error.flatten());
    }
    return r.data;
  }
}
