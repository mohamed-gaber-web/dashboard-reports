import { ChartDatum, paletteColor } from '../../../shared/models/chart.model';
import { TableColumn } from '../../../shared/models/table-column.model';
import { ValueFormat } from './field-meta.model';

export type Aggregation = 'count' | 'sum' | 'avg' | 'distinctCount';
export type ChartAggregation = 'count' | 'sum' | 'avg';
export type FilterOp = 'eq' | 'neq' | 'gt' | 'lt' | 'gte' | 'lte' | 'contains';

export interface FilterSpec {
  field: string;
  op: FilterOp;
  value: string | number;
}

export interface KpiSpec {
  label: string;
  agg: Aggregation;
  field?: string;
  format?: ValueFormat;
}

export interface ChartSpec {
  type: 'bar' | 'donut';
  title: string;
  groupBy: string;
  agg: ChartAggregation;
  valueField?: string;
  topN?: number;
}

export interface TableSpec {
  columns: string[];
}

/** How dense the report is drawn. */
export type ReportDensity = 'comfortable' | 'compact';

/**
 * Which colours the charts use.
 *
 * `categorical` — the validated 8-hue palette: different categories, different
 * hues. `brand` / `accent` — one hue stepped light-to-dark, for a report where
 * the categories are ordered (or where the user just wants it to stop looking
 * like a pie chart from 2004).
 */
export type ReportPalette = 'categorical' | 'brand' | 'accent';

/** How the charts are packed. `auto` fits the count to the sheet's width. */
export type ChartLayout = 'auto' | 'stacked' | 'grid';

/**
 * The report's LOOK, as opposed to its content — the part of a report a user
 * asks to change in words ("make it compact", "one colour", "bigger charts")
 * rather than by naming a field.
 *
 * It is on the spec, not in the app's settings, because the model is what the
 * user is talking to: "make that more compact" has to land somewhere the next
 * `emit_report` can honour. Every member is optional and every value is a
 * closed enum — the model picks from a vocabulary, it never emits CSS.
 */
export interface ReportDesign {
  density?: ReportDensity;
  palette?: ReportPalette;
  chartLayout?: ChartLayout;
}

/** {@link ReportDesign} with every default filled in. What the renderer binds to. */
export type ResolvedDesign = Required<ReportDesign>;

export const DEFAULT_DESIGN: ResolvedDesign = {
  density: 'comfortable',
  palette: 'categorical',
  chartLayout: 'auto',
};

/**
 * Single-hue ramps, as CSS variables rather than resolved hex — BrandingService
 * rewrites those variables at runtime, so a report drawn in "brand" re-themes
 * with the app instead of freezing the colour it was computed under.
 */
const DESIGN_RAMPS: Record<Exclude<ReportPalette, 'categorical'>, readonly string[]> = {
  brand: [
    'var(--color-brand-700)',
    'var(--color-brand-600)',
    'var(--color-brand-500)',
    'var(--color-brand-400)',
    'var(--color-brand-300)',
    'var(--color-brand-200)',
  ],
  accent: [
    'var(--color-accent-600)',
    'var(--color-accent-500)',
    'var(--color-accent-400)',
    'color-mix(in srgb, var(--color-accent-400) 70%, white)',
    'color-mix(in srgb, var(--color-accent-400) 45%, white)',
    'color-mix(in srgb, var(--color-accent-400) 25%, white)',
  ],
};

/**
 * The colour for position `index` under `palette`.
 *
 * `categorical` defers to the app's validated 8-hue palette (contrast- and
 * CVD-checked). The single-hue ramps are ordered, so they lean on position and
 * the legend for identity instead of on hue separation.
 */
export function reportColor(palette: ReportPalette, index: number): string {
  if (palette === 'categorical') return paletteColor(index);
  const ramp = DESIGN_RAMPS[palette];
  return ramp[index % ramp.length];
}

/**
 * The dashboard the LLM designs. The app computes it against the real, local
 * dataset — the model never returns numbers, only the report's shape.
 */
export interface ReportSpec {
  title: string;
  description?: string;
  filters?: FilterSpec[];
  kpis: KpiSpec[];
  charts: ChartSpec[];
  table?: TableSpec;
  /** Optional look. Omitted = {@link DEFAULT_DESIGN}. */
  design?: ReportDesign;
}

// ── Computed result (what the renderer binds to) ───────────────────────────

export interface KpiResult {
  label: string;
  value: string;
}

export interface ChartResult {
  type: 'bar' | 'donut';
  title: string;
  data: ChartDatum[];
}

/**
 * The `rows` field used to be a single array capped at 100, while a comment
 * claimed "export still receives the full filtered set". It did not — the export
 * silently shipped 100 rows. The two audiences are split so a caller has to say
 * which one it means, and the compiler catches anyone who gets it wrong.
 */
export interface TableResult {
  columns: TableColumn<Record<string, unknown>>[];
  /** Capped for rendering. NEVER export these — they are not the whole answer. */
  displayRows: Record<string, unknown>[];
  /** How many rows the table's query actually matches, from `@odata.count`. */
  total: number;
  /** The cap applied to {@link displayRows}. */
  displayLimit: number;
}

export interface ReportResult {
  title: string;
  description?: string;
  /** Always resolved, so the renderer never branches on undefined. */
  design: ResolvedDesign;
  /** Rows the report covers — the server's count for the filter, not a page size. */
  rowCount: number;
  kpis: KpiResult[];
  charts: ChartResult[];
  table?: TableResult;

  /**
   * Clauses the LLM asked for that we refused to compile (unknown field, illegal
   * operator, hallucinated enum member). Rendered, never silently dropped —
   * quietly ignoring half a request is how a report ends up confidently wrong.
   */
  omitted?: string[];
}
