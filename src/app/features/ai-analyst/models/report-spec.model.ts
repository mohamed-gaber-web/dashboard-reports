import { ChartDatum, paletteColor } from '../../../shared/models/chart.model';
import { ChartSeries } from '../../../shared/models/series.model';
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

/**
 * Every mark the report can draw.
 *
 * `bar` is horizontal and single-series — the right form for "top N categories
 * by one measure", where the category names need the horizontal room. `column`
 * is vertical, for a category axis read left-to-right. `line`/`area` are for an
 * ORDERED axis (time), and the engine refuses to draw them over a nominal
 * dimension rather than implying a trend that isn't there.
 */
export type ReportChartType = 'bar' | 'column' | 'line' | 'area' | 'donut';

/** How a date axis is bucketed. `auto` fits the grain to the span. */
export type TimeGrain = 'auto' | 'day' | 'week' | 'month' | 'quarter' | 'year';

/** Legacy single-shape chart clause. Still accepted; normalised into a section. */
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

// ── Sections: what makes the report's SHAPE dynamic ─────────────────────────
//
// The old spec was `{kpis, charts, table}` — three fixed slots in a fixed order,
// so every answer came out as the same dashboard whatever was asked. A spec is
// now an ORDERED LIST of sections, and the model picks which kinds appear, how
// many, and in what order. "Top 10 products" can be a ranking and nothing else;
// "why did sales fall" can be prose, three metrics and a trend line.
//
// The union is CLOSED and discriminated by `type`. Nothing outside this
// vocabulary can reach the renderer: `report-plan.ts` drops an unknown `type`
// the same way `SpecCompilerService` drops an invented field.

export type SectionType =
  | 'metrics'
  | 'chart'
  | 'comparison'
  | 'ranking'
  | 'table'
  | 'text'
  | 'insights'
  | 'recommendations';

/** Headline figures. One row of stats — not a dashboard in its own right. */
export interface MetricsSectionSpec {
  type: 'metrics';
  title?: string;
  items: KpiSpec[];
}

export interface ChartSectionSpec {
  type: 'chart';
  title: string;
  chartType: ReportChartType;
  /** A dimension, or a date field for a time series. */
  groupBy: string;
  agg: ChartAggregation;
  valueField?: string;
  topN?: number;
  /** Only meaningful when `groupBy` is a date field. */
  grain?: TimeGrain;
  /** One line of context under the chart title. */
  note?: string;
}

/** One end of a comparison. Dates are ISO `YYYY-MM-DD`, both ends inclusive. */
export interface PeriodSpec {
  label: string;
  from: string;
  to: string;
}

export interface ComparisonMetricSpec extends KpiSpec {
  /**
   * Whether a rise is an improvement. Omitted = no judgement is rendered, which
   * is the honest default: more backorder units is not obviously good or bad,
   * and painting every increase green is how a dashboard starts lying.
   */
  higherIsBetter?: boolean;
}

export interface ComparisonSectionSpec {
  type: 'comparison';
  title?: string;
  /** Date field the two windows are cut on. Defaults to the source's own. */
  dateField?: string;
  current: PeriodSpec;
  previous: PeriodSpec;
  metrics: ComparisonMetricSpec[];
  note?: string;
}

export interface RankingSectionSpec {
  type: 'ranking';
  title: string;
  groupBy: string;
  agg: ChartAggregation;
  valueField?: string;
  topN?: number;
  /** Draw a bar beside each row. On by default — a rank without a scale is a list. */
  chart?: boolean;
  format?: ValueFormat;
  note?: string;
}

export interface TableSectionSpec {
  type: 'table';
  title?: string;
  columns: string[];
}

export interface TextSectionSpec {
  type: 'text';
  title?: string;
  body: string;
}

/**
 * Insights and recommendations. They differ in how they are presented, and in
 * what they claim: an insight reads the data, a recommendation proposes an act.
 *
 * The field is `points`, not `items`, because `items` already means "an array of
 * metric objects" on a metrics section — and the tool schema is one flat object
 * with a `type` discriminator, so a name cannot carry two shapes.
 */
export interface ListSectionSpec {
  type: 'insights' | 'recommendations';
  title?: string;
  points: string[];
}

export type ReportSection =
  | MetricsSectionSpec
  | ChartSectionSpec
  | ComparisonSectionSpec
  | RankingSectionSpec
  | TableSectionSpec
  | TextSectionSpec
  | ListSectionSpec;

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
 * The report the LLM designs. The app computes it against the real, local
 * dataset — the model never returns numbers, only the report's shape.
 *
 * `sections` is the shape that makes a report dynamic. `kpis` / `charts` /
 * `table` are the original fixed triple: still accepted so a spec written
 * before this change (or echoed back by a model that remembered the old form)
 * still renders, and normalised into sections by `report-plan.ts`.
 */
export interface ReportSpec {
  title: string;
  description?: string;
  filters?: FilterSpec[];
  /** The report's body, in the order it is read. */
  sections?: ReportSection[];
  /** @deprecated Legacy fixed slots. Normalised into `sections`. */
  kpis?: KpiSpec[];
  /** @deprecated Legacy fixed slots. Normalised into `sections`. */
  charts?: ChartSpec[];
  /** @deprecated Legacy fixed slots. Normalised into `sections`. */
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
  type: ReportChartType;
  title: string;
  /** Category/value pairs. Populated for every chart type. */
  data: ChartDatum[];
  /**
   * Series form of the same figures, for the multi-series components
   * (`app-line-chart`, `app-column-chart`). Index-aligned with {@link labels}.
   */
  labels?: string[];
  series?: ChartSeries[];
  /** True when the axis is chronological, so nothing may be re-sorted by value. */
  ordered?: boolean;
  note?: string;
  /**
   * How a value is written — currency, quantity or a plain integer, resolved
   * against the measure's own `FieldMeta` and the slice's dominant currency.
   *
   * A function rather than a format name because that is what the chart
   * components take, and because the same convention already carries
   * `TableColumn.format`. Resolving it in the engine keeps the decision beside
   * the data instead of in a template.
   */
  format?: (value: number) => string;
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

/** One row of a ranking, already positioned and formatted. */
export interface RankingRow {
  rank: number;
  label: string;
  value: number;
  display: string;
  /** Share of the ranked total, 0–100. */
  sharePct: number;
  /** Bar width relative to the leader, 0–100. */
  widthPct: number;
}

export type DeltaDirection = 'up' | 'down' | 'flat';

/** One metric, measured over two periods. */
export interface ComparisonResult {
  label: string;
  current: string;
  previous: string;
  /** Signed, already formatted (e.g. `+1,204`). */
  delta: string;
  /** Percentage change, or null when the baseline is zero and a ratio is undefined. */
  deltaPercent: number | null;
  direction: DeltaDirection;
  /** `good` / `bad` only when the spec said which way is up. */
  sentiment: 'good' | 'bad' | 'neutral';
}

/**
 * One computed section, ready to render.
 *
 * Discriminated by `kind`, matched with `@switch` in the renderer — a CLOSED
 * set resolved at compile time, so no model-authored string can select a
 * component.
 */
export type ReportBlock =
  | { kind: 'metrics'; title?: string; items: KpiResult[] }
  | { kind: 'chart'; chart: ChartResult }
  | {
      kind: 'comparison';
      title?: string;
      note?: string;
      /** What the two columns are called, e.g. "Q2 2025" and "Q1 2025". */
      currentLabel: string;
      previousLabel: string;
      items: ComparisonResult[];
    }
  | {
      kind: 'ranking';
      title: string;
      note?: string;
      rows: RankingRow[];
      chart: boolean;
      /** What the ranked figure measures, e.g. "Units remaining". */
      measureLabel: string;
    }
  | { kind: 'table'; title?: string; table: TableResult }
  | { kind: 'text'; title?: string; body: string }
  | { kind: 'list'; variant: 'insights' | 'recommendations'; title?: string; items: string[] };

export interface ReportResult {
  title: string;
  description?: string;
  /** Always resolved, so the renderer never branches on undefined. */
  design: ResolvedDesign;
  /** Rows the report covers — the server's count for the filter, not a page size. */
  rowCount: number;
  /** The report body, in the order the model asked for. */
  blocks?: ReportBlock[];

  /**
   * Flattened projections of {@link blocks}, kept because the data exports read
   * them: the Excel summary sheet is the KPIs, the data sheet is the table. They
   * are derived by the engine, never a second source of truth.
   */
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
