import { Injectable, inject } from '@angular/core';
import { HttpClient, HttpParams } from '@angular/common/http';
import { Observable } from 'rxjs';
import { environment } from '../../../environments/environment';
import { ODataQuery, ODataResponse } from '../models/odata.model';

/**
 * The single place HTTP is spoken to D365. Feature services depend on this,
 * never on HttpClient directly (Dependency Inversion + one integration seam).
 * The auth interceptor attaches the bearer token to every `/data` request.
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

  /** Follow an absolute `@odata.nextLink` for server-driven paging. */
  getByUrl<T>(url: string): Observable<T> {
    return this.http.get<T>(url);
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
