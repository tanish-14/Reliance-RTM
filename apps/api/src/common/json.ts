/** Money is BIGINT paise in the DB; values stay far below 2^53 so JSON numbers are safe. */
export function installBigIntJson() {
  (BigInt.prototype as unknown as { toJSON: () => number }).toJSON = function (this: bigint) {
    return Number(this);
  };
}

/** Plain JSON value for Prisma Json columns (bigint -> number, Dates -> ISO). */
export function toJson<T>(value: T): any {
  return JSON.parse(JSON.stringify(value, (_k, v) => (typeof v === 'bigint' ? Number(v) : v)));
}

export const big = (n: number | bigint) => BigInt(n);
export const num = (n: bigint | number) => Number(n);
