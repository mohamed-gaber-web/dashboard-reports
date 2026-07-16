/**
 * A declarative "fold this slice" job.
 *
 * D365 F&O OData has **no `$apply`, no `groupby`, no `aggregate`** — worse, it
 * SILENTLY IGNORES `$apply` and returns raw rows with HTTP 200, so the gap cannot
 * even be feature-detected. SUM and GROUP BY therefore have to be computed by
 * reading rows. The trick is that we read them without ever *keeping* them: pull
 * a page, fold it into accumulators, throw the page away. Memory is O(groups),
 * not O(rows).
 *
 * That still costs one HTTP round-trip per 10,000 rows, so it does not scale to
 * the full 11M entity (~1,100 pages, ~1 GB, ~20 min even parallelised). Hence
 * {@link MAX_ANALYZE_ROWS}: the caller must narrow the filter first, and we
 * always know the exact cost up front because `$count` is free.
 */

/** One page = D365's hard server cap. Asking for more silently yields this many. */
export const PAGE_SIZE = 10_000;

/**
 * How many pages to keep in flight. Deep `$skip` was measured to cost the same as
 * a shallow one on this entity (~8 s at row 5,000,000 vs ~9 s at row 0), so pages
 * are independent and can be fetched concurrently rather than chained on nextLink.
 */
export const CONCURRENCY = 6;

/**
 * The largest slice we will fold in the browser.
 *
 * 250,000 rows = 25 pages ≈ 30 s at 6-way concurrency. Beyond this the wait stops
 * being honest UI and starts being a hang, so we refuse and tell the user to
 * narrow their filter — `$count` tells us which side of the line we're on for
 * free, before a single row moves.
 */
export const MAX_ANALYZE_ROWS = 250_000;

export interface AggregatePlan {
  entity: string;
  dataPath: string;
  /** The `$filter` this fold covers. The cube is only valid for exactly this. */
  filter: string;
  crossCompany?: boolean;
  /**
   * The entity's unique key, in order (e.g. `['SalesId', 'LineNum']`).
   *
   * **Required**: `$skip` only partitions a set cleanly under a *total* order.
   * Sort by a non-unique column and the server may hand back overlapping or
   * missing rows across pages — and the fold would be quietly wrong, which is
   * the exact failure mode this whole layer exists to eliminate.
   */
  keyField: string[];
  /** Fields to group by. Kept narrow — every one widens the `$select`. */
  dimensions: string[];
  /** Numeric fields to sum. */
  measures: string[];
  /** From `$count`, so the worker can report real progress and page in parallel. */
  totalRows: number;
  /** Bearer token. Minted on the main thread; the worker never talks to Azure AD. */
  token: string;
}

/** Running totals for one measure across the whole slice. */
export interface MeasureTotal {
  sum: number;
  count: number;
}

/** One group's accumulators — a row count plus a sum per measure. */
export interface GroupTotal {
  count: number;
  sums: Record<string, number>;
}

/**
 * The folded result. Small: a few hundred groups per dimension, not 11M rows.
 * Everything the report engine needs comes out of this without re-reading D365.
 *
 * `dims` holds EVERY key, not a top-N slice — so a chart's "Other" bucket is
 * exact rather than an estimate.
 */
export interface Cube {
  filter: string;
  builtAt: number;
  /** Rows actually folded. Equals `totalRows` unless the fold was cancelled. */
  rowsFolded: number;
  /** `$count` at build time — used to detect that the source has drifted. */
  totalRows: number;
  totals: Record<string, MeasureTotal>;
  dims: Record<string, Record<string, GroupTotal>>;
}

export interface AggregateProgress {
  loaded: number;
  total: number;
  /** Populated only on the final emission. */
  cube?: Cube;
}

/** Worker protocol. */
export type WorkerRequest = { type: 'run'; plan: AggregatePlan } | { type: 'cancel' };

export type WorkerResponse =
  | { type: 'progress'; loaded: number; total: number }
  | { type: 'done'; cube: Cube }
  | { type: 'error'; message: string };
