/** A single category/value pair for bar and donut charts. */
export interface ChartDatum {
  label: string;
  value: number;
  /** Optional explicit colour; charts fall back to {@link CHART_PALETTE}. */
  color?: string;
}

/** Categorical colour palette (resolves to the theme's chart tokens). */
export const CHART_PALETTE = [
  'var(--color-chart-1)',
  'var(--color-chart-2)',
  'var(--color-chart-3)',
  'var(--color-chart-4)',
  'var(--color-chart-5)',
  'var(--color-chart-6)',
  'var(--color-chart-7)',
  'var(--color-chart-8)',
] as const;

/** Pick a stable palette colour for the datum at position `index`. */
export function paletteColor(index: number): string {
  return CHART_PALETTE[index % CHART_PALETTE.length];
}
