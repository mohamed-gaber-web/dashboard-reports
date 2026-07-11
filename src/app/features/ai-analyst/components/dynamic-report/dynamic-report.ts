import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { KpiCardComponent } from '../../../../shared/ui/kpi-card/kpi-card';
import { ChartCardComponent } from '../../../../shared/ui/chart-card/chart-card';
import { BarChartComponent } from '../../../../shared/ui/bar-chart/bar-chart';
import { DonutChartComponent } from '../../../../shared/ui/donut-chart/donut-chart';
import { DataTableComponent } from '../../../../shared/ui/data-table/data-table';
import { paletteColor } from '../../../../shared/models/chart.model';
import { ReportResult } from '../../models/report-spec.model';

/** Renders a computed {@link ReportResult} using the shared UI kit. */
@Component({
  selector: 'app-dynamic-report',
  imports: [
    KpiCardComponent,
    ChartCardComponent,
    BarChartComponent,
    DonutChartComponent,
    DataTableComponent,
  ],
  templateUrl: './dynamic-report.html',
  styleUrl: './dynamic-report.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class DynamicReportComponent {
  readonly result = input.required<ReportResult>();

  protected readonly kpiCols = computed(() => {
    const n = this.result().kpis.length;
    return n >= 4 ? 'xl:grid-cols-4' : n === 3 ? 'xl:grid-cols-3' : n === 2 ? 'sm:grid-cols-2' : '';
  });

  protected accent(index: number): string {
    return paletteColor(index);
  }
}
