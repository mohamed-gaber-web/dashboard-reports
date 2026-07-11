import { Injectable, computed, inject, signal, DestroyRef } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { SalesOrderService } from '../../services/sales-order.service';
import {
  SalesBackorderRecord,
  documentStatusTone,
} from '../../models/sales-order.model';
import { TableColumn } from '../../../../shared/models/table-column.model';
import {
  formatInteger,
  formatQuantity,
  formatDate,
  formatCurrency,
} from '../../../../shared/utils/format.util';

const PAGE_SIZE = 12;

/** A selectable value for a filter dropdown. */
export interface FilterOption {
  value: string;
  label: string;
}

/**
 * ViewModel for the Sales Order List — a detailed, searchable, paginated grid
 * of every open backorder line. Owns loading state and derived table state.
 */
@Injectable()
export class SalesOrderListModel {
  private readonly service = inject(SalesOrderService);
  private readonly destroyRef = inject(DestroyRef);

  private readonly _records = signal<SalesBackorderRecord[]>([]);
  private readonly _loading = signal(true);
  private readonly _error = signal<string | null>(null);
  private readonly _search = signal('');
  private readonly _page = signal(0);

  // Filter selections ('' = no filter).
  private readonly _status = signal('');
  private readonly _currency = signal('');
  private readonly _customer = signal('');

  readonly loading = this._loading.asReadonly();
  readonly error = this._error.asReadonly();
  readonly search = this._search.asReadonly();
  readonly status = this._status.asReadonly();
  readonly currency = this._currency.asReadonly();
  readonly customer = this._customer.asReadonly();
  readonly hasData = computed(() => this._records().length > 0);
  readonly totalLines = computed(() => formatInteger(this._records().length));

  // Distinct filter option lists, derived from the loaded data.
  readonly statusOptions = computed(() => this.optionsOf((r) => r.SalesTable_DocumentStatus));
  readonly currencyOptions = computed(() => this.optionsOf((r) => r.CurrencyCode));
  readonly customerOptions = computed<FilterOption[]>(() => {
    const map = new Map<string, string>();
    for (const r of this._records()) {
      if (r.CustAccount && !map.has(r.CustAccount)) {
        map.set(
          r.CustAccount,
          r.SalesTable_SalesName ? `${r.SalesTable_SalesName} (${r.CustAccount})` : r.CustAccount,
        );
      }
    }
    return [...map.entries()]
      .map(([value, label]) => ({ value, label }))
      .sort((a, b) => a.label.localeCompare(b.label));
  });

  readonly activeFilterCount = computed(
    () => [this._status(), this._currency(), this._customer()].filter(Boolean).length,
  );
  readonly hasActiveFilters = computed(
    () => this.activeFilterCount() > 0 || this._search().trim().length > 0,
  );

  readonly columns: TableColumn<SalesBackorderRecord>[] = [
    { key: 'SalesId', header: 'Order', align: 'left' },
    { key: 'ItemId', header: 'Item', align: 'left' },
    { key: 'Name', header: 'Description', align: 'left' },
    {
      key: 'SalesTable_SalesName',
      header: 'Customer',
      align: 'left',
      format: (value, row) => (value as string) || row.CustAccount,
    },
    {
      key: 'SalesTable_DeliveryDate',
      header: 'Delivery date',
      align: 'left',
      format: (value) => formatDate(value as string | undefined),
    },
    {
      key: 'QtyOrdered',
      header: 'Qty ordered',
      align: 'right',
      format: (value) => formatQuantity(Number(value)),
    },
    {
      key: 'RemainInventPhysical',
      header: 'Remaining',
      align: 'right',
      format: (value) => formatQuantity(Number(value)),
    },
    {
      key: 'SalesTable_DocumentStatus',
      header: 'Status',
      align: 'left',
      kind: 'badge',
      format: (value) => (value as string) || 'None',
      tone: (value) => documentStatusTone(value as string | undefined),
    },
    {
      key: 'LineAmount',
      header: 'Amount',
      align: 'right',
      format: (value, row) => formatCurrency(Number(value), row.CurrencyCode),
    },
  ];

  private readonly filtered = computed(() => {
    const term = this._search().trim().toLowerCase();
    const status = this._status();
    const currency = this._currency();
    const customer = this._customer();

    return this._records().filter((r) => {
      if (status && r.SalesTable_DocumentStatus !== status) return false;
      if (currency && r.CurrencyCode !== currency) return false;
      if (customer && r.CustAccount !== customer) return false;
      if (term) {
        const match =
          r.SalesId?.toLowerCase().includes(term) ||
          r.ItemId?.toLowerCase().includes(term) ||
          r.Name?.toLowerCase().includes(term) ||
          r.CustAccount?.toLowerCase().includes(term) ||
          r.SalesTable_SalesName?.toLowerCase().includes(term);
        if (!match) return false;
      }
      return true;
    });
  });

  /** Distinct, sorted non-empty values for a field, as filter options. */
  private optionsOf(select: (r: SalesBackorderRecord) => string | undefined): FilterOption[] {
    const set = new Set<string>();
    for (const r of this._records()) {
      const value = select(r);
      if (value) set.add(value);
    }
    return [...set].sort().map((value) => ({ value, label: value }));
  }

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

  setStatus(value: string): void {
    this._status.set(value);
    this._page.set(0);
  }

  setCurrency(value: string): void {
    this._currency.set(value);
    this._page.set(0);
  }

  setCustomer(value: string): void {
    this._customer.set(value);
    this._page.set(0);
  }

  clearFilters(): void {
    this._search.set('');
    this._status.set('');
    this._currency.set('');
    this._customer.set('');
    this._page.set(0);
  }

  nextPage(): void {
    if (this.canNext()) this._page.update((p) => p + 1);
  }

  prevPage(): void {
    if (this.canPrev()) this._page.update((p) => p - 1);
  }
}
