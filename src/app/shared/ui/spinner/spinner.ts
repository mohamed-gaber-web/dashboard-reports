import { ChangeDetectionStrategy, Component, input } from '@angular/core';

/** Centered loading indicator with an optional caption. */
@Component({
  selector: 'app-spinner',
  templateUrl: './spinner.html',
  styleUrl: './spinner.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class SpinnerComponent {
  readonly label = input('Loading…');
}
