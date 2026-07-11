import { Injectable } from '@angular/core';
import { ChartDatum } from '../../../shared/models/chart.model';
import { TableColumn } from '../../../shared/models/table-column.model';
import {
  formatCurrency,
  formatDate,
  formatInteger,
  formatQuantity,
} from '../../../shared/utils/format.util';
import { FieldMeta, ValueFormat } from '../models/field-meta.model';
import {
  ChartResult,
  ChartSpec,
  FilterSpec,
  KpiResult,
  KpiSpec,
  ReportResult,
  ReportSpec,
} from '../models/report-spec.model';

type Row = Record<string, unknown>;

/** Row cap for the rendered table (export still receives the full filtered set). */
const TABLE_DISPLAY_LIMIT = 100;

/**
 * Computes a {@link ReportSpec} against the real, local dataset. Every number
 * shown comes from here, not from the LLM — so figures are always accurate.
 */
@Injectable({ providedIn: 'root' })
export class ReportEngineService {
  compute(spec: ReportSpec, rows: readonly Row[], fields: FieldMeta[]): ReportResult {
    const fieldMap = new Map(fields.map((f) => [f.key, f]));
    const currency = this.dominantCurrency(rows);
    const filtered = this.applyFilters(rows, spec.filters ?? []);

    return {
      title: spec.title,
      description: spec.description,
      rowCount: filtered.length,
      kpis: (spec.kpis ?? []).map((k) => this.computeKpi(k, filtered, currency)),
      charts: (spec.charts ?? []).map((c) => this.computeChart(c, filtered)),
      table: spec.table ? this.buildTable(spec.table.columns, filtered, fieldMap, currency) : undefined,
    };
  }

  // ── Filters ──────────────────────────────────────────────────────────────
  private applyFilters(rows: readonly Row[], filters: FilterSpec[]): Row[] {
    if (!filters.length) return [...rows];
    return rows.filter((row) => filters.every((f) => this.matches(row[f.field], f)));
  }

  private matches(raw: unknown, f: FilterSpec): boolean {
    if (f.op === 'contains') {
      return String(raw ?? '').toLowerCase().includes(String(f.value).toLowerCase());
    }
    if (typeof f.value === 'number') {
      const n = Number(raw);
      switch (f.op) {
        case 'gt': return n > f.value;
        case 'lt': return n < f.value;
        case 'gte': return n >= f.value;
        case 'lte': return n <= f.value;
        case 'neq': return n !== f.value;
        default: return n === f.value;
      }
    }
    const a = String(raw ?? '').toLowerCase();
    const b = String(f.value).toLowerCase();
    return f.op === 'neq' ? a !== b : a === b;
  }

  // ── KPIs ─────────────────────────────────────────────────────────────────
  private computeKpi(spec: KpiSpec, rows: Row[], currency: string | undefined): KpiResult {
    let value: number;
    switch (spec.agg) {
      case 'count':
        value = rows.length;
        break;
      case 'sum':
        value = this.sum(rows, spec.field);
        break;
      case 'avg':
        value = rows.length ? this.sum(rows, spec.field) / rows.length : 0;
        break;
      case 'distinctCount':
        value = new Set(rows.map((r) => String(r[spec.field ?? ''] ?? ''))).size;
        break;
      default:
        value = 0;
    }
    return { label: spec.label, value: this.formatNumber(value, spec.format, currency) };
  }

  // ── Charts ───────────────────────────────────────────────────────────────
  private computeChart(spec: ChartSpec, rows: Row[]): ChartResult {
    const groups = new Map<string, { total: number; count: number }>();
    for (const row of rows) {
      const key = String(row[spec.groupBy] ?? '—') || '—';
      const bucket = groups.get(key) ?? { total: 0, count: 0 };
      bucket.count += 1;
      bucket.total += spec.agg === 'count' ? 1 : this.toNumber(row[spec.valueField ?? '']);
      groups.set(key, bucket);
    }

    let data: ChartDatum[] = [...groups.entries()]
      .map(([label, b]) => ({
        label,
        value: spec.agg === 'avg' ? (b.count ? b.total / b.count : 0) : b.total,
      }))
      .sort((a, b) => b.value - a.value);

    const topN = spec.topN ?? 8;
    if (data.length > topN) {
      const head = data.slice(0, topN - 1);
      const other = data.slice(topN - 1).reduce((s, d) => s + d.value, 0);
      data = [...head, { label: 'Other', value: other }];
    }

    return { type: spec.type, title: spec.title, data };
  }

  // ── Table ────────────────────────────────────────────────────────────────
  private buildTable(
    columns: string[],
    rows: Row[],
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
    return { columns: cols, rows: rows.slice(0, TABLE_DISPLAY_LIMIT) };
  }

  // ── Formatting ─────────────────────────────────────────────────────────────
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

  private sum(rows: Row[], field: string | undefined): number {
    if (!field) return rows.length;
    return rows.reduce((total, r) => total + this.toNumber(r[field]), 0);
  }

  private toNumber(value: unknown): number {
    const n = Number(value);
    return Number.isFinite(n) ? n : 0;
  }

  private dominantCurrency(rows: readonly Row[]): string | undefined {
    const counts = new Map<string, number>();
    for (const r of rows) {
      const c = String(r['CurrencyCode'] ?? '');
      if (c) counts.set(c, (counts.get(c) ?? 0) + 1);
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
  }
}
