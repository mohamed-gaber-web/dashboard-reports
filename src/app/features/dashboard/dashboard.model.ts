import { Injectable, DestroyRef, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ReportRegistryService } from '../../core/reporting/report-registry.service';
import { SalesOrderService } from '../sales-order/services/sales-order.service';
import { distinctCount } from '../../shared/utils/group-by.util';
import { formatInteger, formatQuantity } from '../../shared/utils/format.util';

/**
 * ViewModel for the overview page. Reads the module registry and pulls a light
 * summary from each reporting service (currently Sales Orders) so the landing
 * page shows live headline numbers without duplicating any query logic.
 */
@Injectable()
export class DashboardModel {
  private readonly registry = inject(ReportRegistryService);
  private readonly sales = inject(SalesOrderService);
  private readonly destroyRef = inject(DestroyRef);

  readonly modules = this.registry.modules;
  readonly moduleCount = computed(() => formatInteger(this.registry.count()));

  private readonly _loading = signal(true);
  private readonly _lines = signal(0);
  private readonly _units = signal(0);
  private readonly _customers = signal(0);

  readonly loading = this._loading.asReadonly();
  readonly salesLines = computed(() => formatInteger(this._lines()));
  readonly salesUnits = computed(() => formatQuantity(this._units()));
  readonly salesCustomers = computed(() => formatInteger(this._customers()));

  constructor() {
    this.sales
      .getBackorders()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (response) => {
          const records = response.value ?? [];
          this._lines.set(records.length);
          this._units.set(records.reduce((sum, r) => sum + (r.RemainInventPhysical ?? 0), 0));
          this._customers.set(distinctCount(records, (r) => r.CustAccount));
          this._loading.set(false);
        },
        error: () => this._loading.set(false),
      });
  }
}
