/**
 * Exact rational arithmetic on BigInt. All MARCOM KPI maths runs on this, never on JS floats:
 * DECIMAL columns arrive as strings and are parsed losslessly, sums/products/quotients stay exact,
 * and thresholds are compared with `cmp` (which cross-multiplies), so "CTR exactly 5.000%" can
 * never be pushed across a boundary by rounding. Conversion to a JS number happens once, at the
 * very end, for output only.
 */
const SCALE = 10n ** 18n;

function gcd(a: bigint, b: bigint): bigint {
  let x = a < 0n ? -a : a;
  let y = b < 0n ? -b : b;
  while (y) [x, y] = [y, x % y];
  return x;
}

export class Rat {
  readonly n: bigint;
  readonly d: bigint;

  private constructor(n: bigint, d: bigint) {
    this.n = n;
    this.d = d;
  }

  static of(n: bigint, d: bigint = 1n): Rat {
    if (d === 0n) throw new RangeError('Rat: zero denominator');
    if (d < 0n) { n = -n; d = -d; }
    const g = gcd(n, d) || 1n;
    return new Rat(n / g, d / g);
  }

  static readonly ZERO = Rat.of(0n);
  static readonly ONE = Rat.of(1n);

  /** Parses a decimal string / integer / safe JS number exactly. null/undefined/'' -> 0. */
  static parse(v: unknown): Rat {
    if (v === null || v === undefined || v === '') return Rat.ZERO;
    if (typeof v === 'bigint') return Rat.of(v);
    let s = typeof v === 'number' ? (Number.isFinite(v) ? String(v) : '') : String(v).trim();
    if (!s) throw new TypeError(`Rat.parse: not a finite number: ${String(v)}`);
    const exp = /^([+-]?[\d.]+)[eE]([+-]?\d+)$/.exec(s);
    if (exp) {
      const shift = Number(exp[2]);
      const base = Rat.parse(exp[1]);
      return shift >= 0 ? base.mul(Rat.of(10n ** BigInt(shift))) : base.div(Rat.of(10n ** BigInt(-shift)))!;
    }
    let neg = false;
    if (s[0] === '-') { neg = true; s = s.slice(1); } else if (s[0] === '+') s = s.slice(1);
    const m = /^(\d*)(?:\.(\d*))?$/.exec(s);
    if (!m || (m[1] === '' && (m[2] ?? '') === '')) throw new TypeError(`Rat.parse: not a decimal: ${String(v)}`);
    const frac = m[2] ?? '';
    const n = BigInt((m[1] || '0') + frac);
    return Rat.of(neg ? -n : n, 10n ** BigInt(frac.length));
  }

  add(o: Rat): Rat { return Rat.of(this.n * o.d + o.n * this.d, this.d * o.d); }
  sub(o: Rat): Rat { return Rat.of(this.n * o.d - o.n * this.d, this.d * o.d); }
  mul(o: Rat): Rat { return Rat.of(this.n * o.n, this.d * o.d); }
  /** null when dividing by zero -- callers turn that into `value: null, status: 'na'`. */
  div(o: Rat): Rat | null { return o.n === 0n ? null : Rat.of(this.n * o.d, this.d * o.n); }

  cmp(o: Rat): -1 | 0 | 1 {
    const l = this.n * o.d;
    const r = o.n * this.d;
    return l < r ? -1 : l > r ? 1 : 0;
  }
  isZero(): boolean { return this.n === 0n; }
  isNeg(): boolean { return this.n < 0n; }

  /** Nearest JS number (round-half-away at 18 decimal places). Output only -- never compare on this. */
  toNumber(): number {
    const neg = this.n < 0n;
    const a = neg ? -this.n : this.n;
    const scaled = (a * SCALE * 2n + this.d) / (2n * this.d);
    const whole = scaled / SCALE;
    const frac = scaled % SCALE;
    const out = Number(whole) + Number(frac) / 1e18;
    return neg ? -out : out;
  }
}

export const R = (v: unknown): Rat => Rat.parse(v);

export function sum(values: Iterable<Rat>): Rat {
  let t = Rat.ZERO;
  for (const v of values) t = t.add(v);
  return t;
}

/** num / den, or null when den is zero. */
export const ratio = (num: Rat, den: Rat): Rat | null => num.div(den);

const HUNDRED = Rat.of(100n);
/** Fraction -> percentage points (exact). */
export const pct = (fraction: Rat | null): Rat | null => (fraction === null ? null : fraction.mul(HUNDRED));
