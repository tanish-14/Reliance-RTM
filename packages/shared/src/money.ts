/** All money is integer paise. Never use floats for stored amounts. */
export type Paise = number;

/** Apply basis points (1/100 of a percent) with half-up rounding to the paisa. */
export function applyBp(amount: Paise, bp: number): Paise {
  return Math.round((amount * bp) / 10_000);
}

export function rupees(paise: Paise): string {
  const sign = paise < 0 ? '-' : '';
  const abs = Math.abs(paise);
  const r = Math.floor(abs / 100);
  const p = String(abs % 100).padStart(2, '0');
  return `${sign}₹${r.toLocaleString('en-IN')}.${p}`;
}

export function sum(values: Paise[]): Paise {
  return values.reduce((a, b) => a + b, 0);
}

/**
 * Split `total` across `weights` so the parts add up exactly to `total`
 * (largest-remainder method). Used for proportional partial invoicing.
 */
export function allocate(total: Paise, weights: number[]): Paise[] {
  const w = weights.reduce((a, b) => a + b, 0);
  if (w === 0) return weights.map(() => 0);
  const raw = weights.map((x) => (total * x) / w);
  const floors = raw.map(Math.floor);
  let rest = total - floors.reduce((a, b) => a + b, 0);
  const order = raw
    .map((x, i) => ({ i, frac: x - Math.floor(x) }))
    .sort((a, b) => b.frac - a.frac);
  for (const { i } of order) {
    if (rest <= 0) break;
    floors[i] += 1;
    rest -= 1;
  }
  return floors;
}
