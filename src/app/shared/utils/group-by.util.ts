import { ChartDatum } from '../models/chart.model';

/**
 * Aggregate a list into ranked {@link ChartDatum}s.
 *
 * @param items   source rows
 * @param keyFn   category label for a row
 * @param valueFn contribution of a row (defaults to a count of 1)
 * @param topN    keep the largest N categories, rolling the rest into "Other"
 */
export function aggregate<T>(
  items: readonly T[],
  keyFn: (item: T) => string,
  valueFn: (item: T) => number = () => 1,
  topN = 8,
): ChartDatum[] {
  const totals = new Map<string, number>();
  for (const item of items) {
    const key = keyFn(item) || '—';
    totals.set(key, (totals.get(key) ?? 0) + valueFn(item));
  }

  const ranked = [...totals.entries()]
    .map(([label, value]) => ({ label, value }))
    .sort((a, b) => b.value - a.value);

  if (ranked.length <= topN) return ranked;

  const head = ranked.slice(0, topN - 1);
  const other = ranked.slice(topN - 1).reduce((sum, d) => sum + d.value, 0);
  return [...head, { label: 'Other', value: other }];
}

/** Count the distinct values produced by `keyFn`. */
export function distinctCount<T>(items: readonly T[], keyFn: (item: T) => string): number {
  return new Set(items.map(keyFn)).size;
}
