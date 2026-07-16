import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { KpiCardComponent } from '../../../../shared/ui/kpi-card/kpi-card';
import { ChartCardComponent } from '../../../../shared/ui/chart-card/chart-card';
import { BarChartComponent } from '../../../../shared/ui/bar-chart/bar-chart';
import { DonutChartComponent } from '../../../../shared/ui/donut-chart/donut-chart';
import { DataTableComponent } from '../../../../shared/ui/data-table/data-table';
import { paletteColor } from '../../../../shared/models/chart.model';
import { ChartResult, ReportResult } from '../../models/report-spec.model';

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

  /**
   * `@`-prefixed breakpoints measure this report's own column, not the viewport
   * — see the note in the template. A lone KPI is the report's headline, so it
   * spans the row instead of sitting in a half-empty two-column grid.
   */
  protected readonly kpiCols = computed(() => {
    const n = this.result().kpis.length;
    if (n <= 1) return 'grid-cols-1';
    if (n === 2) return 'grid-cols-1 @md:grid-cols-2';
    if (n === 3) return 'grid-cols-1 @md:grid-cols-2 @3xl:grid-cols-3';
    return 'grid-cols-1 @md:grid-cols-2 @4xl:grid-cols-4';
  });

  /** One chart gets the full column; pairs only split once there is room to. */
  protected readonly chartCols = computed(() =>
    this.result().charts.length > 1 ? 'grid-cols-1 @3xl:grid-cols-2' : 'grid-cols-1',
  );

  /** Names the slice a chart covers, so the card's title can stay a title. */
  protected chartSubtitle(chart: ChartResult): string {
    const shown = chart.data.length;
    if (!shown) return '';
    const folded = chart.data.some((d) => d.label === 'Other');
    const noun = chart.type === 'donut' ? 'slices' : 'bars';
    return folded ? `Top ${shown - 1} ${noun} · the rest totalled as “Other”` : '';
  }

  protected accent(index: number): string {
    return paletteColor(index);
  }
}
