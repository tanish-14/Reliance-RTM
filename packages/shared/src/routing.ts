/**
 * An outlet can be served by more than one distributor / RTM model, split by
 * brand (e.g. beverages by van sales, staples distributor-led). An order that
 * spans them is split into one order per service mapping.
 */
export interface ServiceMapping {
  distributorId: string;
  rtmModelCode: string;
  /** Empty = serves every brand. */
  brandIds: string[];
  isPrimary: boolean;
}

export function pickService<S extends ServiceMapping>(services: S[], brandId: string): S | null {
  const ranked = services
    .filter((s) => s.brandIds.length === 0 || s.brandIds.includes(brandId))
    .sort(
      (a, b) =>
        Number(b.brandIds.includes(brandId)) - Number(a.brandIds.includes(brandId)) ||
        Number(b.isPrimary) - Number(a.isPrimary),
    );
  return ranked[0] ?? null;
}

export function routeLines<S extends ServiceMapping, L extends { productId: string }>(
  lines: L[],
  brandOf: (productId: string) => string | undefined,
  services: S[],
): { groups: { service: S; lines: L[] }[]; unroutable: L[] } {
  const groups = new Map<S, L[]>();
  const unroutable: L[] = [];
  for (const line of lines) {
    const brand = brandOf(line.productId);
    const svc = brand ? pickService(services, brand) : null;
    if (!svc) {
      unroutable.push(line);
      continue;
    }
    groups.set(svc, [...(groups.get(svc) ?? []), line]);
  }
  return { groups: [...groups].map(([service, l]) => ({ service, lines: l })), unroutable };
}
