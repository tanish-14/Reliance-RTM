import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/** RFC 6238 TOTP (SHA-1, 6 digits, 30 s) — compatible with Google Authenticator, Authy, etc. */
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function newSecret(): string {
  const bytes = randomBytes(20);
  let bits = '';
  for (const b of bytes) bits += b.toString(2).padStart(8, '0');
  return (bits.match(/.{1,5}/g) ?? []).map((c) => B32[parseInt(c.padEnd(5, '0'), 2)]).join('');
}

function decode(secret: string): Buffer {
  const bits = secret
    .replace(/=+$/, '')
    .toUpperCase()
    .split('')
    .map((c) => B32.indexOf(c).toString(2).padStart(5, '0'))
    .join('');
  return Buffer.from((bits.match(/.{8}/g) ?? []).map((b) => parseInt(b, 2)));
}

export function totp(secret: string, at = Date.now(), step = 30): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(at / 1000 / step)));
  const h = createHmac('sha1', decode(secret)).update(counter).digest();
  const o = h[h.length - 1] & 0xf;
  const code = ((h.readUInt32BE(o) & 0x7fffffff) % 1_000_000).toString().padStart(6, '0');
  return code;
}

/** Accept the current step and one either side (clock drift). */
export function verifyTotp(secret: string, code: string, at = Date.now()): boolean {
  if (!/^\d{6}$/.test(code)) return false;
  return [-1, 0, 1].some((w) => {
    const c = totp(secret, at + w * 30_000);
    return timingSafeEqual(Buffer.from(c), Buffer.from(code));
  });
}

export const otpauthUrl = (secret: string, account: string) =>
  `otpauth://totp/RCPL%20RTM:${encodeURIComponent(account)}?secret=${secret}&issuer=RCPL%20RTM&digits=6&period=30`;
