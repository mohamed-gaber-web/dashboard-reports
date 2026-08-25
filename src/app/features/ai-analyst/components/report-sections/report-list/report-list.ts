import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { IconComponent } from '../../../../../shared/ui/icon/icon';

/** Which kind of list this is. The two read differently, so they look different. */
export type ReportListVariant = 'insights' | 'recommendations';

/**
 * Insights or recommendations, inside the report.
 *
 * They are separated because they are different claims. An INSIGHT is a reading
 * of the data on the page — "one item is a third of the remaining units" — and
 * is marked with a bullet, subordinate to the figures above it. A
 * RECOMMENDATION is an action the model is proposing, which is not a fact about
 * the data at all, so it is ticked, indented and captioned as a suggestion.
 * Rendering them identically would let a suggestion borrow the authority of a
 * measurement.
 *
 * Items are interpolated, never `[innerHTML]` — untrusted model text.
 */
@Component({
  selector: 'app-report-list',
  imports: [IconComponent],
  templateUrl: './report-list.html',
  styleUrl: './report-list.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ReportListComponent {
  readonly variant = input.required<ReportListVariant>();
  readonly items = input.required<string[]>();

  protected readonly isAction = computed(() => this.variant() === 'recommendations');

  protected readonly tick = 'M20 6 9 17l-5-5';
}
