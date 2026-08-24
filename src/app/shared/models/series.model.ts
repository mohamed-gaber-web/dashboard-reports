/**
 * Shapes for multi-series charts (column, line).
 *
 * Distinct from {@link ChartDatum} in `chart.model.ts`, which is one
 * category/value pair — the right shape for a single-series bar or a donut
 * slice. A series chart plots the SAME category axis across several measures,
 * so the labels live once on the chart and each series carries only its values.
 */

/** One plotted series. `values` is index-aligned with the chart's `labels`. */
export interface ChartSeries {
  label: string;
  values: number[];
  /** Optional explicit colour; charts fall back to the categorical palette. */
  color?: string;
}
