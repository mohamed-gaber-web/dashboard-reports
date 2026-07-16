import { Injectable, inject } from '@angular/core';
import { Observable, filter as rxFilter, forkJoin, map, of } from 'rxjs';
import { ApiService } from '../../../core/http/api.service';
import { and, buildSearchFilter, dateRange } from '../../../core/http/odata-filter.util';
import { ODataPage } from '../../../core/models/odata.model';
import { AggregateProgress, Cube } from '../../../core/aggregation/aggregate-plan.model';
import { AggregationService } from '../../../core/aggregation/aggregation.service';
import { AnalystFilter, AnalystSource } from '../models/analyst-source.model';

type Row = Record<string, unknown>;

/** Oldest and newest value of the source's date field, for a given filter. */
export interface DateBounds {
  min?: string;
  max?: string;
}

/**
 * Every read the AI Analyst makes, for any source.
 *
 * The shape of this service is dictated by what D365 F&O OData can actually do.
 * It has **no `$apply`, no `groupby`, no `SUM`** — and it does not even fail
 * loudly: `$apply` is silently ignored and rows come back with HTTP 200. What it
 * does give us, all measured against the live 11M-row entity:
 *
 * - `$count`              → exact total, **zero rows**, ~0.3–8 s. {@link count}
 * - `$orderby` + `$top=1` → min/max of any field, one row, ~260 ms. {@link dateBounds}
 * - `$top`/`$skip`        → a bounded page; deep skip costs no more than shallow. {@link page}
 *
 * SUM and GROUP BY are the only gap, and {@link fold} fills it with a Worker that
 * reads pages and throws them away. Because `count()` is free, we always price
 * that fold before running it.
 *
 * Each read comes in two flavours: one taking the user's {@link AnalystFilter},
 * and a `*Raw` one taking a literal `$filter`. The raw variants exist because the
 * LLM's `ReportSpec` can add clauses that have no `AnalystFilter` representation.
 */
@Injectable({ providedIn: 'root' })
export class AnalystDataService {
  private readonly api = inject(ApiService);
  private readonly aggregation = inject(AggregationService);

  /** The full `$filter` for a source plus the user's narrowing. */
  buildFilter(source: AnalystSource, filter: AnalystFilter = {}): string {
    return (
      and(
        source.baseFilter,
        source.dateField ? dateRange(source.dateField, filter.from, filter.to) : null,
        buildSearchFilter(filter.search ?? '', source.searchFields),
      ) ?? source.baseFilter
    );
  }

  // ── Count ────────────────────────────────────────────────────────────────
  /**
   * How many rows match — **without transferring any**.
   *
   * The load-bearing call. It is what lets the UI say "your filter matches
   * 10,975,316 rows, narrow it" *before* committing to a fold, instead of
   * silently analysing the first 5,000 and calling it the answer.
   */
  count(source: AnalystSource, filter: AnalystFilter = {}): Observable<number> {
    return this.countRaw(source, this.buildFilter(source, filter));
  }

  countRaw(source: AnalystSource, filter: string): Observable<number> {
    return this.api.getCount(source.entity, filter, source.dataPath, source.crossCompany);
  }

  // ── Pages ────────────────────────────────────────────────────────────────
  /** One page of rows for the detail table, carrying the true total for the filter. */
  page(
    source: AnalystSource,
    filter: AnalystFilter = {},
    skip = 0,
    top = 25,
  ): Observable<ODataPage<Row>> {
    return this.pageRaw(source, this.buildFilter(source, filter), skip, top);
  }

  pageRaw(source: AnalystSource, filter: string, skip = 0, top = 25): Observable<ODataPage<Row>> {
    return this.api.getPage<Row>(
      source.entity,
      {
        filter,
        select: source.select,
        orderby: source.keyField.map((k) => `${k} desc`).join(','),
        top,
        skip,
        count: true,
        crossCompany: source.crossCompany,
      },
      source.dataPath,
    );
  }

  /** A few real rows for the LLM's schema sample. Never more than a handful. */
  sample(source: AnalystSource, filter: AnalystFilter = {}, rows = 5): Observable<Row[]> {
    return this.page(source, filter, 0, rows).pipe(map((p) => p.rows));
  }

  // ── Dates ────────────────────────────────────────────────────────────────
  /**
   * Oldest / newest date under a filter — two one-row queries.
   * D365 has no `min()`/`max()`, but `$orderby=F asc&$top=1` *is* exactly that,
   * and it runs in ~260 ms even across 11M rows.
   */
  dateBounds(source: AnalystSource, filter: AnalystFilter = {}): Observable<DateBounds> {
    return this.dateBoundsRaw(source, this.buildFilter(source, filter));
  }

  dateBoundsRaw(source: AnalystSource, filter: string): Observable<DateBounds> {
    if (!source.dateField) return of({});

    const field = source.dateField;
    const extreme = (direction: 'asc' | 'desc') =>
      this.api.getExtreme<string>(
        source.entity,
        field,
        direction,
        filter,
        source.dataPath,
        source.crossCompany,
      );

    return forkJoin({ min: extreme('asc'), max: extreme('desc') });
  }

  // ── The fold (SUM / GROUP BY) ────────────────────────────────────────────
  /**
   * Fold a slice into a {@link Cube} — the SUM / GROUP BY that OData won't do.
   *
   * Dimensions and measures come from the source's own `FieldMeta`, so a single
   * fold answers every KPI and chart the LLM can ask for without re-reading D365.
   * Throws `SliceTooLargeError` if `totalRows` exceeds the limit; callers are
   * expected to have counted first.
   */
  fold(
    source: AnalystSource,
    filter: AnalystFilter,
    totalRows: number,
  ): Observable<AggregateProgress> {
    return this.foldRaw(source, this.buildFilter(source, filter), totalRows);
  }

  foldRaw(source: AnalystSource, filter: string, totalRows: number): Observable<AggregateProgress> {
    return this.aggregation.fold(
      {
        entity: source.entity,
        dataPath: source.dataPath,
        filter,
        crossCompany: source.crossCompany,
        keyField: source.keyField,
        dimensions: source.fields.filter((f) => f.dimension).map((f) => f.key),
        measures: source.fields.filter((f) => f.measure).map((f) => f.key),
        totalRows,
      },
      source.authConfig,
    );
  }

  /** Just the finished cube, for callers that don't render progress. */
  foldToCube(source: AnalystSource, filter: string, totalRows: number): Observable<Cube> {
    return this.foldRaw(source, filter, totalRows).pipe(
      map((p) => p.cube),
      rxFilter((c): c is Cube => !!c),
    );
  }

  cancelFold(): void {
    this.aggregation.cancel();
  }
}
