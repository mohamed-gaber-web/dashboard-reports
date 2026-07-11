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
}
