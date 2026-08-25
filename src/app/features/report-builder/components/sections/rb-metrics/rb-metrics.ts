import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { paletteColor } from '../../../../../shared/models/chart.model';
import { ComputedMetric } from '../../../models/report-definition.model';

/**
 * A row of headline figures.
 *
 * Stats, not tiles. Saturated gradient cards put the loudest thing on the page
 * at the top, where the least important thing usually is — the totals restate
 * what the sections below already show. A stat is a label, a number, one
 * hairline of the colour that keys it to its chart, and nothing else.
 *
 * Presentation only: every figure arrives already computed and formatted by
 * `ReportComposerService`, so there is nothing here that could disagree with the
 * exported document.
 */
@Component({
  selector: 'app-rb-metrics',
  templateUrl: './rb-metrics.html',
  styleUrl: './rb-metrics.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class RbMetricsComponent {
  readonly items = input.required<ComputedMetric[]>();

  /**
   * `@`-prefixed breakpoints measure the report SHEET's own width, not the
   * viewport — the sheet sits in a scrolling pane beside a sidebar, so the
   * viewport says nothing useful about how much room these actually have.
   *
   * Small counts pack early because a stat is a figure, not a card: one stat
   * spanning the full width is a band of whitespace with a number in the corner.
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
    return paletteColor(index);
  }
}
