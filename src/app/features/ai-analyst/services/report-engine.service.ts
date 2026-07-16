import { Injectable } from '@angular/core';
import { ChartDatum } from '../../../shared/models/chart.model';
import { TableColumn } from '../../../shared/models/table-column.model';
import { Cube, GroupTotal } from '../../../core/aggregation/aggregate-plan.model';
import { cubeTopN } from '../../../core/aggregation/aggregation.service';
import {
  formatCurrency,
  formatDate,
  formatInteger,
  formatQuantity,
} from '../../../shared/utils/format.util';
import { AnalystSource } from '../models/analyst-source.model';
import { FieldMeta, ValueFormat } from '../models/field-meta.model';
import {
  ChartResult,
  ChartSpec,
  KpiResult,
  KpiSpec,
  ReportResult,
  ReportSpec,
} from '../models/report-spec.model';

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
 * Every number still comes from the data, never from the LLM — that contract is
 * unchanged. What changed is *where the data is read*. The old engine took a
 * `Row[]` and scanned it once per KPI and once per chart. That only worked
 * because the array was secretly truncated to 5,000 rows; at the entity's real
 * size (~11M) there is no array to scan.
 *
 * So the engine now reads a {@link Cube} — a pre-folded set of group totals — and
 * the exact `@odata.count`. Both are computed from the complete filtered slice,
 * so the figures are right rather than merely fast.
 */
@Injectable({ providedIn: 'root' })
export class ReportEngineService {
  compute(spec: ReportSpec, ctx: ComputeContext): ReportResult {
    const { source, cube, total } = ctx;
    const fieldMap = new Map(source.fields.map((f) => [f.key, f]));
    const currency = this.currencyOf(ctx);

    return {
      title: spec.title,
      description: spec.description,
      rowCount: total,
      kpis: (spec.kpis ?? []).map((k) => this.computeKpi(k, cube, total, currency)),
      charts: (spec.charts ?? []).map((c) => this.computeChart(c, cube)),
      table: spec.table
        ? this.buildTable(spec.table.columns, ctx.tableRows, total, fieldMap, currency)
        : undefined,
      omitted: ctx.omitted?.length ? ctx.omitted : undefined,
    };
  }

  // ── KPIs ─────────────────────────────────────────────────────────────────
  private computeKpi(
    spec: KpiSpec,
    cube: Cube,
    total: number,
    currency: string | undefined,
  ): KpiResult {
    let value: number;

    switch (spec.agg) {
      case 'count':
        // The exact server count — no rows were read to get this.
        value = total;
        break;
      case 'sum':
        value = cube.totals[spec.field ?? '']?.sum ?? 0;
        break;
      case 'avg': {
        const t = cube.totals[spec.field ?? ''];
        value = t && t.count ? t.sum / t.count : 0;
        break;
      }
      case 'distinctCount':
        // The cube holds every key of a dimension, so this is exact, not sampled.
        value = Object.keys(cube.dims[spec.field ?? ''] ?? {}).length;
        break;
      default:
        value = 0;
    }

    return { label: spec.label, value: this.formatNumber(value, spec.format, currency) };
  }

  // ── Charts ───────────────────────────────────────────────────────────────
  private computeChart(spec: ChartSpec, cube: Cube): ChartResult {
    // A donut is read at a glance, so it is capped harder than a bar: past ~6
    // slices the arcs are too thin to compare and the tail is all "0%" noise.
    // Bars stay legible far longer — they are one hue and read off a shared
    // baseline — so they get a looser cap. Either way the tail folds into an
    // exact "Other", never a cycled 9th colour.
    const maxSlices = spec.type === 'donut' ? 6 : 12;
    const topN = Math.min(spec.topN ?? maxSlices, maxSlices);
    const bucket = cube.dims[spec.groupBy];

    if (!bucket) return { type: spec.type, title: spec.title, data: [] };

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

    return { type: spec.type, title: spec.title, data };
  }

  // ── Table ────────────────────────────────────────────────────────────────
  private buildTable(
    columns: string[],
    rows: Row[],
    total: number,
    fieldMap: Map<string, FieldMeta>,
    currency: string | undefined,
  ): ReportResult['table'] {
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
    if (format === 'quantity') return formatQuantity(value);
    return formatInteger(value);
  }
}
