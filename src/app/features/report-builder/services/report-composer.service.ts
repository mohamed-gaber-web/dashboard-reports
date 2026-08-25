import { Injectable } from '@angular/core';
import { Cube, GroupTotal } from '../../../core/aggregation/aggregate-plan.model';
import { cubeTopN } from '../../../core/aggregation/aggregation.service';
import { ChartDatum } from '../../../shared/models/chart.model';
import { TableColumn } from '../../../shared/models/table-column.model';
import {
  formatCurrency,
  formatDate,
  formatInteger,
  formatPercent,
  formatQuantity,
  percentOf,
} from '../../../shared/utils/format.util';
import { AnalystSource } from '../../ai-analyst/models/analyst-source.model';
import { FieldMeta, ValueFormat } from '../../ai-analyst/models/field-meta.model';
import { rollUp, windowTotals } from '../../ai-analyst/services/time-buckets';
import {
  ChartSection,
  ComparisonSection,
  ComposedReport,
  ComputedChart,
  ComputedMetric,
  DEFAULT_DENSITY,
  DEFAULT_LAYOUT,
  DeltaDirection,
  DeltaResult,
  MetricDefinition,
  MetricsSection,
  RankedRow,
  RankingSection,
  ReportBlock,
  ReportDefinition,
  ReportSection,
  TableBlockResult,
  TableSection,
  TimelinePoint,
  TimelineSection,
  ValueFormatName,
} from '../models/report-definition.model';
import { sliceCapFor, validateDefinition } from './report-definition.validator';

type Row = Record<string, unknown>;

/** Row cap for the RENDERED table. Exports must never be built from this. */
export const TABLE_DISPLAY_LIMIT = 100;

/** How many periods a timeline lists before the list is the problem. */
const MAX_TIMELINE_POINTS = 24;

/** Everything the composer needs to turn a definition into real figures. */
export interface ComposeContext {
  source: AnalystSource;
  /** The folded slice — the only source of SUM and GROUP BY. */
  cube: Cube;
  /** Exact row count for the report's own filter, from `@odata.count`. */
  total: number;
  /** One page of real rows for the detail table. */
  tableRows: Row[];
  /** Issues raised before composition (rejected filters, coverage limits). */
  issues?: string[];
}

/**
 * Computes a {@link ReportDefinition} into a {@link ComposedReport}.
 *
 * **Every number here comes from the data.** The model chose which figures to
 * show; it did not supply one. That is the contract the whole screen rests on,
 * and it is why an AI-composed report can be trusted enough to export.
 *
 * Where the figures come from is worth knowing, because it is not what a
 * dashboard usually does. D365 F&O OData has no `$apply`, no `groupby` and no
 * `SUM`, and these entities reach ~11M rows, so there is no array to scan. It
 * reads a {@link Cube} — group totals pre-folded in a Worker, including per-day
 * buckets for every date field — plus the exact `@odata.count`. Both cover the
 * complete filtered slice, so the figures are *right*, not merely fast.
 *
 * The composer holds no presentation: it emits formatted values and geometry
 * (`widthPct`, `sharePct`), and the renderers draw them. Deciding whether a
 * clause is legal at all belongs one layer up, in
 * `report-definition.validator.ts`.
 */
@Injectable({ providedIn: 'root' })
export class ReportComposerService {
  compose(raw: unknown, ctx: ComposeContext): ComposedReport {
    const { definition, issues } = validateDefinition(raw, ctx.source);
    const all = [...(ctx.issues ?? []), ...issues];

    if (!definition) {
      return {
        title: 'No report',
        density: DEFAULT_DENSITY,
        layout: DEFAULT_LAYOUT,
        rowCount: ctx.total,
        blocks: [],
        issues: all,
      };
    }

    return this.composeValidated(definition, ctx, all);
  }

  /**
   * Compose an ALREADY-validated definition.
   *
   * Split out because the page validates first — it has to know `needsTotals`
   * before it can decide whether to spend thirty seconds folding the slice — and
   * validating twice would report every issue twice.
   */
  composeValidated(
    definition: ReportDefinition,
    ctx: ComposeContext,
    issues: string[] = [],
  ): ComposedReport {
    const fields = new Map(ctx.source.fields.map((f) => [f.key, f]));
    const currency = this.currencyOf(ctx);
    const collected = [...issues];

    const blocks: ReportBlock[] = [];
    for (const section of definition.sections) {
      const block = this.build(section, ctx, fields, currency, collected);
      if (block) blocks.push(block);
    }

    return {
      title: definition.title,
      subtitle: definition.subtitle,
      summary: definition.summary,
      density: definition.density ?? DEFAULT_DENSITY,
      layout: definition.layout ?? DEFAULT_LAYOUT,
      rowCount: ctx.total,
      blocks,
      issues: collected,
    };
  }

  private build(
    section: ReportSection,
    ctx: ComposeContext,
    fields: Map<string, FieldMeta>,
    currency: string | undefined,
    issues: string[],
  ): ReportBlock | null {
    switch (section.type) {
      case 'metrics':
        return this.buildMetrics(section, ctx, currency);
      case 'chart':
        return this.buildChart(section, ctx, fields, currency);
      case 'table':
        return this.buildTable(section, ctx, fields, currency);
      case 'ranking':
        return this.buildRanking(section, ctx, fields, currency);
      case 'comparison':
        return this.buildComparison(section, ctx, currency, issues);
      case 'timeline':
        return this.buildTimeline(section, ctx, fields, currency, issues);
      case 'text':
        return { kind: 'text', title: section.title, body: section.body };
      case 'insights':
        return { kind: 'insights', title: section.title, points: section.points };
      case 'recommendations':
        return { kind: 'recommendations', title: section.title, points: section.points };
    }
  }

  // ── Metrics ──────────────────────────────────────────────────────────────

  private buildMetrics(
    section: MetricsSection,
    ctx: ComposeContext,
    currency: string | undefined,
  ): ReportBlock {
    const items: ComputedMetric[] = section.items.map((m) => ({
      label: m.label,
      value: this.writeNumber(this.metricValue(m, ctx), m.format, currency),
      note: m.note,
    }));
    return { kind: 'metrics', title: section.title, note: section.note, items };
  }

  private metricValue(metric: MetricDefinition, ctx: ComposeContext): number {
    switch (metric.agg) {
      case 'count':
        // The exact server count. No rows were read to get this.
        return ctx.total;
      case 'sum':
        return ctx.cube.totals[metric.field ?? '']?.sum ?? 0;
      case 'avg': {
        const t = ctx.cube.totals[metric.field ?? ''];
        return t && t.count ? t.sum / t.count : 0;
      }
      case 'distinctCount':
        // The cube holds every key of a dimension, so this is exact, not sampled.
        return Object.keys(ctx.cube.dims[metric.field ?? ''] ?? {}).length;
    }
  }

  // ── Charts ───────────────────────────────────────────────────────────────

  private buildChart(
    section: ChartSection,
    ctx: ComposeContext,
    fields: Map<string, FieldMeta>,
    currency: string | undefined,
  ): ReportBlock {
    const meta = fields.get(section.groupBy);
    const format = this.chartFormat(section, fields, currency);

    const chart =
      meta?.type === 'date'
        ? this.timeChart(section, ctx, format)
        : this.categoryChart(section, ctx.cube, format);

    return { kind: 'chart', title: section.title, note: section.note, chart };
  }

  /**
   * A nominal breakdown: top-N categories with an exact "Other" tail.
   *
   * The cube holds EVERY key, so "Other" is a real total rather than an estimate
   * over a truncated top-N — which is the difference between a chart that adds
   * up and one that nearly does.
   */
  private categoryChart(
    section: ChartSection,
    cube: Cube,
    format: (value: number) => string,
  ): ComputedChart {
    const cap = sliceCapFor(section.chartType);
    const topN = Math.min(section.topN ?? cap, cap);
    const bucket = cube.dims[section.groupBy];

    const base: ComputedChart = {
      kind: section.chartType,
      title: section.title,
      note: section.note,
      data: [],
      format,
    };
    if (!bucket) return base;

    if (section.agg === 'avg') {
      // `cubeTopN` cannot express a mean, so it is folded here from each group's
      // own totals. Sum AND count are kept per group so the "Other" bucket is a
      // COUNT-WEIGHTED average — a plain mean-of-means would let a one-row group
      // and a ten-thousand-row group count equally.
      const measure = section.valueField ?? '';
      const groups = (Object.entries(bucket) as [string, GroupTotal][])
        .map(([label, g]) => ({ label, sum: g.sums[measure] ?? 0, count: g.count }))
        .sort((a, b) => (b.count ? b.sum / b.count : 0) - (a.count ? a.sum / a.count : 0));

      const mean = (x: { label: string; sum: number; count: number }): ChartDatum => ({
        label: x.label,
        value: x.count ? x.sum / x.count : 0,
      });

      if (groups.length > topN) {
        const head = groups.slice(0, topN - 1);
        const tail = groups.slice(topN - 1);
        const tailSum = tail.reduce((s, g) => s + g.sum, 0);
        const tailCount = tail.reduce((s, g) => s + g.count, 0);
        base.data = [...head.map(mean), { label: 'Other', value: tailCount ? tailSum / tailCount : 0 }];
      } else {
        base.data = groups.map(mean);
      }
    } else {
      base.data = cubeTopN(
        cube,
        section.groupBy,
        section.agg === 'count' ? undefined : section.valueField,
        topN,
      );
    }

    return this.withSeries(base);
  }

  /**
   * A trend: the cube's per-day buckets rolled up to the requested grain.
   *
   * Chronological and gap-filled, so a month with no rows is a zero rather than
   * a point the line steps straight over — which is the difference between
   * "sales stopped in March" and "sales were flat". Nothing is re-sorted by
   * value; that is what separates a trend from a ranking.
   */
  private timeChart(
    section: ChartSection,
    ctx: ComposeContext,
    format: (value: number) => string,
  ): ComputedChart {
    const measures = ctx.source.fields.filter((f) => f.measure).map((f) => f.key);
    const { buckets, truncated, grain } = rollUp(
      ctx.cube.dims[section.groupBy],
      section.grain,
      measures,
    );

    const data: ChartDatum[] = buckets.map((b) => ({
      label: b.label,
      value: this.bucketValue(b, section.agg, section.valueField),
    }));

    const notes = [section.note];
    if (truncated) {
      notes.push(`Most recent ${buckets.length} of ${buckets.length + truncated} ${grain}s.`);
    }

    return this.withSeries({
      kind: section.chartType,
      title: section.title,
      data,
      ordered: true,
      note: notes.filter(Boolean).join(' · ') || undefined,
      format,
    });
  }

  /**
   * Add the series form the multi-series components need.
   *
   * `app-line-chart` and `app-column-chart` plot `labels` + `ChartSeries[]`,
   * while `app-bar-chart` and `app-donut-chart` take `ChartDatum[]`. Carrying
   * both means the renderer picks a component without reshaping data inside a
   * template — which is exactly the logic a View must not hold.
   */
  private withSeries(chart: ComputedChart): ComputedChart {
    if (chart.kind !== 'line' && chart.kind !== 'area' && chart.kind !== 'column') return chart;
    return {
      ...chart,
      labels: chart.data.map((d) => d.label),
      series: [{ label: chart.title, values: chart.data.map((d) => d.value) }],
    };
  }

  private chartFormat(
    section: ChartSection,
    fields: Map<string, FieldMeta>,
    currency: string | undefined,
  ): (value: number) => string {
    if (section.agg === 'count') return formatInteger;
    const format = section.valueField ? fields.get(section.valueField)?.format : undefined;
    return (value) => this.writeNumber(value, asFormatName(format), currency);
  }

  // ── Ranking ──────────────────────────────────────────────────────────────

  /**
   * A ranked list — the answer to "what are my top products?".
   *
   * It states all three facts a ranking question asks for: POSITION, FIGURE and
   * SHARE. A bar chart alone only implies the first and shows the third not at
   * all. The share is of every group, not of the visible rows: "34% of total"
   * has to mean of the total, or the number is worse than useless.
   */
  private buildRanking(
    section: RankingSection,
    ctx: ComposeContext,
    fields: Map<string, FieldMeta>,
    currency: string | undefined,
  ): ReportBlock {
    const bucket = ctx.cube.dims[section.groupBy] ?? {};
    const measure = section.valueField ?? '';

    const ranked = (Object.entries(bucket) as [string, GroupTotal][])
      .map(([label, g]) => ({
        label,
        value: this.bucketValue({ count: g.count, sums: g.sums }, section.agg, section.valueField),
      }))
      .sort((a, b) => b.value - a.value);

    const grandTotal = ranked.reduce((sum, r) => sum + r.value, 0);
    const top = ranked.slice(0, section.topN ?? 10);
    const leader = top.length ? Math.max(...top.map((r) => Math.abs(r.value)), 1) : 1;

    const rows: RankedRow[] = top.map((r, i) => ({
      rank: i + 1,
      label: r.label,
      value: r.value,
      display: this.writeNumber(r.value, section.format, currency),
      sharePct: percentOf(r.value, grandTotal),
      widthPct: Math.max(2, Math.round((Math.abs(r.value) / leader) * 100)),
    }));

    const notes = [section.note];
    if (ranked.length > rows.length) {
      notes.push(`Top ${rows.length} of ${ranked.length.toLocaleString()}.`);
    }

    return {
      kind: 'ranking',
      title: section.title,
      note: notes.filter(Boolean).join(' · ') || undefined,
      rows,
      showBars: section.showBars !== false,
      measureLabel: this.measureLabel(section.agg, measure, fields),
    };
  }

  // ── Comparison ───────────────────────────────────────────────────────────

  /**
   * Two windows of the same measures, side by side.
   *
   * Both are cut from the cube's per-day buckets, which makes both exact — and
   * also means both must be INSIDE the report's own filter. When the earlier
   * window is empty the block says so, rather than reporting a −100% fall that
   * is really a filter artefact.
   */
  private buildComparison(
    section: ComparisonSection,
    ctx: ComposeContext,
    currency: string | undefined,
    issues: string[],
  ): ReportBlock | null {
    const days = ctx.cube.dims[section.dateField ?? ''];
    if (!days || !Object.keys(days).length) {
      issues.push(
        `“${section.title ?? 'Comparison'}” needs the slice to be totalled before two periods can be measured.`,
      );
      return null;
    }

    const current = windowTotals(days, section.current.from, section.current.to);
    const previous = windowTotals(days, section.previous.from, section.previous.to);

    const items = section.metrics.map((m) => this.compareMetric(m, current, previous, currency));

    const notes = [section.note];
    if (!previous.count) {
      notes.push(
        `No rows fall in ${section.previous.label} under this report’s filter, so the change is measured against nothing.`,
      );
    } else if (!current.count) {
      notes.push(`No rows fall in ${section.current.label} under this report’s filter.`);
    }

    return {
      kind: 'comparison',
      title: section.title,
      note: notes.filter(Boolean).join(' · ') || undefined,
      currentLabel: section.current.label,
      previousLabel: section.previous.label,
      items,
    };
  }

  private compareMetric(
    metric: MetricDefinition,
    current: { count: number; sums: Record<string, number> },
    previous: { count: number; sums: Record<string, number> },
    currency: string | undefined,
  ): DeltaResult {
    // `distinctCount` never reaches here — the validator drops it from a
    // comparison, because the cube keeps per-day counts and sums but not the
    // identity of the values behind them.
    const agg = metric.agg === 'sum' || metric.agg === 'avg' ? metric.agg : 'count';
    const read = (w: { count: number; sums: Record<string, number> }): number =>
      this.bucketValue(w, agg, metric.field);

    const now = read(current);
    const then = read(previous);
    const delta = now - then;
    const direction = this.directionOf(delta);

    return {
      label: metric.label,
      current: this.writeNumber(now, metric.format, currency),
      previous: this.writeNumber(then, metric.format, currency),
      delta: `${delta > 0 ? '+' : delta < 0 ? '−' : ''}${this.writeNumber(Math.abs(delta), metric.format, currency)}`,
      // A ratio against zero is undefined — not infinite, and certainly not 100%.
      deltaPercent: then === 0 ? null : Math.round((delta / Math.abs(then)) * 1000) / 10,
      direction,
      sentiment: this.sentimentOf(direction, metric.goodDirection),
    };
  }

  // ── Timeline ─────────────────────────────────────────────────────────────

  /**
   * Period-by-period movement, with the step change at each point.
   *
   * Deliberately not a line chart. A line shows the SHAPE of a series and leaves
   * the reader to estimate each move; a timeline states the figure and the
   * change. "When did it turn?" is answered by the second and only hinted at by
   * the first.
   */
  private buildTimeline(
    section: TimelineSection,
    ctx: ComposeContext,
    fields: Map<string, FieldMeta>,
    currency: string | undefined,
    issues: string[],
  ): ReportBlock | null {
    const days = ctx.cube.dims[section.dateField];
    if (!days || !Object.keys(days).length) {
      issues.push(
        `Timeline “${section.title}” needs the slice to be totalled before its periods can be measured.`,
      );
      return null;
    }

    const measures = ctx.source.fields.filter((f) => f.measure).map((f) => f.key);
    const { buckets, truncated, grain } = rollUp(days, section.grain, measures);

    const values = buckets.map((b) => this.bucketValue(b, section.agg, section.valueField));
    // Newest first: a timeline is read from "now" backwards, and the recent end
    // is what a question about change is nearly always about.
    const shown = values.length > MAX_TIMELINE_POINTS ? values.slice(-MAX_TIMELINE_POINTS) : values;
    const shownBuckets = buckets.slice(buckets.length - shown.length);
    const peak = Math.max(...shown.map(Math.abs), 1);

    const points: TimelinePoint[] = shownBuckets
      .map((b, i) => {
        const value = shown[i];
        // `previous` reaches back into the FULL series, so the oldest visible
        // period still knows what it moved from when there is an earlier one.
        const priorIndex = buckets.length - shown.length + i - 1;
        const previous = priorIndex >= 0 ? values[priorIndex] : null;
        const change = previous === null || previous === 0 ? null : (value - previous) / Math.abs(previous);

        return {
          label: b.label,
          value,
          display: this.writeNumber(value, section.format, currency),
          widthPct: Math.max(2, Math.round((Math.abs(value) / peak) * 100)),
          changePercent: change === null ? null : Math.round(change * 1000) / 10,
          direction: previous === null ? ('flat' as DeltaDirection) : this.directionOf(value - previous),
        };
      })
      .reverse();

    const dropped = truncated + (values.length - shown.length);
    const notes = [section.note];
    if (dropped) notes.push(`Most recent ${points.length} of ${points.length + dropped} ${grain}s.`);

    return {
      kind: 'timeline',
      title: section.title,
      note: notes.filter(Boolean).join(' · ') || undefined,
      points,
      measureLabel: this.measureLabel(section.agg, section.valueField ?? '', fields),
    };
  }

  // ── Table ────────────────────────────────────────────────────────────────

  private buildTable(
    section: TableSection,
    ctx: ComposeContext,
    fields: Map<string, FieldMeta>,
    currency: string | undefined,
  ): ReportBlock {
    const columns: TableColumn<Row>[] = section.columns.map((key) => {
      const meta = fields.get(key);
      return {
        key,
        header: meta?.label ?? key,
        align: meta?.type === 'number' ? 'right' : 'left',
        format: (value) => this.writeValue(value, meta?.format, currency),
      };
    });

    const table: TableBlockResult = {
      columns,
      displayRows: ctx.tableRows.slice(0, TABLE_DISPLAY_LIMIT),
      total: ctx.total,
      displayLimit: TABLE_DISPLAY_LIMIT,
    };

    return { kind: 'table', title: section.title, note: section.note, table };
  }

  // ── Shared arithmetic ────────────────────────────────────────────────────

  /** One aggregation over one bucket of counts and measure sums. */
  private bucketValue(
    bucket: { count: number; sums: Record<string, number> },
    agg: 'count' | 'sum' | 'avg',
    measure: string | undefined,
  ): number {
    if (agg === 'count') return bucket.count;
    const sum = bucket.sums[measure ?? ''] ?? 0;
    return agg === 'avg' ? (bucket.count ? sum / bucket.count : 0) : sum;
  }

  private directionOf(delta: number): DeltaDirection {
    return delta > 0 ? 'up' : delta < 0 ? 'down' : 'flat';
  }

  /**
   * Whether a move should be coloured.
   *
   * Only when the definition said which way is up. A dashboard that paints every
   * rise green is asserting that more of everything is better, which for
   * backorder units or overdue lines is exactly backwards.
   */
  private sentimentOf(
    direction: DeltaDirection,
    good: 'up' | 'down' | undefined,
  ): DeltaResult['sentiment'] {
    if (!good || direction === 'flat') return 'neutral';
    return direction === good ? 'good' : 'bad';
  }

  private measureLabel(
    agg: 'count' | 'sum' | 'avg',
    measure: string,
    fields: Map<string, FieldMeta>,
  ): string {
    if (agg === 'count') return 'Rows';
    return `${agg === 'avg' ? 'Avg ' : ''}${fields.get(measure)?.label ?? measure}`;
  }

  // ── Formatting ───────────────────────────────────────────────────────────

  /**
   * The currency to write figures in.
   *
   * Read from the module's own `currencyField` and the cube's dominant value — a
   * module without one (Shatat has no currency column) simply has no currency,
   * rather than a hardcoded field name that scans the whole dataset to find
   * nothing.
   */
  private currencyOf(ctx: ComposeContext): string | undefined {
    const field = ctx.source.currencyField;
    if (!field) return undefined;

    const bucket = ctx.cube.dims[field];
    if (bucket) {
      const dominant = (Object.entries(bucket) as [string, GroupTotal][]).sort(
        (a, b) => b[1].count - a[1].count,
      )[0];
      if (dominant) return dominant[0];
    }
    return ctx.tableRows.length ? String(ctx.tableRows[0][field] ?? '') || undefined : undefined;
  }

  private writeNumber(
    value: number,
    format: ValueFormatName | undefined,
    currency: string | undefined,
  ): string {
    if (format === 'currency') return formatCurrency(value, currency);
    if (format === 'percent') return formatPercent(value);
    if (format === 'quantity') return formatQuantity(value);
    return formatInteger(value);
  }

  private writeValue(
    value: unknown,
    format: ValueFormat | undefined,
    currency: string | undefined,
  ): string {
    switch (format) {
      case 'date':
        return formatDate(value as string | undefined);
      case 'currency':
        return formatCurrency(Number(value), currency);
      case 'percent':
        return formatPercent(Number(value));
      case 'quantity':
        return formatQuantity(Number(value));
      case 'integer':
        return formatInteger(Number(value));
      default:
        return value == null || value === '' ? '—' : String(value);
    }
  }
}

/** `FieldMeta.format` narrowed to the four a figure can be written in. */
function asFormatName(format: ValueFormat | undefined): ValueFormatName | undefined {
  return format === 'integer' || format === 'quantity' || format === 'currency' || format === 'percent'
    ? format
    : undefined;
}
