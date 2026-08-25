import { Injectable, inject } from '@angular/core';
import {
  Observable,
  Subject,
  catchError,
  concat,
  defer,
  endWith,
  forkJoin,
  map,
  of,
  shareReplay,
  switchMap,
  takeUntil,
  takeWhile,
} from 'rxjs';
import { MAX_ANALYZE_ROWS, Cube } from '../../../core/aggregation/aggregate-plan.model';
import { SalesOrderService } from '../../sales-order/services/sales-order.service';
import { SalesBackorderRecord } from '../../sales-order/models/sales-order.model';
import { aggregate, distinctCount } from '../../../shared/utils/group-by.util';
import { AnalystDataService } from '../../ai-analyst/services/analyst-data.service';
import { DataContextService } from '../../ai-analyst/services/data-context.service';
import { AnalystSource } from '../../ai-analyst/models/analyst-source.model';
import {
  ChatReportFilter,
  ChatReportSource,
  describeSlice,
  hasSliceFilter,
  sliceKey,
} from '../sources/chat-report-sources';

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
  schema: { name: string; label: string; type: string; values?: readonly string[] }[];
  summary: Record<string, unknown>;
  sample: Record<string, unknown>[];
  /**
   * Whether the summary's sums cover the whole dataset.
   *
   * `exact`   — every matching row was totalled.
   * `pending` — the dataset is too large to total, so there are **no sums here
   *             at all**. Counts and date ranges are still exact.
   *
   * This matters more on this screen than anywhere else in the app: the model
   * states the figures itself, so it has to be told plainly which world it is
   * in rather than left to assume the summary is complete.
   */
  coverage: 'exact' | 'pending';
  /**
   * What the user narrowed the module to, in one sentence, or null for the
   * whole module.
   *
   * Carried all the way to the system prompt. Without it the backend describes
   * the summary as covering "the whole dataset" — true until someone picks a
   * date range, and false in exactly the way this contract cannot afford, since
   * the model is the thing stating the figures.
   */
  slice: string | null;
}

/**
 * Where a context load has got to.
 *
 * The old shape was a single `Observable<ReportDataContext>`, so every module
 * looked identical while loading: one line of "Reading … data" covering a 300 ms
 * count and a 60-second fold alike. On the large modules that is the whole
 * user experience of this screen, and it said nothing about what was happening
 * or how long was left. Each phase carries the numbers the UI needs to say so.
 *
 * `ready` is terminal.
 */
export type ContextPhase =
  | { phase: 'counting' }
  | { phase: 'reading'; rowCount: number }
  | { phase: 'totalling'; rowCount: number; loaded: number }
  | { phase: 'ready'; context: ReportDataContext };

/** Internal: the fold's own events, before they become phases. */
type FoldEvent = { kind: 'progress'; loaded: number } | { kind: 'done'; cube: Cube | null };

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
 * The fields the model may reference on the joined Sales Order dataset.
 * Deliberately an allow-list rather than `Object.keys(row)`: it keeps internal
 * columns out of the prompt and means a schema change upstream cannot silently
 * widen what gets sent.
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

/**
 * The column the joined Sales Order slice is windowed on, and the text columns
 * its search box covers.
 *
 * The modes mirror `analyst-sources.ts`' `searchFields` for the same module —
 * prefix on the identifiers, contains on the free-text names — so the same term
 * selects the same rows whichever path a tenant happens to use. Matching is
 * done in memory here (see `fromSalesOrders`), where prefix costs nothing extra;
 * the point of copying the modes is consistency of RESULTS, not of cost.
 */
const JOINED_DATE_FIELD = 'SalesTable_DeliveryDate' as const;

const JOINED_SEARCH: { name: FieldSpec['name']; mode: 'prefix' | 'contains' }[] = [
  { name: 'SalesId', mode: 'prefix' },
  { name: 'ItemId', mode: 'prefix' },
  { name: 'CustAccount', mode: 'prefix' },
  { name: 'Name', mode: 'contains' },
  { name: 'SalesTable_SalesName', mode: 'contains' },
];

/** How many sample rows are sent. Illustrative only — never a basis for a total. */
const SAMPLE_ROWS = 5;

/** How many categories each dimension's breakdown carries. */
const TOP_N = 5;

/**
 * Builds the grounded context for chat-reports, for whichever module and slice
 * is selected.
 *
 * ## Why there are two paths
 *
 * See `sources/chat-report-sources.ts` for the full reasoning. In short: Sales
 * Order is summarised from the JOINED dataset a feature service already
 * assembles, which is the only way this screen can group by customer name at
 * all; every other module is a single entity counted and folded through the
 * shared `AnalystDataService` pipeline, which is what makes an 11M-row module
 * safe to point at.
 *
 * ## Why this matters more here than in the AI Analyst
 *
 * The AI Analyst's contract has the model emit a SPEC that the app computes, so
 * a weak context produces a badly-chosen report but never a wrong number. This
 * feature's contract has the model emit the FIGURES. That makes this summary the
 * only thing standing between the user and a plausible fabrication — hence real
 * totals over the whole slice, an explicit `coverage` flag when they could not
 * be computed, and an explicit `slice` sentence when they cover less than the
 * module.
 */
@Injectable({ providedIn: 'root' })
export class ReportContextService {
  private readonly salesOrders = inject(SalesOrderService);
  private readonly analystData = inject(AnalystDataService);
  private readonly dataContext = inject(DataContextService);

  /**
   * Cached per module AND per slice. The dataset is the same for every question
   * asked about one slice, and re-reading it per chat turn would make every
   * reply slower for no gain. `shareReplay` also means concurrent turns share
   * one request, and that going back to a slice already looked at is instant
   * rather than another fold.
   */
  private readonly cache = new Map<string, Observable<ContextPhase>>();

  /**
   * The joined Sales Order dataset, fetched at most once.
   *
   * Its filtering happens in memory, so a new slice must not mean a new
   * download of every backorder line — it is the same rows, narrowed again.
   */
  private backorders?: Observable<SalesBackorderRecord[]>;

  /** Fires when the user abandons an in-flight fold. See {@link skipTotals}. */
  private readonly skip$ = new Subject<void>();

  load(source: ChatReportSource, filter: ChatReportFilter = {}): Observable<ContextPhase> {
    const key = sliceKey(source.id, filter);
    const cached = this.cache.get(key);
    if (cached) return cached;

    const slice = describeSlice(source, filter);
    const built = (
      source.analyst
        ? this.fromEntity(source.analyst, filter, slice)
        : this.fromSalesOrders(filter, slice)
    ).pipe(shareReplay({ bufferSize: 1, refCount: false }));

    this.cache.set(key, built);
    return built;
  }

  /**
   * Abandon the running fold and finish with counts only — the user's choice.
   *
   * The escape hatch for the honest-but-long wait: a 200,000-row slice takes
   * the better part of a minute to total, and a user who only wants to know how
   * many rows there are should not have to sit through it. The result is a
   * `coverage: 'pending'` context — the same one an over-limit module produces,
   * so the model is already told not to state a sum, and the UI already has a
   * badge for it. It is NOT a partial cube: half-summed totals presented as
   * totals is the exact failure this screen exists to prevent.
   *
   * That counts-only result IS cached, deliberately: it is what was asked for,
   * and re-running the fold on the next question would undo the choice.
   */
  skipTotals(): void {
    this.skip$.next();
    this.analystData.cancelFold();
  }

  /**
   * Abandon a slice the user has navigated away from, cache included.
   *
   * Distinct from {@link skipTotals}, and the difference matters. Skipping is a
   * decision about a slice the user is still looking at. Switching module or
   * applying a new filter is not a decision about the old one at all — so its
   * half-finished load must not be cached as "counts only", which is what would
   * greet them on returning to it: a *Counts only* badge on a module that is
   * perfectly capable of being totalled.
   *
   * Dropping the entry is what makes that safe; the stream is still terminated
   * so nothing is left waiting on a worker that has been told to stop.
   */
  cancelSlice(sourceId: string, filter: ChatReportFilter): void {
    this.cache.delete(sliceKey(sourceId, filter));
    this.skip$.next();
    this.analystData.cancelFold();
  }

  /**
   * Drop cached slices so the next question re-reads D365.
   *
   * Every slice of a module, not just the current one — a refresh means "the
   * data moved", and a stale sibling slice would be served the moment the user
   * changed a date back.
   */
  refresh(sourceId?: string): void {
    if (!sourceId) {
      this.cache.clear();
      this.backorders = undefined;
      return;
    }
    for (const key of [...this.cache.keys()]) {
      if (key === sourceId || key.startsWith(`${sourceId}|`)) this.cache.delete(key);
    }
    if (sourceId === 'sales-order') this.backorders = undefined;
  }

  // ── The generic path: count, gate, fold ──────────────────────────────────

  /**
   * Summarise one entity through the shared pipeline, narrowed to the slice.
   *
   * Count first — it is exact, costs zero rows and runs in seconds even at 11M.
   * Only then decide whether to fold: above {@link MAX_ANALYZE_ROWS} we take the
   * counts and say so, rather than starting a crawl that would not finish or,
   * worse, totalling the first few thousand rows and calling it the dataset.
   *
   * Each step announces itself, because on a large module these are the seconds
   * the user actually spends on this screen.
   */
  private fromEntity(
    source: AnalystSource,
    filter: ChatReportFilter,
    slice: string | null,
  ): Observable<ContextPhase> {
    const odata = this.analystData.buildFilter(source, {
      search: filter.search,
      from: filter.from,
      // Inclusive "to" — see ChatReportFilter. The shared helper emits `lt`.
      to: exclusiveEnd(filter.to),
    });

    return concat(
      of<ContextPhase>({ phase: 'counting' }),
      this.analystData.countRaw(source, odata).pipe(
        switchMap((rowCount) =>
          concat(
            of<ContextPhase>({ phase: 'reading', rowCount }),
            forkJoin({
              sample: this.analystData.sampleRaw(source, odata, SAMPLE_ROWS),
              bounds: this.analystData.dateBoundsRaw(source, odata),
            }).pipe(
              switchMap(({ sample, bounds }) =>
                this.foldEvents(source, odata, rowCount).pipe(
                  map(
                    (event): ContextPhase =>
                      event.kind === 'progress'
                        ? { phase: 'totalling', rowCount, loaded: event.loaded }
                        : {
                            phase: 'ready',
                            context: this.entityContext(
                              source,
                              rowCount,
                              sample,
                              bounds,
                              event.cube,
                              slice,
                            ),
                          },
                  ),
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }

  /**
   * The shared context, plus the two things this screen adds to it: a ranking
   * by the headline measure, and what the figures actually cover.
   */
  private entityContext(
    source: AnalystSource,
    rowCount: number,
    sample: Record<string, unknown>[],
    bounds: { min?: string; max?: string },
    cube: Cube | null,
    slice: string | null,
  ): ReportDataContext {
    const base = this.dataContext.build(source, rowCount, sample, bounds, cube);
    return {
      ...base,
      summary: { ...base.summary, ...this.topByMeasure(source, cube) },
      dataset: source.description ?? source.label,
      slice,
    };
  }

  /**
   * The fold's progress, then exactly one terminal event carrying the cube — or
   * null when there is no cube to be had.
   *
   * Three ways it ends without one, all of them counts-only rather than an
   * error: the slice is over the limit (or empty), the fold failed, or the user
   * skipped it. Losing the whole conversation because one Worker request failed
   * would be the worse trade — the count, the schema and the date range are
   * still exact and still useful.
   *
   * `takeWhile(…, true)` is what makes the terminator safe: it completes the
   * stream on the FIRST `done`, so the `endWith` that exists to rescue a
   * skipped fold cannot append a second, cube-less `done` after a successful
   * one and blank out real totals.
   */
  private foldEvents(
    source: AnalystSource,
    odata: string,
    rowCount: number,
  ): Observable<FoldEvent> {
    if (rowCount <= 0 || rowCount > MAX_ANALYZE_ROWS) {
      return of<FoldEvent>({ kind: 'done', cube: null });
    }

    // `defer` because `foldRaw` throws SliceTooLargeError synchronously — the
    // gate above means it cannot here, but a throw on subscribe is catchable
    // and a throw on call is not.
    return defer(() => this.analystData.foldRaw(source, odata, rowCount)).pipe(
      map((p): FoldEvent => (p.cube ? { kind: 'done', cube: p.cube } : { kind: 'progress', loaded: p.loaded })),
      catchError(() => of<FoldEvent>({ kind: 'done', cube: null })),
      takeUntil(this.skip$),
      endWith<FoldEvent>({ kind: 'done', cube: null }),
      takeWhile((e) => e.kind === 'progress', true),
    );
  }

  /**
   * Top categories by the module's headline MEASURE, not by row count.
   *
   * The shared `DataContextService` ranks every dimension by how many rows it
   * has. That answers "which warehouse appears most often" — and asked "which
   * warehouses hold the most stock", a correctly-grounded model replies that it
   * cannot say, because a row count is not a quantity. Observed live before this
   * existed.
   *
   * The joined Sales Order path already sends both rankings for the same
   * reason. This is the generic path catching up, added here rather than in
   * `DataContextService` only because that file belongs to the AI Analyst.
   *
   * One measure, not all of them: six measures across four dimensions would be
   * 120 extra entries of prompt for a question nobody asked.
   */
  private topByMeasure(source: AnalystSource, cube: Cube | null): Record<string, unknown> {
    const measure = source.fields.find((f) => f.measure)?.key;
    if (!cube || !measure) return {};

    const out: Record<string, unknown> = {};
    for (const [dimension, groups] of Object.entries(cube.dims)) {
      const ranked = Object.entries(groups)
        .map(([value, group]) => ({ value, total: round(group.sums[measure] ?? 0) }))
        .filter((entry) => entry.total !== 0)
        .sort((a, b) => b.total - a.total)
        .slice(0, TOP_N);
      if (ranked.length) out[`top_${dimension}_by_${measure}`] = ranked;
    }
    return out;
  }

  // ── The joined path: Sales Order ─────────────────────────────────────────

  /**
   * The joined dataset, narrowed in memory.
   *
   * This path already reads every backorder line to total them exactly, so the
   * slice is applied to the rows in hand rather than pushed into OData. Two
   * consequences, both wanted: `coverage` stays `exact` for any slice, and
   * changing a date re-filters instantly instead of re-downloading the module.
   */
  private fromSalesOrders(
    filter: ChatReportFilter,
    slice: string | null,
  ): Observable<ContextPhase> {
    return concat(
      of<ContextPhase>({ phase: 'counting' }),
      this.backorderRows().pipe(
        map((rows) => ({
          phase: 'ready' as const,
          context: this.build(this.narrow(rows, filter), slice),
        })),
      ),
    );
  }

  private backorderRows(): Observable<SalesBackorderRecord[]> {
    this.backorders ??= this.salesOrders.getBackorders().pipe(
      map((response) => response.value ?? []),
      shareReplay({ bufferSize: 1, refCount: false }),
    );
    return this.backorders;
  }

  /** Apply the slice to rows already in memory. See {@link JOINED_SEARCH}. */
  private narrow(rows: SalesBackorderRecord[], filter: ChatReportFilter): SalesBackorderRecord[] {
    if (!hasSliceFilter(filter)) return rows;

    const from = filter.from ?? null;
    // The same inclusive-end rule the OData path applies, so the two agree.
    const toExclusive = exclusiveEnd(filter.to) ?? null;
    const term = filter.search?.trim().toLowerCase() ?? '';

    return rows.filter((row) => {
      if (from || toExclusive) {
        const day = isoDay(row[JOINED_DATE_FIELD]);
        // A row with no usable date cannot be shown to fall inside a window.
        if (!day) return false;
        if (from && day < from) return false;
        if (toExclusive && day >= toExclusive) return false;
      }

      if (!term) return true;

      return JOINED_SEARCH.some(({ name, mode }) => {
        const value = row[name];
        if (value == null) return false;
        const text = String(value).toLowerCase();
        return mode === 'prefix' ? text.startsWith(term) : text.includes(term);
      });
    });
  }

  private build(rows: SalesBackorderRecord[], slice: string | null): ReportDataContext {
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
      // Every row in the slice was read and totalled, so the sums are exact for
      // it — narrowing in memory does not cost the guarantee.
      coverage: 'exact',
      slice,
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
      const iso = isoDay(row[key]);
      if (!iso) continue;
      if (min === null || iso < min) min = iso;
      if (max === null || iso > max) max = iso;
    }

    return min !== null && max !== null ? { min, max } : null;
  }
}

/**
 * A row's date as `YYYY-MM-DD`, or null when it has none worth comparing.
 *
 * The `1900` guard is the D365 unset sentinel. It matters twice over here: it
 * keeps a fake century out of the reported date range, and it stops every
 * date-less row from being swept into a window that starts before 1900.
 */
function isoDay(raw: unknown): string | null {
  if (typeof raw !== 'string' || !raw) return null;
  const date = new Date(raw);
  if (Number.isNaN(date.getTime()) || date.getUTCFullYear() <= 1900) return null;
  return date.toISOString().slice(0, 10);
}

/**
 * Turn the user's inclusive end date into the exclusive bound the query wants.
 *
 * `dateRange` emits `lt to`, so passing "31 March" through unchanged drops
 * every row dated 31 March — the day the user explicitly asked to include.
 * See {@link ChatReportFilter}.
 */
function exclusiveEnd(to?: string): string | undefined {
  if (!to) return undefined;
  const date = new Date(`${to}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return undefined;
  date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString().slice(0, 10);
}

function toEntry(datum: { label: string; value: number }): { value: string; total: number } {
  return { value: datum.label, total: round(datum.value) };
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}
