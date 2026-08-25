import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { IconComponent } from '../../../../../shared/ui/icon/icon';
import { RecommendationPoint } from '../../../models/report-definition.model';

/**
 * Suggested actions.
 *
 * A recommendation is not a measurement and not even an insight — it is a
 * proposal, and the data can support it without proving it. It is therefore
 * rendered as its own thing: ticked, indented, priced by priority, carrying the
 * figure it rests on, and captioned once so it cannot quietly borrow the
 * authority of the numbers above it.
 *
 * `rationale` is what makes the caveat more than a disclaimer: it names the
 * figure the suggestion came from, so a reader can check the reasoning instead
 * of taking it on trust.
 *
 * Text is interpolated, never `[innerHTML]` — untrusted model output.
 */
@Component({
  selector: 'app-rb-recommendations',
  imports: [IconComponent],
  templateUrl: './rb-recommendations.html',
  styleUrl: './rb-recommendations.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class RbRecommendationsComponent {
  readonly points = input.required<RecommendationPoint[]>();

  protected readonly tick = 'M20 6 9 17l-5-5';
}
