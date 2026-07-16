import { Injectable, inject } from '@angular/core';
import { HttpClient, HttpParams } from '@angular/common/http';
import { EMPTY, Observable, expand, map } from 'rxjs';
import { environment } from '../../../environments/environment';
import { D365_MAX_PAGE_SIZE, ODataPage, ODataQuery, ODataResponse } from '../models/odata.model';

/**
 * The single place HTTP is spoken to D365. Feature services depend on this,
 * never on HttpClient directly (Dependency Inversion + one integration seam).
 * The auth interceptor attaches the bearer token to every `/data` request.
 *
 * ## The rule this service exists to enforce
 *
 * D365 caps EVERY response at a 10,000-row server page and hands back the rest
 * behind `@odata.nextLink`. An entity here has ~11M rows. So a bare
 * `getCollection()` returns a truncated slice, and aggregating over that slice
 * produces a confident, wrong number. Prefer, in order:
 *
 * 1. {@link getCount} — a total for a `$filter` without transferring a single row.
 * 2. {@link getPage}  — one page, carrying `total` so the caller knows what it's missing.
 * 3. {@link streamPages} — every page, emitted one at a time, for a fold that
 *    discards rows as it goes. NEVER accumulate these into one array.
 */
@Injectable({ providedIn: 'root' })
export class ApiService {
  private readonly http = inject(HttpClient);
  private readonly baseUrl = environment.apiBaseUrl;

  /**
   * Query an OData entity collection with typed query options.
   *
   * `dataPath` selects which D365 source to hit — it defaults to `/data`
   * (the primary source). A second source passes its own prefix (e.g.
   * `/shatat-data`), which the proxy/rewrite forwards to that host's `/data`.
   *
   * Returns the raw response. Callers that care about completeness — which is
   * most of them — should use {@link getPage} instead, so the truncation is visible.
   */
  getCollection<T>(
    entity: string,
    query: ODataQuery = {},
    dataPath = '/data',
  ): Observable<ODataResponse<T>> {
    return this.http.get<ODataResponse<T>>(`${this.baseUrl}${dataPath}/${entity}`, {
      params: this.toParams(query),
    });
  }

  /**
   * Exact server-side row count for a filter. **Transfers zero rows.**
   *
   * This is the one true aggregate D365 gives us — `$apply`/`groupby` are not
   * supported (D365 silently IGNORES `$apply` and returns rows instead, so it
   * cannot even be feature-detected by catching an error). Measured at ~0.3-8 s
   * against an 11M-row entity, and it is the basis of every "is this slice small
   * enough to analyse?" decision in the app.
   */
  getCount(
    entity: string,
    filter?: string,
    dataPath = '/data',
    crossCompany = false,
  ): Observable<number> {
    return this.getCollection<never>(
      entity,
      { filter, count: true, top: 0, crossCompany },
      dataPath,
    ).pipe(map((r) => r['@odata.count'] ?? 0));
  }

  /**
   * The value of `field` in the first row when ordered by it — i.e. the min
   * (`asc`) or max (`desc`). One row over the wire, no aggregation needed.
   * This is how we get a date range out of 11M rows in ~260 ms.
   */
  getExtreme<T = unknown>(
    entity: string,
    field: string,
    direction: 'asc' | 'desc',
    filter?: string,
    dataPath = '/data',
    crossCompany = false,
  ): Observable<T | undefined> {
    return this.getCollection<Record<string, unknown>>(
      entity,
      { filter, orderby: `${field} ${direction}`, top: 1, select: field, crossCompany },
      dataPath,
    ).pipe(map((r) => r.value[0]?.[field] as T | undefined));
  }

  /**
   * One page, with `@odata.count` and `@odata.nextLink` preserved rather than
   * discarded. `total` is the count for the whole filter, not this page.
   */
  getPage<T>(entity: string, query: ODataQuery = {}, dataPath = '/data'): Observable<ODataPage<T>> {
    return this.getCollection<T>(entity, query, dataPath).pipe(
      map((r) => this.toPage<T>(r, dataPath)),
    );
  }

  /**
   * Emit every page of a query, following `@odata.nextLink` until exhausted.
   *
   * **The subscriber must fold and discard.** Collecting these into a single
   * array re-creates the out-of-memory bug this exists to prevent: 11M rows is
   * ~1 GB even with a narrow `$select`.
   *
   * `maxPages` is a hard stop so a mistake costs a bounded number of requests
   * rather than an hour of them. It is a safety net, not a paging strategy —
   * when it trips, the caller has asked for more than it should have.
   */
  streamPages<T>(
    entity: string,
    query: ODataQuery = {},
    dataPath = '/data',
    maxPages = 200,
  ): Observable<ODataPage<T>> {
    const first: ODataQuery = { ...query, top: query.top ?? D365_MAX_PAGE_SIZE, count: true };
    let pages = 0;

    return this.getPage<T>(entity, first, dataPath).pipe(
      expand((page) => {
        if (!page.nextLink || ++pages >= maxPages) return EMPTY;
        return this.getByUrl<ODataResponse<T>>(page.nextLink).pipe(
          map((r) => this.toPage<T>(r, dataPath)),
        );
      }),
    );
  }

  /**
   * Follow an absolute `@odata.nextLink`.
   *
   * D365 returns an ABSOLUTE url pointing straight at the D365 host. The browser
   * cannot call that: it would bypass the dev proxy / Vercel rewrite, and those
   * exist to strip the `Origin` header (the AADSTS9002326 rejection) and to keep
   * request headers small (the 431). So the link is rewritten back to a
   * same-origin path before it is used.
   */
  getByUrl<T>(url: string, dataPath = '/data'): Observable<T> {
    return this.http.get<T>(this.toSameOrigin(url, dataPath));
  }

  /**
   * `https://host/data/Entity?$x=1` -> `/shatat-data/Entity?$x=1`
   *
   * Anything already relative is passed through untouched.
   */
  private toSameOrigin(absolute: string, dataPath: string): string {
    if (!/^https?:\/\//i.test(absolute)) return absolute;
    const u = new URL(absolute);
    const afterData = u.pathname.replace(/^\/data/, '');
    return `${this.baseUrl}${dataPath}${afterData}${u.search}`;
  }

  private toPage<T>(r: ODataResponse<T>, dataPath: string): ODataPage<T> {
    const nextLink = r['@odata.nextLink'];
    return {
      rows: r.value ?? [],
      total: r['@odata.count'],
      nextLink: nextLink ? this.toSameOrigin(nextLink, dataPath) : undefined,
    };
  }

  private toParams(query: ODataQuery): HttpParams {
    let params = new HttpParams();
    if (query.filter) params = params.set('$filter', query.filter);
    if (query.select) params = params.set('$select', query.select);
    if (query.orderby) params = params.set('$orderby', query.orderby);
    if (query.top != null) params = params.set('$top', String(query.top));
    if (query.skip != null) params = params.set('$skip', String(query.skip));
    if (query.count) params = params.set('$count', 'true');
    // D365 uses the plain `cross-company` param, not a `$`-prefixed OData option.
    if (query.crossCompany) params = params.set('cross-company', 'true');
    return params;
  }
}
