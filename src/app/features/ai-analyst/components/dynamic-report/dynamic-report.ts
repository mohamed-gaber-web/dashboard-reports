import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { ChartCardComponent } from '../../../../shared/ui/chart-card/chart-card';
import { BarChartComponent } from '../../../../shared/ui/bar-chart/bar-chart';
import { DonutChartComponent } from '../../../../shared/ui/donut-chart/donut-chart';
import { DataTableComponent } from '../../../../shared/ui/data-table/data-table';
import { ChartResult, ReportResult, reportColor } from '../../models/report-spec.model';

/** Renders a computed {@link ReportResult} as one padded report sheet. */
@Component({
  selector: 'app-dynamic-report',
  imports: [ChartCardComponent, BarChartComponent, DonutChartComponent, DataTableComponent],
  templateUrl: './dynamic-report.html',
  styleUrl: './dynamic-report.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class DynamicReportComponent {
  readonly result = input.required<ReportResult>();

  /**
   * The look the model asked for. It is part of the spec, so "make it compact"
   * or "use one colour" in chat lands here on the next `emit_report` — the
   * report above the conversation restyles without a settings screen.
   */
  protected readonly design = computed(() => this.result().design);

  protected readonly compact = computed(() => this.design().density === 'compact');

  /**
   * `@`-prefixed breakpoints measure the sheet's own width, not the viewport.
   *
   * Stats are a row of small figures now rather than tiles, so they can pack
   * four-across much earlier than the tiles could — and a lone stat no longer
   * needs a max-width cap, because at this size it reads as a figure rather
   * than as a stretched card with a two-character number in the corner.
   */
  protected readonly statCols = computed(() => {
    const n = this.result().kpis.length;
    if (n <= 1) return 'grid-cols-1';
    if (n === 2) return 'grid-cols-2';
    if (n === 3) return 'grid-cols-2 @xl:grid-cols-3';
    return 'grid-cols-2 @xl:grid-cols-4';
  });

  /**
   * One chart gets the full width; pairs split once there is room, and three or
   * more go three-across on a wide sheet.
   */
  protected readonly chartCols = computed(() => {
    const n = this.result().charts.length;
    const layout = this.design().chartLayout;
    // "Bigger charts" is the usual reason to ask: one per row, full sheet width.
    if (layout === 'stacked') return 'grid-cols-1';
    // "Fit more in": pack two-across as soon as there is any room at all.
    if (layout === 'grid') return n <= 1 ? 'grid-cols-1' : 'grid-cols-1 @xl:grid-cols-2 @5xl:grid-cols-3';
    if (n <= 1) return 'grid-cols-1';
    if (n === 2) return 'grid-cols-1 @3xl:grid-cols-2';
    return 'grid-cols-1 @3xl:grid-cols-2 @6xl:grid-cols-3';
  });

  /** Names the slice a chart covers, so the card's title can stay a title. */
  protected chartSubtitle(chart: ChartResult): string {
    const shown = chart.data.length;
    if (!shown) return '';
    const folded = chart.data.some((d) => d.label === 'Other');
    const noun = chart.type === 'donut' ? 'slices' : 'bars';
    return folded ? `Top ${shown - 1} ${noun} · the rest totalled as “Other”` : '';
  }

  /** The stat's hairline keys it to the chart it came from, palette and all. */
  protected accent(index: number): string {
    return reportColor(this.design().palette, index);
  }

  /** The detail table is capped tighter in a compact report. */
  protected readonly tableMaxHeight = computed(() =>
    this.compact() ? 'min(20rem, 34vh)' : 'min(26rem, 42vh)',
  );
}
