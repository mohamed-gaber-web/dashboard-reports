import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { PageHeaderComponent } from '../../../../shared/ui/page-header/page-header';
import { DataTableComponent } from '../../../../shared/ui/data-table/data-table';
import { SpinnerComponent } from '../../../../shared/ui/spinner/spinner';
import { EmptyStateComponent } from '../../../../shared/ui/empty-state/empty-state';
import { IconComponent } from '../../../../shared/ui/icon/icon';
import { SalesOrderListModel } from './sales-order-list.model';

/** Sales Order List screen — detailed grid, binds to its Model only. */
@Component({
  selector: 'app-sales-order-list',
  imports: [
    PageHeaderComponent,
    DataTableComponent,
    SpinnerComponent,
    EmptyStateComponent,
    IconComponent,
  ],
  templateUrl: './sales-order-list.html',
  styleUrl: './sales-order-list.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
  providers: [SalesOrderListModel],
})
export class SalesOrderListComponent {
  protected readonly model = inject(SalesOrderListModel);

  protected readonly icons = {
    refresh: 'M21 12a9 9 0 1 1-2.64-6.36M21 3v6h-6',
    search: 'm21 21-4.3-4.3M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16z',
    prev: 'm15 18-6-6 6-6',
    next: 'm9 18 6-6-6-6',
    chevron: 'm6 9 6 6 6-6',
    filter: 'M22 3H2l8 9.46V19l4 2v-8.54L22 3z',
    clear: 'M18 6 6 18M6 6l12 12',
    empty:
      'M9 5H7a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-2M9 5a2 2 0 0 0 2 2h2a2 2 0 0 0 2-2M9 5a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2',
  };
}
