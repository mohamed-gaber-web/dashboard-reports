import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { InsightPoint } from '../../../models/report-definition.model';

/**
 * What the report shows — with each claim labelled for what it IS.
 *
 * This is the difference that matters most on this screen. "Three customers hold
 * over half the remaining units" is an OBSERVATION: it is readable straight off
 * the figures above, and if it is wrong the figures are wrong. "The
 * concentration suggests a fulfilment bottleneck" is an INTERPRETATION: it is
 * the model's reading, and it can be wrong while every figure on the page is
 * right.
 *
 * Rendering them identically would let the second borrow the authority of the
 * first, which is exactly how a grounded report starts misleading people. So
 * each point wears its kind, and the two are visibly different weights.
 *
 * Text is interpolated, never `[innerHTML]` — untrusted model output.
 */
@Component({
  selector: 'app-rb-insights',
  templateUrl: './rb-insights.html',
  styleUrl: './rb-insights.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class RbInsightsComponent {
  readonly points = input.required<InsightPoint[]>();

  protected label(point: InsightPoint): string {
    return point.kind === 'interpretation' ? 'Interpretation' : 'Observed';
  }
}
