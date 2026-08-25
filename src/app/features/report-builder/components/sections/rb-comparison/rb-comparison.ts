import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { IconComponent } from '../../../../../shared/ui/icon/icon';
import { formatSignedPercent } from '../../../../../shared/utils/format.util';
import { DeltaResult } from '../../../models/report-definition.model';

/**
 * Two periods of the same measures, side by side.
 *
 * The deliberate restraint here is the colour. A dashboard that paints every
 * rise green is asserting that up is good, which for backorder units or overdue
 * lines is exactly backwards. Colour is spent only when the definition said
 * which way is up (`goodDirection`); otherwise the change is stated in neutral
 * ink with a direction arrow, which is the honest reading of "it went up".
 */
@Component({
  selector: 'app-rb-comparison',
  imports: [IconComponent],
  templateUrl: './rb-comparison.html',
  styleUrl: './rb-comparison.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class RbComparisonComponent {
  readonly items = input.required<DeltaResult[]>();
  readonly currentLabel = input.required<string>();
  readonly previousLabel = input.required<string>();

  protected readonly icons = {
    up: 'M12 19V5M5 12l7-7 7 7',
    down: 'M12 5v14M19 12l-7 7-7-7',
    flat: 'M5 12h14',
  };

  protected arrow(item: DeltaResult): string {
    return this.icons[item.direction];
  }

  /**
   * The change as a percentage, or an em dash.
   *
   * A baseline of zero makes the ratio undefined — not infinite, and certainly
   * not 100%. Saying so is the only honest option, and the block's note already
   * explains that the earlier period was empty.
   */
  protected percent(item: DeltaResult): string {
    return item.deltaPercent === null ? '—' : formatSignedPercent(item.deltaPercent);
  }
}
