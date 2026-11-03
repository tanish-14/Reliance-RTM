import { Injectable } from '@nestjs/common';
import { canTransition, type OrderStatus } from '@rtm/shared';
import type { Tx } from '../prisma.service';
import { DomainError } from '../common/errors';

/** The only place an order's status changes. Optimistic: the row must still be in `from`. */
@Injectable()
export class OrderStateService {
  async transition(tx: Tx, orderId: string, from: string, to: OrderStatus, actorId: string, note?: string) {
    if (!canTransition(from as OrderStatus, to)) {
      throw new DomainError('ILLEGAL_TRANSITION', `Order cannot go from ${from} to ${to}`, 409);
    }
    const r = await tx.order.updateMany({ where: { id: orderId, status: from }, data: { status: to } });
    if (r.count !== 1) throw new DomainError('CONCURRENT_UPDATE', 'Order changed underneath you; reload and retry', 409);
    await tx.orderEvent.create({ data: { orderId, fromStatus: from, toStatus: to, actorId, note } });
  }
}
