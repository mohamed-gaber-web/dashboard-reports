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
