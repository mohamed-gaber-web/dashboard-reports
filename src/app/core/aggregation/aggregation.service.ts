import { Injectable, inject } from '@angular/core';
import { Observable, from, switchMap } from 'rxjs';
import { AuthConfig, AuthService } from '../auth/auth.service';
import {
  AggregatePlan,
  AggregateProgress,
  Cube,
  MAX_ANALYZE_ROWS,
  WorkerResponse,
} from './aggregate-plan.model';

/** Thrown when a slice is too big to fold in the browser. Carries the numbers to say so. */
export class SliceTooLargeError extends Error {
  constructor(
    readonly rows: number,
    readonly limit: number,
  ) {
    super(
      `This filter matches ${rows.toLocaleString()} rows. ` +
        `Up to ${limit.toLocaleString()} can be analysed at once — narrow it first.`,
    );
    this.name = 'SliceTooLargeError';
  }
}

/**
 * Runs the streaming fold that gives us SUM / GROUP BY, which D365 OData cannot do.
 *
 * The gate is the point. `$count` is free, so we always know the exact size of a
 * slice before committing to it — and we refuse anything over
 * {@link MAX_ANALYZE_ROWS} rather than starting a 20-minute crawl behind a
 * spinner. Refusing with a real number ("11,975,316 rows — narrow this") is more
 * useful than a progress bar that never finishes, and far more honest than
 * quietly folding the first 5,000 and calling it the answer, which is what the
 * app used to do.
 */
@Injectable({ providedIn: 'root' })
export class AggregationService {
  private readonly auth = inject(AuthService);

  private worker?: Worker;

  /**
   * Fold a slice into a {@link Cube}, emitting progress as pages land.
   *
   * @throws SliceTooLargeError if `totalRows` exceeds the analysable limit.
   */
  fold(
    plan: Omit<AggregatePlan, 'token'>,
    authConfig: AuthConfig,
    limit = MAX_ANALYZE_ROWS,
  ): Observable<AggregateProgress> {
    if (plan.totalRows > limit) {
      throw new SliceTooLargeError(plan.totalRows, limit);
    }

    return from(this.auth.getToken(authConfig)).pipe(
      switchMap((token) => this.runWorker({ ...plan, token })),
    );
  }

  /** Abort an in-flight fold — e.g. the user changed the filter or left the page. */
  cancel(): void {
    this.worker?.postMessage({ type: 'cancel' });
    this.worker?.terminate();
    this.worker = undefined;
  }

  private runWorker(plan: AggregatePlan): Observable<AggregateProgress> {
    return new Observable<AggregateProgress>((subscriber) => {
      this.cancel();

      const worker = new Worker(new URL('./aggregation.worker', import.meta.url), {
        type: 'module',
      });
      this.worker = worker;

      worker.onmessage = ({ data }: MessageEvent<WorkerResponse>) => {
        switch (data.type) {
          case 'progress':
            subscriber.next({ loaded: data.loaded, total: data.total });
            break;
          case 'done':
            subscriber.next({
              loaded: data.cube.rowsFolded,
              total: data.cube.totalRows,
              cube: data.cube,
            });
            subscriber.complete();
            break;
          case 'error':
            subscriber.error(new Error(data.message));
            break;
        }
      };

      worker.onerror = (e) => subscriber.error(new Error(e.message || 'Aggregation worker failed'));

      worker.postMessage({ type: 'run', plan });

      return () => {
        worker.terminate();
        if (this.worker === worker) this.worker = undefined;
      };
    });
  }
}

/** Group entries of one cube dimension, sorted desc, with an EXACT "Other" bucket. */
export function cubeTopN(
  cube: Cube,
  dimension: string,
  measure: string | undefined,
  topN = 8,
): { label: string; value: number }[] {
  const bucket = cube.dims[dimension];
  if (!bucket) return [];

  const ranked = Object.entries(bucket)
    .map(([label, g]) => ({ label, value: measure ? (g.sums[measure] ?? 0) : g.count }))
    .sort((a, b) => b.value - a.value);

  if (ranked.length <= topN) return ranked;

  // The cube holds every key, so the tail is a true total rather than an estimate.
  const head = ranked.slice(0, topN - 1);
  const other = ranked.slice(topN - 1).reduce((sum, d) => sum + d.value, 0);
  return [...head, { label: 'Other', value: other }];
}
