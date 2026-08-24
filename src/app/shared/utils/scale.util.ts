/** Axis-scale helpers shared by the column and line charts. Pure — no state. */

/** A computed value axis: where it starts, where it ends, and its tick values. */
export interface ValueScale {
  min: number;
  max: number;
  ticks: number[];
}

/**
 * Round `value` up to the next "nice" number — 1, 2, 2.5 or 5 times a power of
 * ten. This is what stops an axis topping out at 4,317 and gives you 5,000.
 */
function niceCeil(value: number): number {
  if (value <= 0) return 0;
  const magnitude = 10 ** Math.floor(Math.log10(value));
  const normalised = value / magnitude;
  const step = normalised <= 1 ? 1 : normalised <= 2 ? 2 : normalised <= 2.5 ? 2.5 : normalised <= 5 ? 5 : 10;
  return step * magnitude;
}

/**
 * A zoomed floor for an axis that does not start at zero.
 *
 * Snaps `lo` down onto a grid of nice steps sized from the data's own range, so
 * a 100–120 series gets an axis of 100/105/110/115/120 rather than 0–200 with
 * every point crushed into the top tenth.
 *
 * The loop widens the step when flooring `lo` costs enough room that the grid
 * would no longer reach `hi`. It terminates because `step` strictly grows.
 */
function zoomedFloor(lo: number, hi: number, tickCount: number): number {
  let step = niceCeil((hi - lo) / tickCount) || 1;
  let min = Math.floor(lo / step) * step;
  while (min + step * tickCount < hi) {
    step = niceCeil(step * 1.5);
    min = Math.floor(lo / step) * step;
  }
  return min;
}

/**
 * Build a value axis covering `values`.
 *
 * The axis is anchored at zero whenever the data is entirely positive or
 * entirely negative. That is not a stylistic default: a bar or column whose
 * length encodes magnitude MUST grow from zero, or the ink lies about the ratio
 * between two bars. (A line chart may legitimately zoom, which is what
 * `zeroAnchored: false` is for.)
 *
 * @param values      every plotted number across every series
 * @param tickCount   how many intervals to divide the axis into
 * @param zeroAnchored force the axis to include zero (true for bars/columns)
 */
export function valueScale(values: number[], tickCount = 4, zeroAnchored = true): ValueScale {
  const finite = values.filter((v) => Number.isFinite(v));
  if (!finite.length) return { min: 0, max: 1, ticks: [0, 1] };

  let lo = Math.min(...finite);
  let hi = Math.max(...finite);

  if (zeroAnchored) {
    lo = Math.min(0, lo);
    hi = Math.max(0, hi);
  }

  // A flat series has no range to divide. Give it one so the line lands in the
  // middle of the plot instead of collapsing onto an edge.
  if (lo === hi) {
    if (lo === 0) return { min: 0, max: 1, ticks: [0, 0.5, 1] };
    lo = Math.min(0, lo);
    hi = Math.max(0, hi);
    if (lo === hi) hi = lo + Math.abs(lo);
  }

  const max = hi > 0 ? niceCeil(hi) : 0;

  let min: number;
  if (lo < 0) {
    min = -niceCeil(-lo);
  } else if (zeroAnchored) {
    min = 0;
  } else {
    // The zoom the caller asked for. Forcing 0 here (as this did originally)
    // made `zeroAnchored: false` a no-op for any all-positive series — the
    // option looked supported while changing nothing.
    min = zoomedFloor(lo, hi, tickCount);
  }

  const span = max - min || 1;
  const step = span / tickCount;

  const ticks: number[] = [];
  for (let i = 0; i <= tickCount; i++) {
    // Re-round each tick: floating-point division leaves 1999.9999999 otherwise.
    ticks.push(Math.round((min + step * i) * 1e6) / 1e6);
  }

  return { min, max, ticks };
}

/**
 * Where `value` sits on `scale`, as a percentage from the axis floor.
 * 0 = the bottom of the plot, 100 = the top.
 */
export function percentOfScale(value: number, scale: ValueScale): number {
  const span = scale.max - scale.min || 1;
  const pct = ((value - scale.min) / span) * 100;
  return Math.max(0, Math.min(100, pct));
}
