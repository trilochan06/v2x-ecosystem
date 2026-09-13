/**
 * Small-sample summary statistics. Mirrors backend/app/stats.py.
 *
 * A single seed is one sample of a stochastic process, and this simulation is
 * stochastic everywhere. So every reported figure is a mean over several seeds
 * with a 95% confidence interval, using Student's t rather than 1.96 sigma --
 * at n = 3 the normal approximation understates the interval by more than 2x.
 */

/** Two-tailed t critical values at 95%, indexed by degrees of freedom. */
const T95: Record<number, number> = {
  1: 12.706,
  2: 4.303,
  3: 3.182,
  4: 2.776,
  5: 2.571,
  6: 2.447,
  7: 2.365,
  8: 2.306,
  9: 2.262,
  10: 2.228,
  11: 2.201,
  12: 2.179,
  13: 2.16,
  14: 2.145,
  15: 2.131,
  16: 2.12,
  17: 2.11,
  18: 2.101,
  19: 2.093,
  20: 2.086,
  25: 2.06,
  30: 2.042,
  40: 2.021,
  60: 2.0,
};
const T95_INFINITY = 1.96;

export function tMultiplier(df: number): number {
  if (df < 1) return 0;
  if (T95[df] !== undefined) return T95[df];
  const keys = Object.keys(T95).map(Number);
  const largest = Math.max(...keys);
  // Past the table, t is within a percent of the normal limit.
  if (df > largest) return T95_INFINITY;
  // Between tabulated points, take the nearest df below -- the larger
  // multiplier -- so the interval is never understated.
  return T95[Math.max(...keys.filter((k) => k < df))];
}

// `Estimate` lives in ../types so the pages and the engine share one
// definition of what a reported figure is.
export type { Estimate } from "../types";
import type { Estimate } from "../types";

const round4 = (x: number) => Math.round(x * 1e4) / 1e4;

export function summarize(values: number[]): Estimate {
  const n = values.length;
  if (n === 0) {
    return { mean: 0, half_width: 0, low: 0, high: 0, stdev: 0, n: 0, reportable: false };
  }
  const mean = values.reduce((a, b) => a + b, 0) / n;
  if (n === 1) {
    return {
      mean: round4(mean),
      half_width: 0,
      low: round4(mean),
      high: round4(mean),
      stdev: 0,
      n: 1,
      reportable: false,
    };
  }
  const variance = values.reduce((a, v) => a + (v - mean) ** 2, 0) / (n - 1);
  const stdev = Math.sqrt(variance);
  const halfWidth = (tMultiplier(n - 1) * stdev) / Math.sqrt(n);
  return {
    mean: round4(mean),
    half_width: round4(halfWidth),
    low: round4(mean - halfWidth),
    high: round4(mean + halfWidth),
    stdev: round4(stdev),
    n,
    reportable: true,
  };
}

/**
 * True when two 95% intervals do not overlap. Sufficient evidence of a
 * difference, but not necessary for one -- so this decides when the site may
 * claim a result, never when it must deny one.
 */
export function separated(a: Estimate, b: Estimate): boolean {
  if (!a.reportable || !b.reportable) return false;
  return a.high < b.low || b.high < a.low;
}
