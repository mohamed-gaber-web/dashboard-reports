import { describe, expect, it } from 'vitest';
import { percentOfScale, valueScale } from './scale.util';

describe('valueScale', () => {
  it('rounds the top up to a clean number', () => {
    // The point of the axis: 4,317 should read 5,000, not 4,317.
    expect(valueScale([4317]).max).toBe(5000);
    expect(valueScale([12]).max).toBe(20);
    expect(valueScale([1]).max).toBe(1);
  });

  it('anchors at zero for bars and columns', () => {
    // A column encodes magnitude by length, so a truncated axis makes the ink
    // lie about the ratio between two columns.
    expect(valueScale([100, 120]).min).toBe(0);
  });

  it('can zoom when the caller opts out of zero-anchoring', () => {
    const scale = valueScale([100, 120], 4, false);
    expect(scale.min).toBeGreaterThan(0);
  });

  it('extends below zero for negative values', () => {
    const scale = valueScale([-30, 60]);
    expect(scale.min).toBeLessThan(0);
    expect(scale.max).toBeGreaterThan(0);
  });

  it('gives a flat series a usable range instead of collapsing it', () => {
    const scale = valueScale([5, 5, 5]);
    expect(scale.max).toBeGreaterThan(scale.min);
  });

  it('handles an all-zero series', () => {
    const scale = valueScale([0, 0]);
    expect(scale.max).toBeGreaterThan(scale.min);
    expect(Number.isFinite(scale.max)).toBe(true);
  });

  it('survives an empty series without producing NaN', () => {
    const scale = valueScale([]);
    expect(Number.isFinite(scale.min)).toBe(true);
    expect(Number.isFinite(scale.max)).toBe(true);
  });

  it('ignores non-finite values', () => {
    const scale = valueScale([10, NaN, Infinity]);
    expect(Number.isFinite(scale.max)).toBe(true);
  });

  it('emits tickCount + 1 ticks, ascending, with no float noise', () => {
    const { ticks } = valueScale([0, 2000], 4);
    expect(ticks).toHaveLength(5);
    expect(ticks).toEqual([...ticks].sort((a, b) => a - b));
    // 1999.9999999 in an axis label is the classic float-division tell.
    for (const t of ticks) expect(t).toBe(Math.round(t * 1e6) / 1e6);
  });
});

describe('percentOfScale', () => {
  const scale = valueScale([0, 100]);

  it('maps the floor to 0 and the ceiling to 100', () => {
    expect(percentOfScale(scale.min, scale)).toBe(0);
    expect(percentOfScale(scale.max, scale)).toBe(100);
  });

  it('maps the midpoint to 50', () => {
    expect(percentOfScale((scale.min + scale.max) / 2, scale)).toBe(50);
  });

  it('clamps out-of-range values so a mark never escapes the plot', () => {
    expect(percentOfScale(-999, scale)).toBe(0);
    expect(percentOfScale(1e9, scale)).toBe(100);
  });

  it('places zero correctly on an axis that spans negatives', () => {
    const spanning = valueScale([-50, 50]);
    expect(percentOfScale(0, spanning)).toBe(50);
  });
});
