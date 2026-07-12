import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import { ApiService } from '../../../core/http/api.service';
import { ODataResponse } from '../../../core/models/odata.model';
import { environment } from '../../../../environments/environment';
import {
  ShatatSerialTransRecord,
  SHATAT_SERIAL_TRANS_SELECT,
} from '../models/shatat-serial-trans.model';

/**
 * Data access for the Shatat UAT `Sha_SerialTrans` entity — a SECOND D365
 * source. Mirrors {@link SalesOrderService}, but targets the Shatat host via
 * `environment.shatat.dataPath` and runs cross-company. All HTTP goes through
 * {@link ApiService}; the auth interceptor attaches the Shatat token.
 */
@Injectable({ providedIn: 'root' })
export class ShatatSerialTransService {
  private readonly api = inject(ApiService);

  private static readonly ENTITY = 'Sha_SerialTrans';

  /**
   * Serial transactions for the Shatat company. Capped at 5000 rows — the AI
   * Analyst only needs aggregates + a sample, and the entity can be very large.
   */
  getSerialTrans(): Observable<ODataResponse<ShatatSerialTransRecord>> {
    return this.api.getCollection<ShatatSerialTransRecord>(
      ShatatSerialTransService.ENTITY,
      {
        filter: `dataAreaId eq '${environment.shatat.company}'`,
        select: SHATAT_SERIAL_TRANS_SELECT,
        crossCompany: true,
        top: 5000,
        count: true,
      },
      environment.shatat.dataPath,
    );
  }
}
