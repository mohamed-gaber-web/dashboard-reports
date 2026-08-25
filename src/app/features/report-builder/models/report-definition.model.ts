import { ChartDatum } from '../../../shared/models/chart.model';
import { ChartSeries } from '../../../shared/models/series.model';
import { TableColumn } from '../../../shared/models/table-column.model';

/**
 * The **Report Definition** — the contract between the model and the app on the
 * AI Report Builder screen.
 *
 * ## What it is, and what it deliberately is not
 *
 * It is a description of a report's SHAPE: which sections, in which order, over
 * which fields, at which aggregation. It contains **no figures**. Every number
 * the user sees is computed by `ReportComposerService` against the real folded
 * D365 slice, which is why nothing on this page can be hallucinated.
 *
 * It is not HTML, CSS, an Angular template, or a component name. The renderable
 * set is a CLOSED discriminated union matched with `@switch`, because the thing
 * choosing between the branches is LLM output — an open registry would let an
 * invented string select a component.
 *
 * ## How it differs from the AI Analyst's `ReportSpec`
 *
 * The two screens exist side by side to be compared, and the difference is the
 * vocabulary, not the plumbing:
 *
 * | | `ReportSpec` (AI Analyst) | `ReportDefinition` (this) |
 * |---|---|---|
 * | density | `comfortable` / `compact` — CSS padding | `minimal` / `standard` / `detailed` — how much the report SAYS |
 * | arrangement | `chartLayout` | `layout`: executive / analytical / operational |
 * | sections | 8 kinds | 9 — adds `timeline` |
 * | charts | 5 marks | 6 — adds `pie` |
 * | insights | plain strings | claims tagged OBSERVATION vs INTERPRETATION |
 * | recommendations | plain strings | priority + the figure each rests on |
 * | narrative | a separate `write_analysis` tool | `summary`, on the definition itself |
 *
 * The last three rows are the point. A dashboard that renders "revenue fell
 * because of the site move" identically to "revenue fell 12%" has quietly
 * borrowed the authority of a measurement for a guess.
 *
 * MUST stay in sync with the `emit_report` tool schema in `api/report-builder.js`.
 */

// ── Vocabulary ──────────────────────────────────────────────────────────────

/**
 * How much the report carries — chosen by the model FROM THE QUESTION, not by a
 * settings screen. "Give me a quick summary" and "analyse why sales fell" are
 * different requests, and answering both with the same seven sections is the
 * failure this field exists to prevent.
 */
export type ReportDensity = 'minimal' | 'standard' | 'detailed';

/**
 * How the report is arranged.
 *
 * `executive` — figures and prose first, charts full width, nothing dense.
 * `analytical` — charts side by side, because two breakdowns are meant to be
 * compared. `operational` — detail rows and rankings dominate.
 */
export type ReportLayout = 'executive' | 'analytical' | 'operational';

export type MetricAggregation = 'count' | 'sum' | 'avg' | 'distinctCount';
/** Aggregations that can be plotted along an axis. `distinctCount` cannot. */
export type SeriesAggregation = 'count' | 'sum' | 'avg';

export type ValueFormatName = 'integer' | 'quantity' | 'currency' | 'percent';

/**
 * Every mark the builder can draw.
 *
 * `bar` is horizontal and single-series — right for "top N categories by one
 * measure", where category names need the room. `column` is vertical, for a
 * short axis read left to right. `line`/`area` require an ORDERED axis, and the
 * validator refuses to draw them over a nominal dimension rather than implying a
 * trend that is not there. `pie`/`donut` are parts of one whole.
 */
export type ChartKind = 'line' | 'area' | 'bar' | 'column' | 'pie' | 'donut';

/** How a date axis is bucketed. `auto` fits the grain to the span. */
export type TimeGrain = 'auto' | 'day' | 'week' | 'month' | 'quarter' | 'year';

export type FilterOperator = 'eq' | 'neq' | 'gt' | 'lt' | 'gte' | 'lte' | 'contains';

export interface FilterClause {
  field: string;
  op: FilterOperator;
  value: string | number;
}

/**
 * One measure.
 *
 * `goodDirection` is optional and stays optional: colour must never assert that
 * up is good. More backorder units is neither obviously good nor obviously bad,
 * and painting every rise green is how a dashboard starts lying.
 */
export interface MetricDefinition {
  label: string;
  agg: MetricAggregation;
  /** Required for every `agg` except `count`. Must be a field on the module. */
  field?: string;
  format?: ValueFormatName;
  goodDirection?: 'up' | 'down';
  note?: string;
}

/**
 * What kind of claim a bullet is making.
 *
 * `observation` — readable straight off the figures on this page.
 * `interpretation` — the model's reading of them.
 *
 * The renderer marks them differently, and that difference is the honesty of the
 * whole screen: an interpretation dressed as an observation is the one output a
 * grounded report must not produce.
 */
export type ClaimKind = 'observation' | 'interpretation';

export interface InsightPoint {
  text: string;
  kind: ClaimKind;
}

export type RecommendationPriority = 'high' | 'medium' | 'low';

/**
 * A proposed action. Not a measurement, and never rendered as one — `rationale`
 * names the figure it rests on so the reader can check the reasoning.
 */
export interface RecommendationPoint {
  text: string;
  priority?: RecommendationPriority;
  rationale?: string;
}

// ── Sections ────────────────────────────────────────────────────────────────

export interface MetricsSection {
  type: 'metrics';
  title?: string;
  note?: string;
  items: MetricDefinition[];
}

export interface ChartSection {
  type: 'chart';
  title: string;
  note?: string;
  chartType: ChartKind;
  /** A dimension, or a date field for a time series. */
  groupBy: string;
  agg: SeriesAggregation;
  valueField?: string;
  topN?: number;
  /** Only meaningful when `groupBy` is a date field. */
  grain?: TimeGrain;
}

export interface TableSection {
  type: 'table';
  title?: string;
  note?: string;
  columns: string[];
}

export interface RankingSection {
  type: 'ranking';
  title: string;
  note?: string;
  groupBy: string;
  agg: SeriesAggregation;
  valueField?: string;
  topN?: number;
  format?: ValueFormatName;
  /** Draw a proportional bar beside each row. On by default. */
  showBars?: boolean;
}

/** One end of a comparison. Dates are ISO `YYYY-MM-DD`, both ends inclusive. */
export interface Period {
  label: string;
  from: string;
  to: string;
}

export interface ComparisonSection {
  type: 'comparison';
  title?: string;
  note?: string;
  /** Date field the two windows are cut on. Defaults to the module's own. */
  dateField?: string;
  current: Period;
  previous: Period;
  metrics: MetricDefinition[];
}

/**
 * Period-by-period movement.
 *
 * Distinct from a line chart on purpose: a line shows the SHAPE of a series, a
 * timeline states each step's figure and how much it moved from the one before.
 * "Sales rose then fell" is a chart; "March −18%, April +4%, May +31%" is a
 * timeline, and asking "when did it change?" wants the second.
 */
export interface TimelineSection {
  type: 'timeline';
  title: string;
  note?: string;
  dateField: string;
  agg: SeriesAggregation;
  valueField?: string;
  grain?: TimeGrain;
  format?: ValueFormatName;
}

export interface TextSection {
  type: 'text';
  title?: string;
  body: string;
}

export interface InsightsSection {
  type: 'insights';
  title?: string;
  points: InsightPoint[];
}

export interface RecommendationsSection {
  type: 'recommendations';
  title?: string;
  points: RecommendationPoint[];
}

export type ReportSection =
  | MetricsSection
  | ChartSection
  | TableSection
  | RankingSection
  | ComparisonSection
  | TimelineSection
  | TextSection
  | InsightsSection
  | RecommendationsSection;

export type SectionType = ReportSection['type'];

// ── The definition ──────────────────────────────────────────────────────────

export interface ReportDefinition {
  id?: string;
  title: string;
  subtitle?: string;
  /** Two or three sentences opening the report. Also opens an exported document. */
  summary?: string;
  density?: ReportDensity;
  layout?: ReportLayout;
  filters?: FilterClause[];
  sections: ReportSection[];
  /**
   * Accepted at the top level because a model reaching for "the report's
   * insights" naturally puts them here. The validator normalises them into
   * trailing sections so there is exactly ONE render path — two places that can
   * hold the same content is two places to keep in sync, and the second is the
   * one that gets forgotten.
   */
  insights?: InsightPoint[];
  recommendations?: RecommendationPoint[];
}

export const DEFAULT_DENSITY: ReportDensity = 'standard';
export const DEFAULT_LAYOUT: ReportLayout = 'analytical';

// ── Computed result — what the renderer binds to ────────────────────────────

export type DeltaDirection = 'up' | 'down' | 'flat';
/** `good` / `bad` only when the definition said which way is up. */
export type DeltaSentiment = 'good' | 'bad' | 'neutral';

export interface ComputedMetric {
  label: string;
  /** Already formatted — currency, quantity, percent or a plain integer. */
  value: string;
  note?: string;
}

export interface ComputedChart {
  kind: ChartKind;
  title: string;
  note?: string;
  /** Category/value pairs. Populated for every chart kind. */
  data: ChartDatum[];
  /**
   * Series form of the same figures, for the multi-series components
   * (`app-line-chart`, `app-column-chart`). Index-aligned with {@link labels}.
   */
  labels?: string[];
  series?: ChartSeries[];
  /** True when the axis is chronological, so nothing may be re-sorted by value. */
  ordered?: boolean;
  /**
   * How a value is written, resolved from the measure's own `FieldMeta` and the
   * slice's dominant currency. A function because that is what the chart
   * components take — resolving it in the composer keeps the decision beside the
   * data rather than in a template.
   */
  format?: (value: number) => string;
}

export interface RankedRow {
  rank: number;
  label: string;
  value: number;
  display: string;
  /** Share of the ranked total (every group, not just the visible ones), 0–100. */
  sharePct: number;
  /** Bar width relative to the leader, 0–100. */
  widthPct: number;
}

export interface DeltaResult {
  label: string;
  current: string;
  previous: string;
  /** Signed and already formatted, e.g. `+1,204`. */
  delta: string;
  /** Percentage change, or null when the baseline is zero and a ratio is undefined. */
  deltaPercent: number | null;
  direction: DeltaDirection;
  sentiment: DeltaSentiment;
}

export interface TimelinePoint {
  label: string;
  value: number;
  display: string;
  /** Bar width relative to the largest period, 0–100. */
  widthPct: number;
  /** Change from the previous period, or null for the first (and for a zero base). */
  changePercent: number | null;
  direction: DeltaDirection;
}

/**
 * The detail table.
 *
 * `displayRows` is a capped page for rendering and must NEVER be exported as if
 * it were the whole answer — the split is in the type so a caller has to say
 * which audience it means, and the compiler catches anyone who gets it wrong.
 */
export interface TableBlockResult {
  columns: TableColumn<Record<string, unknown>>[];
  displayRows: Record<string, unknown>[];
  /** How many rows the report's filter actually matches, from `@odata.count`. */
  total: number;
  displayLimit: number;
}

/**
 * One computed section, ready to render. Discriminated by `kind` and matched
 * with `@switch` — a closed set resolved at compile time.
 */
export type ReportBlock =
  | { kind: 'metrics'; title?: string; note?: string; items: ComputedMetric[] }
  | { kind: 'chart'; title: string; note?: string; chart: ComputedChart }
  | { kind: 'table'; title?: string; note?: string; table: TableBlockResult }
  | {
      kind: 'ranking';
      title: string;
      note?: string;
      rows: RankedRow[];
      showBars: boolean;
      /** What the ranked figure measures, e.g. "Units remaining". */
      measureLabel: string;
    }
  | {
      kind: 'comparison';
      title?: string;
      note?: string;
      currentLabel: string;
      previousLabel: string;
      items: DeltaResult[];
    }
  | {
      kind: 'timeline';
      title: string;
      note?: string;
      points: TimelinePoint[];
      measureLabel: string;
    }
  | { kind: 'text'; title?: string; body: string }
  | { kind: 'insights'; title?: string; points: InsightPoint[] }
  | { kind: 'recommendations'; title?: string; points: RecommendationPoint[] };

export type BlockKind = ReportBlock['kind'];

export interface ComposedReport {
  title: string;
  subtitle?: string;
  summary?: string;
  /** Always resolved, so the renderer never branches on undefined. */
  density: ReportDensity;
  layout: ReportLayout;
  /** Rows the report covers — the server's count for its filter, not a page size. */
  rowCount: number;
  blocks: ReportBlock[];
  /**
   * Clauses the validator refused or rewrote (unknown field, summing a
   * dimension, a line chart over sites). Rendered, never swallowed: a report
   * that quietly answers half the question is worse than one that says so.
   */
  issues: string[];
}
