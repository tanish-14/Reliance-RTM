import { Injectable } from '@nestjs/common';
import type { MastersBundle } from '@rtm/shared';
import type { Tx } from '../prisma.service';
import type { AuthUser } from '../common/auth';
import { CreditService } from '../orders/credit.service';
import { mapProduct, PricingService, PRICING_LOOKBACK_MS } from '../orders/pricing.service';

/** The offline masters a field device needs. Pulled server-wins (the device replaces its copy). */
@Injectable()
export class MastersService {
  constructor(
    private readonly pricing: PricingService,
    private readonly credit: CreditService,
  ) {}

  async bundle(tx: Tx, user: AuthUser): Promise<MastersBundle> {
    const now = new Date();
    const beats = await tx.beat.findMany({
      where: { tenantId: user.tenantId, dsrId: user.userId },
      include: { outlets: { orderBy: { sequence: 'asc' } } },
    });
    const outletIds = [...new Set(beats.flatMap((b) => b.outlets.map((o) => o.outletId)))];
    const outlets = await tx.outlet.findMany({
      where: { id: { in: outletIds }, active: true },
      include: { channel: true, services: { include: { distributor: true, rtmModel: true } } },
    });
    // Masters valid any time in the lookback window so the device can price as of capture time.
    const m = await this.pricing.loadMasters(tx, user.tenantId, new Date(now.getTime() - PRICING_LOOKBACK_MS));

    const credit = [];
    for (const o of outlets) {
      for (const s of o.services) {
        const acc = await tx.creditAccount.findUnique({ where: { outletId_distributorId: { outletId: o.id, distributorId: s.distributorId } } });
        if (!acc) continue;
        const pos = await this.credit.position(tx, user.tenantId, o.id, s.distributorId);
        credit.push({
          outletId: o.id,
          distributorId: s.distributorId,
          limitPaise: Number(pos.limitPaise),
          exposurePaise: Number(pos.exposurePaise),
          blocked: pos.blocked,
        });
      }
    }

    return {
      serverTime: now.toISOString(),
      user: { id: user.userId, name: user.name, role: user.role },
      beats: beats.map((b) => ({
        id: b.id,
        code: b.code,
        name: b.name,
        daysOfWeek: b.daysOfWeek,
        anchorLat: b.anchorLat,
        anchorLng: b.anchorLng,
        geofenceM: b.geofenceM,
        outletIds: b.outlets.map((o) => o.outletId),
      })),
      outlets: outlets.map((o) => ({
        id: o.id,
        code: o.code,
        name: o.name,
        ownerName: o.ownerName,
        phone: o.phone,
        address: `${o.address}, ${o.city}`,
        channelCode: o.channel.code,
        tier: o.tier,
        stateCode: o.stateCode,
        lat: o.lat,
        lng: o.lng,
        geofenceM: o.geofenceM,
        services: o.services.map((s) => ({
          distributorId: s.distributorId,
          distributorName: s.distributor.name,
          distributorStateCode: s.distributor.stateCode,
          rtmModelCode: s.rtmModel.code,
          brandIds: s.brandIds,
          isPrimary: s.isPrimary,
        })),
      })),
      products: m.products.map((p) => ({ ...mapProduct(p), brandName: p.brand.name, packSize: p.packSize, category: p.category })),
      priceLists: m.priceLists,
      marginRules: m.marginRules,
      schemes: m.schemes,
      credit,
    };
  }
}
