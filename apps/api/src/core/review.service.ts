import { Injectable } from '@nestjs/common';
import type { Tx } from '../prisma.service';
import { toJson } from '../common/json';

/** Exception / review queue: accepted-but-suspicious things a human must look at. */
@Injectable()
export class ReviewService {
  async raise(
    tx: Tx,
    tenantId: string,
    item: { kind: string; refType: string; refId: string; distributorId?: string | null; summary: string; details?: unknown },
  ) {
    return tx.exceptionItem.create({
      data: {
        tenantId,
        kind: item.kind,
        refType: item.refType,
        refId: item.refId,
        distributorId: item.distributorId ?? null,
        summary: item.summary,
        details: toJson(item.details ?? {}),
      },
    });
  }

  async resolveFor(tx: Tx, tenantId: string, refType: string, refId: string, by: string, resolution: string) {
    await tx.exceptionItem.updateMany({
      where: { tenantId, refType, refId, status: 'OPEN' },
      data: { status: 'RESOLVED', resolvedById: by, resolvedAt: new Date(), resolution },
    });
  }
}
