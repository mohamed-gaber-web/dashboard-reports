import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { PageHeaderComponent } from '../../../../shared/ui/page-header/page-header';
import { KpiCardComponent } from '../../../../shared/ui/kpi-card/kpi-card';
import { ChartCardComponent } from '../../../../shared/ui/chart-card/chart-card';
import { BarChartComponent } from '../../../../shared/ui/bar-chart/bar-chart';
import { DonutChartComponent } from '../../../../shared/ui/donut-chart/donut-chart';
import { DataTableComponent } from '../../../../shared/ui/data-table/data-table';
import { SpinnerComponent } from '../../../../shared/ui/spinner/spinner';
import { EmptyStateComponent } from '../../../../shared/ui/empty-state/empty-state';
import { IconComponent } from '../../../../shared/ui/icon/icon';
import { SalesOrderReportModel } from './sales-order-report.model';

/** Sales Order report screen — binds to {@link SalesOrderReportModel} only. */
@Component({
  selector: 'app-sales-order-report',
  imports: [
    PageHeaderComponent,
    KpiCardComponent,
    ChartCardComponent,
    BarChartComponent,
    DonutChartComponent,
    DataTableComponent,
    SpinnerComponent,
    EmptyStateComponent,
    IconComponent,
  ],
  templateUrl: './sales-order-report.html',
  styleUrl: './sales-order-report.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
  providers: [SalesOrderReportModel],
})
export class SalesOrderReportComponent {
  protected readonly model = inject(SalesOrderReportModel);

  protected readonly icons = {
    lines: 'M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01',
    units: 'M20 7 12 3 4 7m16 0-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4',
    customers: 'M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zm14 10v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75',
    orders: 'M9 5H7a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-2M9 5a2 2 0 0 0 2 2h2a2 2 0 0 0 2-2M9 5a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2m-6 7h6m-6 4h4',
    refresh: 'M21 12a9 9 0 1 1-2.64-6.36M21 3v6h-6',
    search: 'm21 21-4.3-4.3M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16z',
    prev: 'm15 18-6-6 6-6',
    next: 'm9 18 6-6-6-6',
  };
}
