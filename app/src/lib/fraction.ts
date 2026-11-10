/** Exact fractions so that 1/3 + 1/3 + 1/3 sums to exactly 1. */
export interface Frac {
  n: bigint;
  d: bigint;
}

const abs = (a: bigint) => (a < 0n ? -a : a);
function gcd(a: bigint, b: bigint): bigint {
  a = abs(a);
  b = abs(b);
  while (b) [a, b] = [b, a % b];
  return a;
}

export function frac(n: bigint, d: bigint): Frac {
  if (d === 0n) throw new Error('zero denominator');
  if (d < 0n) {
    n = -n;
    d = -d;
  }
  const g = gcd(n, d) || 1n;
  return { n: n / g, d: d / g };
}

function parseDecimal(s: string): Frac | null {
  const m = /^(\d+)(?:[.,](\d+))?$/.exec(s);
  if (!m) return null;
  const dec = m[2] ?? '';
  return frac(BigInt(m[1] + dec), 10n ** BigInt(dec.length));
}

/** Accepts "1/2", "0.5", "0,5", "50%", "1". Returns null for anything else. */
export function parseFraction(input: string | null | undefined): Frac | null {
  const s = (input ?? '').trim().replace(/\s+/g, '');
  if (!s) return null;
  if (s.endsWith('%')) {
    const v = parseDecimal(s.slice(0, -1));
    return v ? frac(v.n, v.d * 100n) : null;
  }
  const m = /^(\d+)\/(\d+)$/.exec(s);
  if (m) {
    const d = BigInt(m[2]);
    return d === 0n ? null : frac(BigInt(m[1]), d);
  }
  return parseDecimal(s);
}

export const addFrac = (a: Frac, b: Frac): Frac => frac(a.n * b.d + b.n * a.d, a.d * b.d);
export const toNumber = (f: Frac): number => Number(f.n) / Number(f.d);
export const isOne = (f: Frac): boolean => f.n === f.d;
export const formatFrac = (f: Frac): string => (f.d === 1n ? `${f.n}` : `${f.n}/${f.d}`);
