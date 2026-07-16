import { AuthConfig } from '../../../core/auth/auth.service';
import { SearchField } from '../../../core/http/odata-filter.util';
import { FieldMeta } from './field-meta.model';

/**
 * A dataset the AI Analyst can chat against (one per tab).
 *
 * This is a **query descriptor, not a loader.** The old shape had a
 * `load(): Observable<ODataResponse<Row>>` that pulled the whole entity into
 * memory. That is impossible here: `Sha_SerialTrans` has ~11,000,000 rows, and
 * D365 caps a response at 10,000, so `load()` returned a truncated slice which
 * the app then presented as the complete dataset.
 *
 * Instead a source describes *how to query* — and every read is either a count
 * (zero rows) or an explicit, bounded page.
 */
export interface AnalystSource {
  id: string;
  label: string;
  fields: FieldMeta[];
  suggestions: string[];

  /** OData entity name. */
  entity: string;
  /** Same-origin prefix the proxy/rewrite forwards to this host's `/data`. */
  dataPath: string;
  /** Azure AD config for this tenant — each source has its own app registration. */
  authConfig: AuthConfig;
  crossCompany: boolean;

  /** Always-on filter (company, status, …). Everything else is ANDed under it. */
  baseFilter: string;

  /**
   * The entity's unique key, in order (e.g. `['SalesId', 'LineNum']`). Required:
   * `$skip` paging is only correct under a *total* order, and the fold pages with
   * `$skip`.
   */
  keyField: string[];

  /** `$select` for the human-readable detail table. */
  select: string;

  /** Fields the search box queries, and how. Prefer `prefix` — see odata-filter.util. */
  searchFields: SearchField[];

  /** The date field to window on, if the source has one. */
  dateField?: string;

  /** The field holding a currency code, if any. Sales Order has one; Shatat does not. */
  currencyField?: string;
}

/** What the user has narrowed a source down to. */
export interface AnalystFilter {
  search?: string;
  from?: string;
  to?: string;
}
