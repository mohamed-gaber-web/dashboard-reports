import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';
import { IconComponent } from '../icon/icon';

/** Friendly placeholder for empty or errored content, with an optional retry. */
@Component({
  selector: 'app-empty-state',
  imports: [IconComponent],
  templateUrl: './empty-state.html',
  styleUrl: './empty-state.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class EmptyStateComponent {
  readonly title = input.required<string>();
  readonly message = input<string>();
  readonly icon = input('M12 9v4m0 4h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z');
  /** When set, a retry button is shown that emits on click. */
  readonly retryLabel = input<string>();
  readonly retry = output<void>();
}
