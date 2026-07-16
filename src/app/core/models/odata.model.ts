/** Shape of a standard D365 OData collection response. */
export interface ODataResponse<T> {
  '@odata.context'?: string;
  '@odata.count'?: number;
  '@odata.nextLink'?: string;
  value: T[];
}

/** OData query options accepted by {@link ApiService.getCollection}. */
export interface ODataQuery {
  filter?: string;
  select?: string;
  orderby?: string;
  top?: number;
  skip?: number;
  count?: boolean;
  /** Adds `cross-company=true` so the query spans all legal entities. */
  crossCompany?: boolean;
}

/**
 * One page of a collection, with the two annotations the old code requested and
 * then threw away.
 *
 * `total` is the server's count for the query's `$filter` — the whole dataset,
 * not this page. `nextLink` is present whenever the server has more rows than it
 * returned. D365 caps every response at a **10,000-row server page**, so for any
 * sizeable entity `rows.length < total` is the normal case, not the exception.
 * Callers MUST NOT present an aggregate over `rows` as if it covered `total`.
 */
export interface ODataPage<T> {
  rows: T[];
  total?: number;
  nextLink?: string;
}

/** D365's hard server-side page cap. Asking for more silently yields this many. */
export const D365_MAX_PAGE_SIZE = 10_000;
