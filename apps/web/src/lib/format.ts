export { rupees } from '@rtm/shared';

export function ago(iso: string | null | undefined): string {
  if (!iso) return 'never';
  const s = Math.round((Date.now() - Date.parse(iso)) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return `${Math.floor(s / 86400)} d ago`;
}

export function dt(iso: string | Date): string {
  return new Date(iso).toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
}

export const statusTone: Record<string, 'green' | 'amber' | 'red' | 'slate' | 'blue'> = {
  CONFIRMED: 'blue',
  ON_HOLD: 'amber',
  PARTIALLY_FULFILLED: 'amber',
  FULFILLED: 'green',
  CLOSED: 'slate',
  CANCELLED: 'red',
  REJECTED: 'red',
  PLACED: 'slate',
  REQUESTED: 'amber',
  ACCEPTED: 'green',
  PENDING: 'amber',
  SYNCED: 'green',
  DISPATCHED: 'blue',
  DELIVERED: 'green',
};
