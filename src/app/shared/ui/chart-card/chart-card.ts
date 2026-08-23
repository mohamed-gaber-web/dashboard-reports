import { ChangeDetectionStrategy, Component, input } from '@angular/core';

/** Titled card that frames a chart or any projected content. */
@Component({
  selector: 'app-chart-card',
  templateUrl: './chart-card.html',
  styleUrl: './chart-card.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ChartCardComponent {
  readonly title = input.required<string>();
  readonly subtitle = input<string>();

  /**
   * `card` — its own surface, border and shadow. Right on a page where the
   * cards sit directly on the canvas.
   *
   * `plain` — no surface of its own, so it can be a section INSIDE a padded
   * sheet. A card nested in a card draws a second border a pixel inside the
   * first and pays for the same padding twice, which is exactly how the
   * generated report ended up looking cramped.
   */
  readonly variant = input<'card' | 'plain'>('card');
}
