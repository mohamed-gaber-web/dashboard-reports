import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { RankingRow, ReportPalette, reportColor } from '../../../models/report-spec.model';

/**
 * A ranked list — the answer to "what are my top products?".
 *
 * A bar chart alone only implies a ranking; the reader has to infer the order
 * from the lengths and cannot see the positions at all once two bars are close.
 * This states all three facts a ranking question actually asks for: the
 * POSITION, the FIGURE, and the SHARE of the whole.
 *
 * Share is of the complete set, not of the ten rows shown — computed in the
 * engine, because "34% of total" is only true if the denominator is the total.
 */
@Component({
  selector: 'app-report-ranking',
  templateUrl: './report-ranking.html',
  styleUrl: './report-ranking.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ReportRankingComponent {
  readonly rows = input.required<RankingRow[]>();
  readonly measureLabel = input.required<string>();
  readonly palette = input.required<ReportPalette>();
  /** Draw the proportional bar behind each row. */
  readonly chart = input(true);

  /**
   * One hue for every bar.
   *
   * The bar's LENGTH already carries the value; spending a colour per row would
   * double-encode it and leave no channel free to mean anything else. Same
   * reasoning as `app-bar-chart`.
   */
  protected readonly barColor = computed(() =>
    this.palette() === 'categorical' ? 'var(--color-chart-1)' : reportColor(this.palette(), 0),
  );

  /** The top three are worth distinguishing; below that a rank is just a number. */
  protected leading(row: RankingRow): boolean {
    return row.rank <= 3;
  }
}
