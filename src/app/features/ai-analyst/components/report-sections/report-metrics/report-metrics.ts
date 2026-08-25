import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { KpiResult, ReportPalette, reportColor } from '../../../models/report-spec.model';

/**
 * A row of headline figures.
 *
 * Stats, not tiles. Four saturated gradient cards put the loudest thing on the
 * page at the top, where the least important thing usually is — the totals
 * restate what the charts below already show. A stat is a label, a number, and
 * one hairline of the colour that keys it to its chart.
 *
 * Presentation only: every figure arrives already computed and formatted by
 * `ReportEngineService`, so there is nothing here that could disagree with the
 * export.
 */
@Component({
  selector: 'app-report-metrics',
  templateUrl: './report-metrics.html',
  styleUrl: './report-metrics.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ReportMetricsComponent {
  readonly items = input.required<KpiResult[]>();
  readonly palette = input.required<ReportPalette>();

  /**
   * `@`-prefixed breakpoints measure the report sheet's own width, not the
   * viewport — that is what actually constrains these, since the sheet sits in a
   * scrolling pane beside a sidebar.
   *
   * Small counts pack early because a stat is a figure, not a card: a lone one
   * spanning the full width would be a band of whitespace with a number in the
   * corner.
   */
  protected readonly columns = computed(() => {
    const n = this.items().length;
    if (n <= 1) return 'grid-cols-1';
    if (n === 2) return 'grid-cols-2';
    if (n === 3) return 'grid-cols-2 @xl:grid-cols-3';
    if (n === 4) return 'grid-cols-2 @xl:grid-cols-4';
    return 'grid-cols-2 @xl:grid-cols-3 @4xl:grid-cols-5';
  });

  protected accent(index: number): string {
    return reportColor(this.palette(), index);
  }
}
