import { describe, expect, it } from 'vitest';
import { isValidGstin, makeGstin } from './gstin';
import { canTransition } from './order-state';
import { withinGeofence } from './geo';
import { routeLines } from './routing';

describe('GSTIN', () => {
  it('accepts a known-valid GSTIN and rejects a corrupted check digit', () => {
    expect(isValidGstin('27AAPFU0939F1ZV')).toBe(true);
    expect(isValidGstin('27AAPFU0939F1ZW')).toBe(false);
    expect(isValidGstin('27AAPFU0939F1Z')).toBe(false);
  });
  it('makeGstin produces valid numbers', () => {
    expect(isValidGstin(makeGstin('07', 'AABCR1234K'))).toBe(true);
  });
});

describe('order lifecycle', () => {
  it('allows hold approval and forbids re-opening closed orders', () => {
    expect(canTransition('ON_HOLD', 'CONFIRMED')).toBe(true);
    expect(canTransition('CLOSED', 'CONFIRMED')).toBe(false);
    expect(canTransition('PLACED', 'FULFILLED')).toBe(false);
  });
});

describe('geofence', () => {
  it('measures distance in metres', () => {
    const r = withinGeofence({ lat: 19.076, lng: 72.8777 }, { lat: 19.0769, lng: 72.8777 }, 150);
    expect(r.distanceM).toBeGreaterThan(90);
    expect(r.distanceM).toBeLessThan(110);
    expect(r.inside).toBe(true);
  });
});

describe('routeLines', () => {
  it('splits an order across two RTM models by brand', () => {
    const services = [
      { distributorId: 'd1', rtmModelCode: 'DISTRIBUTOR_LED', brandIds: [], isPrimary: true },
      { distributorId: 'd1', rtmModelCode: 'VAN_SALES', brandIds: ['campa'], isPrimary: false },
    ];
    const brand: Record<string, string> = { cola: 'campa', atta: 'ind' };
    const { groups, unroutable } = routeLines(
      [{ productId: 'cola' }, { productId: 'atta' }],
      (p) => brand[p],
      services,
    );
    expect(unroutable).toHaveLength(0);
    expect(groups.map((g) => [g.service.rtmModelCode, g.lines.map((l) => l.productId)])).toEqual([
      ['VAN_SALES', ['cola']],
      ['DISTRIBUTOR_LED', ['atta']],
    ]);
  });
});
