/**
 * The single Order lifecycle shared by every channel and RTM model.
 * Models differ only in *when* transitions happen (e.g. van sales fulfil at
 * order time), never in which states exist.
 */
export const ORDER_STATUSES = [
  'PLACED',
  'ON_HOLD',
  'CONFIRMED',
  'PARTIALLY_FULFILLED',
  'FULFILLED',
  'CLOSED',
  'CANCELLED',
  'REJECTED',
] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

const TRANSITIONS: Record<OrderStatus, OrderStatus[]> = {
  PLACED: ['CONFIRMED', 'ON_HOLD', 'CANCELLED'],
  ON_HOLD: ['CONFIRMED', 'REJECTED', 'CANCELLED'],
  CONFIRMED: ['PARTIALLY_FULFILLED', 'FULFILLED', 'CANCELLED'],
  // A backorder can be fulfilled later or short-closed; invoiced goods are cancelled via credit note.
  PARTIALLY_FULFILLED: ['PARTIALLY_FULFILLED', 'FULFILLED', 'CLOSED', 'CANCELLED'],
  FULFILLED: ['CLOSED', 'CANCELLED'],
  CLOSED: [],
  CANCELLED: [],
  REJECTED: [],
};

export function canTransition(from: OrderStatus, to: OrderStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export function assertTransition(from: OrderStatus, to: OrderStatus): void {
  if (!canTransition(from, to)) {
    throw new Error(`Illegal order transition ${from} -> ${to}`);
  }
}

export function isOpen(status: OrderStatus): boolean {
  return ['PLACED', 'ON_HOLD', 'CONFIRMED', 'PARTIALLY_FULFILLED'].includes(status);
}
