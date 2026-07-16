import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import { ApiService } from '../../../core/http/api.service';
import { ODataPage } from '../../../core/models/odata.model';
import { and, buildSearchFilter, dateRange } from '../../../core/http/odata-filter.util';
import { environment } from '../../../../environments/environment';
import {
  ShatatSerialTransRecord,
  SHATAT_SEARCH_FIELDS,
  SHATAT_SERIAL_TRANS_SELECT,
} from '../models/shatat-serial-trans.model';

/** What the user has narrowed the 11M rows down to. */
export interface ShatatQuery {
  search?: string;
  from?: string;
  to?: string;
  skip?: number;
  top?: number;
}

/**
 * Data access for the Shatat UAT `Sha_SerialTrans` entity — a SECOND D365 source.
 *
 * **This entity has ~11,000,000 rows.** It previously loaded with `top: 5000` and
 * presented the result as the whole dataset, so every KPI computed from it was
 * wrong. There is no unpaged accessor here any more, and there must not be one:
 * everything is either a count (zero rows) or an explicit page.
 */
@Injectable({ providedIn: 'root' })
export class ShatatSerialTransService {
  private readonly api = inject(ApiService);

  private static readonly ENTITY = 'Sha_SerialTrans';
  private readonly path = environment.shatat.dataPath;

  /** The always-on company filter, ANDed under everything else. */
  private get base(): string {
    return `dataAreaId eq '${environment.shatat.company}'`;
  }

  /** Compose the full `$filter` for a user query. Exposed so callers can count it first. */
  buildFilter(q: ShatatQuery = {}): string {
    return (
      and(
        this.base,
        dateRange('TransDate', q.from, q.to),
        buildSearchFilter(q.search ?? '', SHATAT_SEARCH_FIELDS),
      ) ?? this.base
    );
  }

  /**
   * How many rows match — **without transferring any**. ~0.3-8 s even at 11M.
   * Every "can we analyse this?" decision starts here.
   */
  count(q: ShatatQuery = {}): Observable<number> {
    return this.api.getCount(ShatatSerialTransService.ENTITY, this.buildFilter(q), this.path, true);
  }

  /** One page of rows for the detail table, plus the true total for the filter. */
  getPage(q: ShatatQuery = {}): Observable<ODataPage<ShatatSerialTransRecord>> {
    return this.api.getPage<ShatatSerialTransRecord>(
      ShatatSerialTransService.ENTITY,
      {
        filter: this.buildFilter(q),
        select: SHATAT_SERIAL_TRANS_SELECT,
        orderby: 'SerialTransRecId desc',
        top: q.top ?? 25,
        skip: q.skip ?? 0,
        count: true,
        crossCompany: true,
      },
      this.path,
    );
  }

  /** Oldest / newest transaction date for a filter. One row each, ~260 ms. */
  dateBounds(q: ShatatQuery = {}): Observable<string | undefined>[] {
    const filter = this.buildFilter(q);
    return (['asc', 'desc'] as const).map((dir) =>
      this.api.getExtreme<string>(
        ShatatSerialTransService.ENTITY,
        'TransDate',
        dir,
        filter,
        this.path,
        true,
      ),
    );
  }

  /** A handful of real rows, for the LLM's schema sample. Never more. */
  sample(q: ShatatQuery = {}, rows = 5): Observable<ODataPage<ShatatSerialTransRecord>> {
    return this.getPage({ ...q, top: rows, skip: 0 });
  }
}
