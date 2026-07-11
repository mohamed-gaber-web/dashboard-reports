import { ChangeDetectionStrategy, Component, input } from '@angular/core';

/** Renders an inline SVG icon from 24×24 path data. */
@Component({
  selector: 'app-icon',
  templateUrl: './icon.html',
  styleUrl: './icon.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class IconComponent {
  readonly path = input.required<string>();
  readonly size = input(20);
}
