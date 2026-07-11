import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { IconComponent } from '../icon/icon';

/** A vivid, gradient-filled headline metric tile. Purely presentational. */
@Component({
  selector: 'app-kpi-card',
  imports: [IconComponent],
  templateUrl: './kpi-card.html',
  styleUrl: './kpi-card.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class KpiCardComponent {
  readonly label = input.required<string>();
  readonly value = input.required<string>();
  readonly hint = input<string>();
  readonly icon = input<string>();
  /** Base colour for the card's gradient fill (CSS colour value). */
  readonly accent = input('var(--color-brand-600)');

  protected readonly gradient = computed(() => {
    const c = this.accent();
    return `linear-gradient(135deg, ${c} 0%, color-mix(in srgb, ${c} 60%, #000) 100%)`;
  });
}
