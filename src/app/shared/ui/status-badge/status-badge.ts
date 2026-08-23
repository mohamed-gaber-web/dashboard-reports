import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { BadgeTone } from '../../models/badge.model';

/*
 * Maps to the shared `.pill-*` primitives rather than raw Tailwind palette
 * classes. The old map hardcoded emerald/amber/red, so badges ignored the
 * semantic status tokens and went muddy in dark mode alongside pills that did
 * use them.
 */
const TONE_CLASSES: Record<BadgeTone, string> = {
  neutral: 'pill-neutral',
  info: 'pill-info',
  success: 'pill-ok',
  warning: 'pill-warn',
  danger: 'pill-danger',
};

/** A small coloured status pill. */
@Component({
  selector: 'app-status-badge',
  templateUrl: './status-badge.html',
  styleUrl: './status-badge.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class StatusBadgeComponent {
  readonly label = input.required<string>();
  readonly tone = input<BadgeTone>('neutral');

  protected readonly toneClass = computed(() => TONE_CLASSES[this.tone()]);
}
