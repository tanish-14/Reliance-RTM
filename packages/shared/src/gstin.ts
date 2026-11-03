const CHARS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const SHAPE = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;

/** GSTIN check character (mod-36, alternating weights 1 and 2 over the first 14 chars). */
export function gstinCheckChar(first14: string): string {
  let total = 0;
  for (let i = 0; i < 14; i++) {
    const v = CHARS.indexOf(first14[i]) * (i % 2 === 0 ? 1 : 2);
    total += Math.floor(v / 36) + (v % 36);
  }
  return CHARS[(36 - (total % 36)) % 36];
}

export function isValidGstin(gstin: string): boolean {
  const g = gstin.trim().toUpperCase();
  return SHAPE.test(g) && gstinCheckChar(g.slice(0, 14)) === g[14];
}

export function gstinStateCode(gstin: string): string {
  return gstin.slice(0, 2);
}

/** Build a valid GSTIN from state code + PAN (+ entity number). Seed/test helper. */
export function makeGstin(stateCode: string, pan: string, entity = '1'): string {
  const first14 = `${stateCode}${pan}${entity}Z`;
  return first14 + gstinCheckChar(first14);
}
