export const ROLES = ['ADMIN', 'MANAGER', 'DISTRIBUTOR', 'DSR', 'RETAILER'] as const;
export type Role = (typeof ROLES)[number];

/** Landing route for each role's shell. */
export const ROLE_HOME: Record<Role, string> = {
  ADMIN: '/admin',
  MANAGER: '/hq',
  DISTRIBUTOR: '/distributor',
  DSR: '/dsr',
  RETAILER: '/retailer',
};

/** Where an RTM model takes stock from. Data on RtmModel rows, not code paths. */
export const STOCK_SOURCES = ['DISTRIBUTOR_WAREHOUSE', 'VAN', 'COMPANY_DEPOT'] as const;
export type StockSource = (typeof STOCK_SOURCES)[number];

/** When an invoice is raised for an RTM model. */
export const INVOICE_TIMINGS = ['ON_DISPATCH', 'ON_ORDER'] as const;
export type InvoiceTiming = (typeof INVOICE_TIMINGS)[number];

export const ORDER_FLAGS = [
  'CREDIT_BREACH',
  'CREDIT_BLOCKED',
  'PRICE_MISMATCH',
  'STALE_CAPTURE',
  'CLOCK_SKEW',
  'BACKORDER',
] as const;
export type OrderFlag = (typeof ORDER_FLAGS)[number];

export const RETURN_CONDITIONS = ['SALEABLE', 'DAMAGED', 'EXPIRED'] as const;
export type ReturnCondition = (typeof RETURN_CONDITIONS)[number];

export const COLLECTION_MODES = ['CASH', 'UPI'] as const;
export type CollectionMode = (typeof COLLECTION_MODES)[number];

/** 2-digit GST state codes used in seed data and place-of-supply logic. */
export const GST_STATE_CODES: Record<string, string> = {
  '07': 'Delhi',
  '09': 'Uttar Pradesh',
  '24': 'Gujarat',
  '27': 'Maharashtra',
  '29': 'Karnataka',
  '33': 'Tamil Nadu',
};
