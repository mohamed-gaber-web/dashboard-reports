import { ChartDatum } from '../../../shared/models/chart.model';
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

export interface TableResult {
  columns: TableColumn<Record<string, unknown>>[];
  rows: Record<string, unknown>[];
}

export interface ReportResult {
  title: string;
  description?: string;
  rowCount: number;
  kpis: KpiResult[];
  charts: ChartResult[];
  table?: TableResult;
}
