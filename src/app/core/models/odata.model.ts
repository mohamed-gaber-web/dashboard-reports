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
