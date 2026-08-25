import { Injectable } from '@angular/core';
import { ChartDatum } from '../../../shared/models/chart.model';
import { TableColumn } from '../../../shared/models/table-column.model';
import { Cube, GroupTotal } from '../../../core/aggregation/aggregate-plan.model';
import { cubeTopN } from '../../../core/aggregation/aggregation.service';
import {
  formatCurrency,
  formatDate,
  formatInteger,
  formatPercent,
  formatQuantity,
  percentOf,
} from '../../../shared/utils/format.util';
import { AnalystSource } from '../models/analyst-source.model';
import { FieldMeta, ValueFormat } from '../models/field-meta.model';
import {
  ChartResult,
  ChartSectionSpec,
  ComparisonResult,
  ComparisonSectionSpec,
  DEFAULT_DESIGN,
  DeltaDirection,
  KpiResult,
  KpiSpec,
  MetricsSectionSpec,
  RankingRow,
  RankingSectionSpec,
  ReportBlock,
  ReportPalette,
  ReportResult,
  ReportSection,
  ReportSpec,
  ResolvedDesign,
  TableResult,
  TableSectionSpec,
  reportColor,
} from '../models/report-spec.model';
import { planReport } from './report-plan';
import { rollUp, windowTotals } from './time-buckets';

type Row = Record<string, unknown>;

/** Row cap for the RENDERED table. Exports must never be built from this. */
export const TABLE_DISPLAY_LIMIT = 100;

/** Everything needed to turn a spec into a result. */
export interface ComputeContext {
  source: AnalystSource;
  /** The folded slice — the only source of SUM / GROUP BY. */
  cube: Cube;
  /** Exact row count for the report's filter, from `@odata.count`. */
  total: number;
  /** One page of real rows for the detail table. */
  tableRows: Row[];
  /** Clauses the compiler refused. Carried through so the UI can show them. */
  omitted?: string[];
}

/**
 * Computes a {@link ReportSpec} into a {@link ReportResult}.
 *
 * Every number comes from the data, never from the LLM — that contract is the
 * whole point of the feature and is unchanged. What changed is the SHAPE of
 * what comes out: the engine used to produce a fixed triple (KPIs, charts, a
 * table) whatever was asked, so every answer was the same dashboard. It now
 * produces an ordered list of {@link ReportBlock}s, one per section the model
 * designed, and the renderer draws them in that order.
 *
 * Where the data is read is also unusual and worth knowing. The old engine took
 * a `Row[]` and scanned it once per KPI. That only worked because the array was
 * secretly truncated to 5,000 rows; at the entity's real size (~11M) there is no
 * array to scan. So it reads a {@link Cube} — a pre-folded set of group totals,
 * now including per-day buckets for every date field — plus the exact
 * `@odata.count`. Both cover the complete filtered slice, so the figures are
 * right rather than merely fast.
 */
@Injectable({ providedIn: 'root' })
export class ReportEngineService {
  compute(spec: ReportSpec, ctx: ComputeContext): ReportResult {
    const { source, total } = ctx;
    const fieldMap = new Map(source.fields.map((f) => [f.key, f]));
    const currency = this.currencyOf(ctx);
    const design = this.resolveDesign(spec);

    const plan = planReport(spec, source);
    const omitted = [...(ctx.omitted ?? []), ...plan.omitted];

    const blocks: ReportBlock[] = [];
    for (const section of plan.sections) {
      const block = this.build(section, ctx, fieldMap, design.palette, currency, omitted);
      if (block) blocks.push(block);
    }

    // Flattened views of the same blocks, for the data exports. Derived here so
    // there is exactly one computation behind both the screen and the workbook.
    const kpis = blocks.flatMap((b) => (b.kind === 'metrics' ? b.items : []));
    const charts = blocks.flatMap((b) => (b.kind === 'chart' ? [b.chart] : []));
    const table = blocks.find((b) => b.kind === 'table')?.table;

    return {
      title: spec.title,
      description: spec.description,
      design,
      rowCount: total,
      blocks,
      kpis,
      charts,
      table,
      omitted: omitted.length ? omitted : undefined,
    };
  }

  private build(
    section: ReportSection,
    ctx: ComputeContext,
    fieldMap: Map<string, FieldMeta>,
    palette: ReportPalette,
    currency: string | undefined,
    omitted: string[],
  ): ReportBlock | null {
    switch (section.type) {
      case 'metrics':
        return this.buildMetrics(section, ctx, currency);
      case 'chart':
        return {
          kind: 'chart',
          chart: this.buildChart(section, ctx, fieldMap, palette, currency),
        };
      case 'comparison':
        return this.buildComparison(section, ctx, currency, omitted);
      case 'ranking':
        return this.buildRanking(section, ctx, fieldMap, currency);
      case 'table':
        return this.buildTableBlock(section, ctx, fieldMap, currency);
      case 'text':
        return { kind: 'text', title: section.title, body: section.body };
      case 'insights':
      case 'recommendations':
        return {
          kind: 'list',
          variant: section.type,
          title: section.title,
          items: section.points,
        };
    }
  }

  // ── Design ───────────────────────────────────────────────────────────────

  /**
   * Fill in the design defaults, and drop anything outside the vocabulary.
   *
   * The model is asked for closed enums, but a spec is model output: an
   * unrecognised value falls back to the default rather than reaching a
   * template as an unknown class name. Same principle as the filter compiler —
   * validate at the seam where model output becomes app behaviour.
   */
  private resolveDesign(spec: ReportSpec): ResolvedDesign {
    const d = spec.design ?? {};
    return {
      density: d.density === 'compact' ? 'compact' : DEFAULT_DESIGN.density,
      palette:
        d.palette === 'brand' || d.palette === 'accent' ? d.palette : DEFAULT_DESIGN.palette,
      chartLayout:
        d.chartLayout === 'stacked' || d.chartLayout === 'grid'
          ? d.chartLayout
          : DEFAULT_DESIGN.chartLayout,
    };
  }

  // ── Metrics ──────────────────────────────────────────────────────────────

  private buildMetrics(
    section: MetricsSectionSpec,
    ctx: ComputeContext,
    currency: string | undefined,
  ): ReportBlock {
    return {
      kind: 'metrics',
      title: section.title,
      items: section.items.map((k) => this.computeKpi(k, ctx.cube, ctx.total, currency)),
    };
  }

  private computeKpi(
    spec: KpiSpec,
    cube: Cube,
    total: number,
    currency: string | undefined,
  ): KpiResult {
    return { label: spec.label, value: this.formatNumber(this.kpiValue(spec, cube, total), spec.format, currency) };
  }

  private kpiValue(spec: KpiSpec, cube: Cube, total: number): number {
    switch (spec.agg) {
      case 'count':
        // The exact server count — no rows were read to get this.
        return total;
      case 'sum':
        return cube.totals[spec.field ?? '']?.sum ?? 0;
      case 'avg': {
        const t = cube.totals[spec.field ?? ''];
        return t && t.count ? t.sum / t.count : 0;
      }
      case 'distinctCount':
        // The cube holds every key of a dimension, so this is exact, not sampled.
        return Object.keys(cube.dims[spec.field ?? ''] ?? {}).length;
      default:
        return 0;
    }
  }

  // ── Charts ───────────────────────────────────────────────────────────────

  private buildChart(
    spec: ChartSectionSpec,
    ctx: ComputeContext,
    fieldMap: Map<string, FieldMeta>,
    palette: ReportPalette,
    currency: string | undefined,
  ): ChartResult {
    const meta = fieldMap.get(spec.groupBy);
    const format = this.chartFormat(spec, fieldMap, currency);

    const chart =
      meta?.type === 'date'
        ? this.timeChart(spec, ctx, format)
        : this.categoryChart(spec, ctx.cube, format);

    return this.paint(chart, palette);
  }

  /** A nominal breakdown: top-N categories, with an exact "Other" tail. */
  private categoryChart(
    spec: ChartSectionSpec,
    cube: Cube,
    format: (value: number) => string,
  ): ChartResult {
    // A donut is read at a glance, so it is capped harder than a bar: past ~6
    // slices the arcs are too thin to compare and the tail is all "0%" noise.
    // Bars stay legible far longer — they are one hue and read off a shared
    // baseline — so they get a looser cap. Either way the tail folds into an
    // exact "Other", never a cycled 9th colour.
    const maxSlices = spec.chartType === 'donut' ? 6 : 12;
    const topN = Math.min(spec.topN ?? maxSlices, maxSlices);
    const bucket = cube.dims[spec.groupBy];

    const empty: ChartResult = {
      type: spec.chartType,
      title: spec.title,
      data: [],
      note: spec.note,
      format,
    };
    if (!bucket) return empty;

    let data: ChartDatum[];

    if (spec.agg === 'avg') {
      // cubeTopN can't express a mean, so fold it here from the group's own totals.
      // Keep sum+count per group so the "Other" bucket can be a COUNT-WEIGHTED
      // average — a plain mean-of-means would let a 1-row group and a 10,000-row
      // group count equally.
      const measure = spec.valueField ?? '';
      const groups = (Object.entries(bucket) as [string, GroupTotal][])
        .map(([label, g]) => ({ label, sum: g.sums[measure] ?? 0, count: g.count }))
        .sort((a, b) => (b.count ? b.sum / b.count : 0) - (a.count ? a.sum / a.count : 0));

      const toDatum = (x: { label: string; sum: number; count: number }): ChartDatum => ({
        label: x.label,
        value: x.count ? x.sum / x.count : 0,
      });

      if (groups.length > topN) {
        const head = groups.slice(0, topN - 1);
        const tail = groups.slice(topN - 1);
        const tailSum = tail.reduce((s, g) => s + g.sum, 0);
        const tailCount = tail.reduce((s, g) => s + g.count, 0);
        data = [
          ...head.map(toDatum),
          { label: 'Other', value: tailCount ? tailSum / tailCount : 0 },
        ];
      } else {
        data = groups.map(toDatum);
      }
    } else {
      // The cube holds EVERY key, so the "Other" bucket is an exact total, not
      // an estimate over a truncated top-N.
      data = cubeTopN(cube, spec.groupBy, spec.agg === 'count' ? undefined : spec.valueField, topN);
    }

    return this.withSeries({ ...empty, data });
  }

  /**
   * A trend: the cube's per-day buckets rolled up to the requested grain.
   *
   * The axis is chronological and gap-filled, so a month with no rows is a zero
   * rather than a missing point the line simply steps over. Nothing here is
   * re-sorted by value — that is the difference between a trend and a ranking.
   */
  private timeChart(
    spec: ChartSectionSpec,
    ctx: ComputeContext,
    format: (value: number) => string,
  ): ChartResult {
    const measures = ctx.source.fields.filter((f) => f.measure).map((f) => f.key);
    const { buckets, truncated, grain } = rollUp(
      ctx.cube.dims[spec.groupBy],
      spec.grain,
      measures,
    );

    const measure = spec.valueField ?? '';
    const value = (b: (typeof buckets)[number]): number => {
      if (spec.agg === 'count') return b.count;
      const sum = b.sums[measure] ?? 0;
      return spec.agg === 'avg' ? (b.count ? sum / b.count : 0) : sum;
    };

    const data: ChartDatum[] = buckets.map((b) => ({ label: b.label, value: value(b) }));

    const notes = [spec.note];
    if (truncated) {
      notes.push(`Most recent ${buckets.length} of ${buckets.length + truncated} ${grain}s.`);
    }

    return this.withSeries({
      type: spec.chartType,
      title: spec.title,
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
   * both means the renderer picks a component without reshaping data in the
   * template — which is exactly the business logic a View must not hold.
   */
  private withSeries(chart: ChartResult): ChartResult {
    if (chart.type !== 'line' && chart.type !== 'area' && chart.type !== 'column') return chart;
    return {
      ...chart,
      labels: chart.data.map((d) => d.label),
      series: [{ label: chart.title, values: chart.data.map((d) => d.value) }],
    };
  }

  /** Applies the chosen palette to a computed chart. */
  private paint(chart: ChartResult, palette: ReportPalette): ChartResult {
    // Categorical is the charts' own default; leaving `color` unset keeps the
    // shared palette as the single place that decision is made.
    if (palette === 'categorical') return chart;

    // A line or column series is ONE thing measured over an axis, so it is one
    // colour. Stepping its points through a ramp would encode position twice
    // and say nothing.
    if (chart.series) {
      return {
        ...chart,
        series: chart.series.map((s, i) => ({ ...s, color: reportColor(palette, i) })),
      };
    }

    return {
      ...chart,
      data: chart.data.map((d, i) => ({ ...d, color: reportColor(palette, i) })),
    };
  }

  private chartFormat(
    spec: ChartSectionSpec,
    fieldMap: Map<string, FieldMeta>,
    currency: string | undefined,
  ): (value: number) => string {
    if (spec.agg === 'count') return formatInteger;
    const format = spec.valueField ? fieldMap.get(spec.valueField)?.format : undefined;
    return (value) => this.formatNumber(value, format, currency);
  }

  // ── Ranking ──────────────────────────────────────────────────────────────

  /**
   * A ranked list — the answer to "top N by X", which a bar chart alone only
   * implies. The rank, the figure and the share are all stated, because "Product
   * A is first" and "Product A is 34% of the total" are different facts.
   */
  private buildRanking(
    spec: RankingSectionSpec,
    ctx: ComputeContext,
    fieldMap: Map<string, FieldMeta>,
    currency: string | undefined,
  ): ReportBlock {
    const bucket = ctx.cube.dims[spec.groupBy] ?? {};
    const measure = spec.valueField ?? '';

    const ranked = (Object.entries(bucket) as [string, GroupTotal][])
      .map(([label, g]) => {
        if (spec.agg === 'count') return { label, value: g.count };
        const sum = g.sums[measure] ?? 0;
        return { label, value: spec.agg === 'avg' ? (g.count ? sum / g.count : 0) : sum };
      })
      .sort((a, b) => b.value - a.value);

    // Share is of EVERY group, not of the visible top-N — "34% of total" has to
    // mean of the total, or the number is worse than useless.
    const grandTotal = ranked.reduce((sum, r) => sum + r.value, 0);
    const top = ranked.slice(0, spec.topN ?? 10);
    const leader = top.length ? Math.max(...top.map((r) => Math.abs(r.value)), 1) : 1;

    const rows: RankingRow[] = top.map((r, i) => ({
      rank: i + 1,
      label: r.label,
      value: r.value,
      display: this.formatNumber(r.value, spec.format, currency),
      sharePct: percentOf(r.value, grandTotal),
      widthPct: Math.max(2, Math.round((Math.abs(r.value) / leader) * 100)),
    }));

    const measureLabel =
      spec.agg === 'count'
        ? 'Rows'
        : `${spec.agg === 'avg' ? 'Avg ' : ''}${fieldMap.get(measure)?.label ?? measure}`;

    const notes = [spec.note];
    if (ranked.length > rows.length) {
      notes.push(`Top ${rows.length} of ${ranked.length.toLocaleString()}.`);
    }

    return {
      kind: 'ranking',
      title: spec.title,
      note: notes.filter(Boolean).join(' · ') || undefined,
      rows,
      chart: spec.chart !== false,
      measureLabel,
    };
  }

  // ── Comparison ───────────────────────────────────────────────────────────

  /**
   * Two windows of the same measure, side by side.
   *
   * Both are cut from the cube's per-day buckets, which means both are exact —
   * and it also means both must be INSIDE the report's filter. When the earlier
   * window has no rows the block says so rather than reporting a −100% fall
   * that is really a filter artefact.
   */
  private buildComparison(
    spec: ComparisonSectionSpec,
    ctx: ComputeContext,
    currency: string | undefined,
    omitted: string[],
  ): ReportBlock | null {
    const days = ctx.cube.dims[spec.dateField ?? ''];
    if (!days || !Object.keys(days).length) {
      omitted.push(
        `“${spec.title ?? 'Comparison'}” needs the slice to be totalled before two periods can be measured.`,
      );
      return null;
    }

    const current = windowTotals(days, spec.current.from, spec.current.to);
    const previous = windowTotals(days, spec.previous.from, spec.previous.to);

    const items = spec.metrics.map((metric) =>
      this.compareMetric(metric, current, previous, currency),
    );

    const notes = [spec.note];
    if (!previous.count) {
      notes.push(
        `No rows fall in ${spec.previous.label} under this report’s filter, so the change is measured against nothing.`,
      );
    } else if (!current.count) {
      notes.push(`No rows fall in ${spec.current.label} under this report’s filter.`);
    }

    return {
      kind: 'comparison',
      title: spec.title,
      note: notes.filter(Boolean).join(' · ') || undefined,
      currentLabel: spec.current.label,
      previousLabel: spec.previous.label,
      items,
    };
  }

  private compareMetric(
    metric: ComparisonSectionSpec['metrics'][number],
    current: { count: number; sums: Record<string, number> },
    previous: { count: number; sums: Record<string, number> },
    currency: string | undefined,
  ): ComparisonResult {
    const read = (w: { count: number; sums: Record<string, number> }): number => {
      if (metric.agg === 'count') return w.count;
      const sum = w.sums[metric.field ?? ''] ?? 0;
      return metric.agg === 'avg' ? (w.count ? sum / w.count : 0) : sum;
    };

    const now = read(current);
    const then = read(previous);
    const delta = now - then;

    const direction: DeltaDirection = delta > 0 ? 'up' : delta < 0 ? 'down' : 'flat';
    const sentiment =
      metric.higherIsBetter === undefined || direction === 'flat'
        ? 'neutral'
        : (direction === 'up') === metric.higherIsBetter
          ? 'good'
          : 'bad';

    return {
      label: metric.label,
      current: this.formatNumber(now, metric.format, currency),
      previous: this.formatNumber(then, metric.format, currency),
      delta: `${delta > 0 ? '+' : delta < 0 ? '−' : ''}${this.formatNumber(Math.abs(delta), metric.format, currency)}`,
      // A ratio against zero is undefined, not infinite, and not 100%.
      deltaPercent: then === 0 ? null : Math.round((delta / Math.abs(then)) * 1000) / 10,
      direction,
      sentiment,
    };
  }

  // ── Table ────────────────────────────────────────────────────────────────

  private buildTableBlock(
    spec: TableSectionSpec,
    ctx: ComputeContext,
    fieldMap: Map<string, FieldMeta>,
    currency: string | undefined,
  ): ReportBlock {
    return {
      kind: 'table',
      title: spec.title,
      table: this.buildTable(spec.columns, ctx.tableRows, ctx.total, fieldMap, currency),
    };
  }

  private buildTable(
    columns: string[],
    rows: Row[],
    total: number,
    fieldMap: Map<string, FieldMeta>,
    currency: string | undefined,
  ): TableResult {
    const cols: TableColumn<Row>[] = columns.map((key) => {
      const meta = fieldMap.get(key);
      const numeric = meta?.type === 'number';
      return {
        key,
        header: meta?.label ?? key,
        align: numeric ? 'right' : 'left',
        format: (value) => this.formatValue(value, meta?.format, currency),
      };
    });

    return {
      columns: cols,
      displayRows: rows.slice(0, TABLE_DISPLAY_LIMIT),
      total,
      displayLimit: TABLE_DISPLAY_LIMIT,
    };
  }

  // ── Formatting ───────────────────────────────────────────────────────────
  /**
   * The currency to format with.
   *
   * This used to scan every row for a hardcoded `CurrencyCode` field — which
   * Shatat does not have, so it scanned the whole dataset and always returned
   * `undefined`. The field now comes from the source, and a source without one
   * simply has no currency.
   */
  private currencyOf(ctx: ComputeContext): string | undefined {
    const field = ctx.source.currencyField;
    if (!field) return undefined;

    const bucket = ctx.cube.dims[field];
    if (bucket) {
      const entries = Object.entries(bucket) as [string, GroupTotal][];
      const dominant = entries.sort((a, b) => b[1].count - a[1].count)[0];
      if (dominant) return dominant[0];
    }
    return ctx.tableRows.length ? String(ctx.tableRows[0][field] ?? '') || undefined : undefined;
  }

  private formatValue(value: unknown, format: ValueFormat | undefined, currency?: string): string {
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

  private formatNumber(value: number, format: ValueFormat | undefined, currency?: string): string {
    if (format === 'currency') return formatCurrency(value, currency);
    if (format === 'percent') return formatPercent(value);
    if (format === 'quantity') return formatQuantity(value);
    return formatInteger(value);
  }
}

/** Re-exported so callers can ask "does this spec need a fold?" without a cube. */
export { planReport } from './report-plan';
