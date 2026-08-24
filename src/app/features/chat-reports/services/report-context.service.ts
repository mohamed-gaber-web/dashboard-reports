import { Injectable, inject } from '@angular/core';
import { Observable, map, shareReplay } from 'rxjs';
import { SalesOrderService } from '../../sales-order/services/sales-order.service';
import { SalesBackorderRecord } from '../../sales-order/models/sales-order.model';
import { aggregate, distinctCount } from '../../../shared/utils/group-by.util';

/**
 * The compact, privacy-preserving snapshot the AI reasons over.
 *
 * Only aggregates, the field list, and a handful of sample rows ever leave the
 * browser — never the raw dataset. That is the same property the AI Analyst's
 * `DataContext` guarantees, and it is deliberate, not incidental.
 */
export interface ReportDataContext {
  /** Rows the aggregates below cover. */
  rowCount: number;
  /** What the dataset is, in one line — so the model knows what it is looking at. */
  dataset: string;
  schema: { name: string; label: string; type: 'text' | 'number' | 'date' }[];
  summary: Record<string, unknown>;
  sample: Record<string, unknown>[];
}

/** A field the model is told about, and how to read it off a row. */
interface FieldSpec {
  name: keyof SalesBackorderRecord & string;
  label: string;
  type: 'text' | 'number' | 'date';
  /** Dimensions get distinct counts and a top-5 breakdown. */
  dimension?: boolean;
  /** Measures get a sum and an average. */
  measure?: boolean;
}

/**
 * The fields the model may reference. Deliberately a allow-list rather than
 * `Object.keys(row)`: it keeps internal columns out of the prompt and means a
 * schema change upstream cannot silently widen what gets sent.
 */
const FIELDS: FieldSpec[] = [
  { name: 'SalesId', label: 'Sales order number', type: 'text' },
  { name: 'ItemId', label: 'Product number', type: 'text', dimension: true },
  { name: 'Name', label: 'Product name', type: 'text' },
  { name: 'CustAccount', label: 'Customer account', type: 'text', dimension: true },
  { name: 'SalesTable_SalesName', label: 'Customer name', type: 'text', dimension: true },
  { name: 'SalesTable_DocumentStatus', label: 'Document status', type: 'text', dimension: true },
  { name: 'CurrencyCode', label: 'Currency', type: 'text', dimension: true },
  { name: 'QtyOrdered', label: 'Quantity ordered', type: 'number', measure: true },
  { name: 'RemainInventPhysical', label: 'Units remaining to ship', type: 'number', measure: true },
  { name: 'LineAmount', label: 'Line net amount', type: 'number', measure: true },
  { name: 'SalesTable_DeliveryDate', label: 'Delivery date', type: 'date' },
  { name: 'ShippingDateRequested', label: 'Requested ship date', type: 'date' },
];

/** How many sample rows are sent. Illustrative only — never a basis for a total. */
const SAMPLE_ROWS = 5;

/** How many categories each dimension's breakdown carries. */
const TOP_N = 5;

/**
 * Builds the grounded context for chat-reports.
 *
 * One responsibility: turn the backorder dataset into aggregates the model can
 * reason over (NG-SOLID-01). It does no HTTP of its own — `SalesOrderService`
 * owns the query — and it holds no conversation state.
 *
 * ## Why this matters more here than in the AI Analyst
 *
 * The AI Analyst's contract has the model emit a SPEC that the app computes, so
 * a weak context produces a badly-chosen report but never a wrong number. This
 * feature's contract has the model emit the FIGURES. That makes this summary the
 * only thing standing between the user and a plausible fabrication, so it ships
 * real totals over the whole dataset rather than a sample.
 */
@Injectable({ providedIn: 'root' })
export class ReportContextService {
  private readonly salesOrders = inject(SalesOrderService);

  /**
   * Cached for the session. The dataset is the same for every question, and
   * re-fetching thousands of rows per chat turn would make every reply slower
   * for no gain. `shareReplay` also means concurrent turns share one request.
   */
  private context$?: Observable<ReportDataContext>;

  load(): Observable<ReportDataContext> {
    this.context$ ??= this.salesOrders.getBackorders().pipe(
      map((response) => this.build(response.value ?? [])),
      shareReplay({ bufferSize: 1, refCount: false }),
    );
    return this.context$;
  }

  /** Drop the cache so the next question re-reads D365. */
  refresh(): void {
    this.context$ = undefined;
  }

  private build(rows: SalesBackorderRecord[]): ReportDataContext {
    const summary: Record<string, unknown> = { rowCount: rows.length };

    for (const field of FIELDS) {
      if (field.measure) {
        const total = rows.reduce((sum, row) => sum + this.numberAt(row, field.name), 0);
        summary[`sum_${field.name}`] = round(total);
        summary[`avg_${field.name}`] = rows.length ? round(total / rows.length) : 0;
      }

      if (field.dimension) {
        const key = (row: SalesBackorderRecord) => this.textAt(row, field.name);
        summary[`distinct_${field.name}`] = distinctCount(rows, key);

        // Top categories by row count AND by units remaining — the two questions
        // users actually ask ("which customer has the most lines" vs "the most
        // stock waiting"). One without the other invites the model to answer the
        // wrong one confidently.
        summary[`top_${field.name}_by_lines`] = aggregate(rows, key, () => 1, TOP_N).map(toEntry);
        summary[`top_${field.name}_by_units`] = aggregate(
          rows,
          key,
          (row) => this.numberAt(row, 'RemainInventPhysical'),
          TOP_N,
        ).map(toEntry);
      }

      if (field.type === 'date') {
        const bounds = this.dateBounds(rows, field.name);
        if (bounds) {
          summary[`min_${field.name}`] = bounds.min;
          summary[`max_${field.name}`] = bounds.max;
        }
      }
    }

    return {
      rowCount: rows.length,
      dataset:
        'Open sales-order backorder lines — order lines still on backorder with ' +
        'remaining physical inventory to ship.',
      schema: FIELDS.map((f) => ({ name: f.name, label: f.label, type: f.type })),
      summary,
      sample: rows.slice(0, SAMPLE_ROWS).map((row) => this.project(row)),
    };
  }

  /** Keep only allow-listed fields, so nothing unexpected rides along. */
  private project(row: SalesBackorderRecord): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const field of FIELDS) out[field.name] = row[field.name];
    return out;
  }

  private numberAt(row: SalesBackorderRecord, key: FieldSpec['name']): number {
    const value = row[key];
    return typeof value === 'number' && Number.isFinite(value) ? value : 0;
  }

  private textAt(row: SalesBackorderRecord, key: FieldSpec['name']): string {
    const value = row[key];
    return value == null || value === '' ? '—' : String(value);
  }

  /**
   * Earliest and latest real date in a column.
   *
   * D365 uses `1900-01-01` as an "unset" sentinel — the same one `formatDate`
   * screens out. Left in, it would tell the model the backorder book stretches
   * back to the Victorian era.
   */
  private dateBounds(
    rows: SalesBackorderRecord[],
    key: FieldSpec['name'],
  ): { min: string; max: string } | null {
    let min: string | null = null;
    let max: string | null = null;

    for (const row of rows) {
      const raw = row[key];
      if (typeof raw !== 'string' || !raw) continue;
      const date = new Date(raw);
      if (Number.isNaN(date.getTime()) || date.getUTCFullYear() <= 1900) continue;

      const iso = date.toISOString().slice(0, 10);
      if (min === null || iso < min) min = iso;
      if (max === null || iso > max) max = iso;
    }

    return min !== null && max !== null ? { min, max } : null;
  }
}

function toEntry(datum: { label: string; value: number }): { value: string; total: number } {
  return { value: datum.label, total: round(datum.value) };
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}
