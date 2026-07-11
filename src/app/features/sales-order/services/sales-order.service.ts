import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import { ApiService } from '../../../core/http/api.service';
import { ODataResponse } from '../../../core/models/odata.model';
import { environment } from '../../../../environments/environment';
import { SalesBackorderRecord, SALES_SELECT_FIELDS } from '../models/sales-order.model';

/**
 * Data access for the sales-order report. Owns the OData query shape and
 * delegates all HTTP to {@link ApiService}. No presentation logic lives here.
 */
@Injectable({ providedIn: 'root' })
export class SalesOrderService {
  private readonly api = inject(ApiService);

  private static readonly ENTITY = 'GP_SalesHeaderAndLineData';

  /** Open backorders with remaining physical inventory in the default company. */
  private get backorderFilter(): string {
    return (
      `dataAreaId eq '${environment.defaultCompany}' and RemainInventPhysical gt 0 ` +
      `and SalesTable_SalesStatus eq Microsoft.Dynamics.DataEntities.SalesStatus'Backorder' ` +
      `and SalesStatus eq Microsoft.Dynamics.DataEntities.SalesStatus'Backorder'`
    );
  }

  /** Load the full backorder dataset for client-side aggregation. */
  getBackorders(): Observable<ODataResponse<SalesBackorderRecord>> {
    return this.api.getCollection<SalesBackorderRecord>(SalesOrderService.ENTITY, {
      filter: this.backorderFilter,
      select: SALES_SELECT_FIELDS,
      orderby: 'SalesId desc',
      count: true,
    });
  }
}
