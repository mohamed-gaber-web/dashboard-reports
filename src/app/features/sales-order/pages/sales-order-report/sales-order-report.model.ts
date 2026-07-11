import { Injectable, computed, inject, signal, DestroyRef } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { SalesOrderService } from '../../services/sales-order.service';
import {
  SalesBackorderRecord,
  documentStatusTone,
} from '../../models/sales-order.model';
import { aggregate, distinctCount } from '../../../../shared/utils/group-by.util';
import { ChartDatum } from '../../../../shared/models/chart.model';
import { TableColumn } from '../../../../shared/models/table-column.model';
import { formatInteger, formatQuantity, formatDate } from '../../../../shared/utils/format.util';

const PAGE_SIZE = 8;

/**
 * ViewModel for the Sales Order report. Owns loading state, the raw dataset,
 * and every derived value (KPIs, charts, filtered/paged table rows). The view
 * only binds to these signals — it holds no logic of its own.
 */
@Injectable()
export class SalesOrderReportModel {
  private readonly service = inject(SalesOrderService);
  private readonly destroyRef = inject(DestroyRef);

  // ── Raw state ──────────────────────────────────────────────
  private readonly _records = signal<SalesBackorderRecord[]>([]);
  private readonly _loading = signal(true);
  private readonly _error = signal<string | null>(null);
  private readonly _search = signal('');
  private readonly _page = signal(0);

  readonly loading = this._loading.asReadonly();
  readonly error = this._error.asReadonly();
  readonly search = this._search.asReadonly();
  readonly hasData = computed(() => this._records().length > 0);

  // ── KPIs ───────────────────────────────────────────────────
  readonly totalLines = computed(() => formatInteger(this._records().length));
  readonly unitsRemaining = computed(() =>
    formatQuantity(this._records().reduce((sum, r) => sum + (r.RemainInventPhysical ?? 0), 0)),
  );
  readonly customerCount = computed(() =>
    formatInteger(distinctCount(this._records(), (r) => r.CustAccount)),
  );
  readonly orderCount = computed(() =>
    formatInteger(distinctCount(this._records(), (r) => r.SalesId)),
  );

  // ── Chart data ─────────────────────────────────────────────
  readonly unitsByCustomer = computed<ChartDatum[]>(() =>
    aggregate(
      this._records(),
      (r) => r.SalesTable_SalesName || r.CustAccount,
      (r) => r.RemainInventPhysical ?? 0,
      7,
    ),
  );
  readonly linesByCurrency = computed<ChartDatum[]>(() =>
    aggregate(this._records(), (r) => r.CurrencyCode, () => 1, 6),
  );
  readonly linesByStatus = computed<ChartDatum[]>(() =>
    aggregate(this._records(), (r) => r.SalesTable_DocumentStatus || 'None', () => 1, 6),
  );

  readonly quantityFormat = formatQuantity;

  // ── Table ──────────────────────────────────────────────────
  readonly columns: TableColumn<SalesBackorderRecord>[] = [
    { key: 'SalesId', header: 'Order', align: 'left' },
    {
      key: 'SalesTable_SalesName',
      header: 'Customer',
      align: 'left',
      format: (value, row) => (value as string) || row.CustAccount,
    },
    { key: 'CustAccount', header: 'Account', align: 'left' },
    {
      key: 'SalesTable_DeliveryDate',
      header: 'Delivery date',
      align: 'left',
      format: (value) => formatDate(value as string | undefined),
    },
    {
      key: 'SalesTable_DocumentStatus',
      header: 'Status',
      align: 'left',
      kind: 'badge',
      format: (value) => (value as string) || 'None',
      tone: (value) => documentStatusTone(value as string | undefined),
    },
    { key: 'CurrencyCode', header: 'Currency', align: 'center' },
    {
      key: 'RemainInventPhysical',
      header: 'Units remaining',
      align: 'right',
      format: (value) => formatQuantity(Number(value)),
    },
  ];

  private readonly filtered = computed(() => {
    const term = this._search().trim().toLowerCase();
    if (!term) return this._records();
    return this._records().filter(
      (r) =>
        r.SalesId?.toLowerCase().includes(term) ||
        r.CustAccount?.toLowerCase().includes(term) ||
        r.SalesTable_SalesName?.toLowerCase().includes(term),
    );
  });

  readonly pageCount = computed(() => Math.max(1, Math.ceil(this.filtered().length / PAGE_SIZE)));
  readonly page = computed(() => Math.min(this._page(), this.pageCount() - 1));

  readonly pagedRows = computed(() => {
    const start = this.page() * PAGE_SIZE;
    return this.filtered().slice(start, start + PAGE_SIZE);
  });

  readonly rangeLabel = computed(() => {
    const total = this.filtered().length;
    if (total === 0) return 'No matching lines';
    const start = this.page() * PAGE_SIZE + 1;
    const end = Math.min(start + PAGE_SIZE - 1, total);
    return `${start}–${end} of ${formatInteger(total)}`;
  });

  readonly canPrev = computed(() => this.page() > 0);
  readonly canNext = computed(() => this.page() < this.pageCount() - 1);

  constructor() {
    this.load();
  }

  /** (Re)load the dataset from D365. */
  load(): void {
    this._loading.set(true);
    this._error.set(null);
    this.service
      .getBackorders()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (response) => {
          this._records.set(response.value ?? []);
          this._page.set(0);
          this._loading.set(false);
        },
        error: () => {
          this._error.set('We couldn’t load sales orders from D365. Please try again.');
          this._loading.set(false);
        },
      });
  }

  setSearch(term: string): void {
    this._search.set(term);
    this._page.set(0);
  }

  nextPage(): void {
    if (this.canNext()) this._page.update((p) => p + 1);
  }

  prevPage(): void {
    if (this.canPrev()) this._page.update((p) => p - 1);
  }
}
