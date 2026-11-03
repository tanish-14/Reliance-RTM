import type { MarginRuleDef, PriceListDef, PricingProduct, SchemeDef } from './pricing';

/** Masters a field device holds offline. Pulled server-wins; replaces local copy. */
export interface MastersBundle {
  serverTime: string;
  user: { id: string; name: string; role: string };
  beats: {
    id: string;
    code: string;
    name: string;
    daysOfWeek: number[];
    anchorLat: number;
    anchorLng: number;
    geofenceM: number;
    outletIds: string[];
  }[];
  outlets: {
    id: string;
    code: string;
    name: string;
    ownerName: string;
    phone: string;
    address: string;
    channelCode: string;
    tier: string | null;
    stateCode: string;
    lat: number;
    lng: number;
    geofenceM: number;
    /** Which distributor + RTM model serves which brands at this outlet. */
    services: {
      distributorId: string;
      distributorName: string;
      distributorStateCode: string;
      rtmModelCode: string;
      brandIds: string[];
      isPrimary: boolean;
    }[];
  }[];
  products: (PricingProduct & { brandName: string; packSize: string; category: string })[];
  priceLists: PriceListDef[];
  marginRules: MarginRuleDef[];
  schemes: SchemeDef[];
  credit: {
    outletId: string;
    distributorId: string;
    limitPaise: number;
    exposurePaise: number;
    blocked: boolean;
  }[];
}
