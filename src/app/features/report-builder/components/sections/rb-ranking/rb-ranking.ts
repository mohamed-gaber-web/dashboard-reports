import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { RankedRow } from '../../../models/report-definition.model';

/**
 * A ranked list — the answer to "what are my top products?".
 *
 * A bar chart alone only implies a ranking: the reader infers the order from the
 * lengths and cannot see the positions at all once two bars are close. This
 * states all three facts a ranking question asks for — the POSITION, the FIGURE
 * and the SHARE of the whole.
 *
 * The share is of the complete set, not of the rows shown. Computed in the
 * composer, because "34% of total" is only true if the denominator is the total.
 */
@Component({
  selector: 'app-rb-ranking',
  templateUrl: './rb-ranking.html',
  styleUrl: './rb-ranking.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class RbRankingComponent {
  readonly rows = input.required<RankedRow[]>();
  readonly measureLabel = input.required<string>();
  /** Draw the proportional bar behind each row. */
  readonly showBars = input(true);

  /**
   * The top three are worth distinguishing; below that a rank is just a number.
   * One hue for every bar — the LENGTH already carries the value, so spending a
   * colour per row would double-encode it and leave no channel free.
   */
  protected leading(row: RankedRow): boolean {
    return row.rank <= 3;
  }
}
