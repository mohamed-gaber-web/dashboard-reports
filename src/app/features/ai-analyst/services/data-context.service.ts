import { Injectable } from '@angular/core';
import { Cube, GroupTotal } from '../../../core/aggregation/aggregate-plan.model';
import { AnalystSource } from '../models/analyst-source.model';
import { FieldMeta } from '../models/field-meta.model';
import { DateBounds } from './analyst-data.service';
import { rollUp } from './time-buckets';

type Row = Record<string, unknown>;

/** Compact, privacy-preserving snapshot of a dataset sent to the LLM as context. */
export interface DataContext {
  /** The exact server count for the current filter — not the number of rows read. */
  rowCount: number;
  schema: {
    name: string;
    label: string;
    type: string;
    /** For enums — so the model proposes a real member, not an invented one. */
    values?: readonly string[];
  }[];
  summary: Record<string, unknown>;
  sample: Row[];
  /**
   * Whether the summary's sums cover the whole filtered slice.
   *
   * `exact`   — a cube was folded over every matching row.
   * `pending` — the slice was too large to fold, so **there are no sums here at all**.
   *
   * We never hand the model an unlabelled estimate. The whole promise of this
   * feature is that every figure is real; a sampled sum presented as a total
   * would break that in the one place users trust most.
   */
  coverage: 'exact' | 'pending';
}

/**
 * Builds the schema + aggregate summary the LLM reasons over.
 *
 * Only aggregates, the schema, and ≤5 sample rows ever leave the browser — the
 * raw dataset never does. That privacy property is unchanged from the original
 * design; what changed is that the aggregates are now real.
 *
 * The old version ran ~13 full passes over an in-memory array on **every chat
 * turn**. That array was a truncated 5,000-row slice of an 11M-row entity, so
 * every "total" it fed the model was wrong by three orders of magnitude.
 */
@Injectable({ providedIn: 'root' })
export class DataContextService {
  /**
   * @param rowCount exact `@odata.count` for the filter.
   * @param cube     the folded slice, or null when it was too large to fold.
   */
  build(
    source: AnalystSource,
    rowCount: number,
    sample: Row[],
    bounds: DateBounds,
    cube: Cube | null,
  ): DataContext {
    const summary: Record<string, unknown> = { rowCount };

    if (source.dateField && (bounds.min || bounds.max)) {
      summary[`min_${source.dateField}`] = bounds.min;
      summary[`max_${source.dateField}`] = bounds.max;
    }

    if (cube) {
      const dateFields = new Set(source.fields.filter((f) => f.type === 'date').map((f) => f.key));
      const measures = source.fields.filter((f) => f.measure).map((f) => f.key);

      for (const [field, total] of Object.entries(cube.totals)) {
        summary[`sum_${field}`] = round(total.sum);
        summary[`avg_${field}`] = total.count ? round(total.sum / total.count) : 0;
      }

      for (const [field, groups] of Object.entries(cube.dims)) {
        const entries = Object.entries(groups);

        // A date dimension is folded by day, so ranking it "top 5 by count"
        // would spend the model's context on five arbitrary Tuesdays. What it
        // actually needs to answer "why did this fall?" is the recent shape of
        // the series, so it gets a monthly trend instead.
        if (dateFields.has(field)) {
          const trend = monthlyTrend(groups, measures);
          if (trend.length) summary[`monthly_${field}`] = trend;
          summary[`days_with_data_${field}`] = entries.length;
          continue;
        }

        summary[`distinct_${field}`] = entries.length;

        const top = entries
          .sort((a, b) => b[1].count - a[1].count)
          .slice(0, 5)
          .map(([value, g]) => ({ value, count: g.count }));
        if (top.length) summary[`top_${field}`] = top;
      }
    } else {
      // Say so, loudly, rather than shipping a summary that looks complete.
      summary['note'] =
        `This slice is too large to total (${rowCount.toLocaleString()} rows). ` +
        `Counts and date ranges are exact. Sums, averages and distinct counts are ` +
        `NOT available — ask the user to narrow the filter (date range, site, ` +
        `transaction type) before proposing any sum or average.`;
    }

    return {
      rowCount,
      schema: source.fields.map((f) => ({
        name: f.key,
        label: f.label,
        type: f.type,
        values: f.enumMembers,
      })),
      summary,
      sample: sample.map((r) => project(r, source.fields)),
      coverage: cube ? 'exact' : 'pending',
    };
  }
}

/** How many months of history the model is shown. A year reads a seasonal shape. */
const TREND_MONTHS = 12;

/**
 * The last twelve months of a date dimension, as rows and measure totals.
 *
 * This is the evidence behind a question like "why did sales drop?". Without it
 * the model can see the total and the top customers but has no view of the
 * series over time, so it can only say *that* something changed, never *when*.
 * Every figure here is folded from real rows, so quoting one is grounded.
 */
function monthlyTrend(
  groups: Record<string, GroupTotal>,
  measures: string[],
): Record<string, unknown>[] {
  const { buckets } = rollUp(groups, 'month', measures);
  return buckets.slice(-TREND_MONTHS).map((b) => {
    const row: Record<string, unknown> = { month: b.key, rows: b.count };
    for (const m of measures) row[`sum_${m}`] = round(b.sums[m] ?? 0);
    return row;
  });
}

function project(row: Row, fields: FieldMeta[]): Row {
  const out: Row = {};
  for (const f of fields) out[f.key] = row[f.key];
  return out;
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}
