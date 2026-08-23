import { Injectable, inject } from '@angular/core';
import { Observable, forkJoin, map, of } from 'rxjs';
import { ApiService } from '../../../core/http/api.service';
import { ODataResponse } from '../../../core/models/odata.model';
import { environment } from '../../../../environments/environment';
import {
  SalesBackorderRecord,
  SalesHeaderRecord,
  SALES_HEADER_SELECT_FIELDS,
  SALES_LINE_SELECT_FIELDS,
  SALES_SELECT_FIELDS,
  salesOrderKey,
} from '../models/sales-order.model';

/** D365 rejects a bare string on an enum — the literal has to be type-qualified. */
const BACKORDER = "Microsoft.Dynamics.DataEntities.SalesStatus'Backorder'";

/**
 * Data access for the sales-order report. Owns the OData query shape and
 * delegates all HTTP to {@link ApiService}. No presentation logic lives here.
 *
 * **Which D365 environment this reads is not decided here.** Host, credentials,
 * legal entity and entity names all come from `environment.salesOrder`, so
 * moving the report between tenants is a config change. The auth interceptor
 * picks the matching credentials off `dataPath`.
 *
 * Two source shapes are supported, because the two tenants do not publish the
 * same thing:
 *
 * - **Composite** (`headerEntity` unset) — Growpath's `GP_SalesHeaderAndLineData`
 *   already returns header and line together. One request.
 * - **Split** (`headerEntity` set) — Shatat has no such entity, so the lines come
 *   from `SalesLineBiEntities` and the header columns from `SalesTableBiEntities`,
 *   joined here on `(dataAreaId, SalesId)`. Two requests, folded into the same
 *   {@link SalesBackorderRecord} shape so nothing above this service changes.
 *
 * The header request is filtered, not keyed off the returned line ids: an
 * `SalesId in (...)` list would grow the URL without bound, and the same
 * backorder filter bounds it to the orders we could possibly need anyway.
 */
@Injectable({ providedIn: 'root' })
export class SalesOrderService {
  private readonly api = inject(ApiService);

  private readonly config = environment.salesOrder;
  private readonly source = environment.salesOrder.source;

  /** Open backorder LINES: remaining physical inventory, line still on backorder. */
  private get lineFilter(): string {
    const composite = !this.config.headerEntity;
    // The composite entity carries the header status too, so it can be asserted
    // in the same pass. On a split source that half is the header query's job.
    const headerStatus = composite ? ` and SalesTable_SalesStatus eq ${BACKORDER}` : '';
    return (
      `dataAreaId eq '${this.config.company}' and RemainInventPhysical gt 0` +
      `${headerStatus} and SalesStatus eq ${BACKORDER}`
    );
  }

  /** Open backorder HEADERS — split sources only. */
  private get headerFilter(): string {
    return `dataAreaId eq '${this.config.company}' and SalesStatus eq ${BACKORDER}`;
  }

  /** Load the full backorder dataset for client-side aggregation. */
  getBackorders(): Observable<ODataResponse<SalesBackorderRecord>> {
    const lines$ = this.api.getCollection<SalesBackorderRecord>(
      this.config.lineEntity,
      {
        filter: this.lineFilter,
        select: this.config.headerEntity ? SALES_LINE_SELECT_FIELDS : SALES_SELECT_FIELDS,
        orderby: 'SalesId desc',
        count: true,
        crossCompany: this.source.crossCompany,
      },
      this.source.dataPath,
    );

    if (!this.config.headerEntity) return lines$;

    return forkJoin({ lines: lines$, headers: this.getHeaders() }).pipe(
      map(({ lines, headers }) => ({
        ...lines,
        value: lines.value.map((line) => this.merge(line, headers.get(salesOrderKey(line)))),
      })),
    );
  }

  /** Header rows for the backorder set, indexed by `(dataAreaId, SalesId)`. */
  private getHeaders(): Observable<Map<string, SalesHeaderRecord>> {
    const entity = this.config.headerEntity;
    if (!entity) return of(new Map());

    return this.api
      .getCollection<SalesHeaderRecord>(
        entity,
        {
          filter: this.headerFilter,
          select: SALES_HEADER_SELECT_FIELDS,
          crossCompany: this.source.crossCompany,
        },
        this.source.dataPath,
      )
      .pipe(map((r) => new Map((r.value ?? []).map((h) => [salesOrderKey(h), h]))));
  }

  /**
   * Fold a header row into its line. A missing header is not an error — the line
   * simply keeps whatever it already had, so the report degrades to line-level
   * detail instead of dropping the row.
   */
  private merge(
    line: SalesBackorderRecord,
    header: SalesHeaderRecord | undefined,
  ): SalesBackorderRecord {
    if (!header) return line;
    return {
      ...line,
      SalesTable_SalesName: header.SalesName,
      SalesTable_InvoiceAccount: header.InvoiceAccount,
      SalesTable_SalesStatus: header.SalesStatus,
      SalesTable_DocumentStatus: header.DocumentStatus,
      SalesTable_DeliveryDate: header.DeliveryDate,
    };
  }
}
