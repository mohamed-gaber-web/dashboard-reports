import { ChangeDetectionStrategy, Component, computed, input, output } from '@angular/core';
import { AiProviderId, AiProviderOption } from '../../../core/ai/ai-provider.service';

/**
 * The model picker — which AI answers the next question.
 *
 * Presentational (NG-ARCH-05): it holds no state, reads no service and knows
 * nothing about either AI feature. It renders the list it is given and emits the
 * id that was clicked; the page's Model owns the selection and passes it to
 * {@link AiProviderService}.
 *
 * It imports the provider TYPES from `core/ai` rather than redeclaring them.
 * Core is cross-cutting by definition, and a structural copy here would be a
 * second definition to keep in step with the backend's registry — the exact
 * drift the shared `AiProviderOption` exists to prevent.
 *
 * A segmented control rather than a dropdown: there are two providers and the
 * point of the control is that you can see which one is live without opening
 * anything. If the list ever grows past four this should become a menu, the way
 * the AI Analyst's source picker did for the same reason.
 */
@Component({
  selector: 'app-provider-switch',
  templateUrl: './provider-switch.html',
  styleUrl: './provider-switch.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ProviderSwitchComponent {
  readonly providers = input.required<readonly AiProviderOption[]>();
  readonly selected = input.required<AiProviderId>();

  /** Set while a reply is in flight — switching mid-turn would strand it. */
  readonly busy = input(false);

  readonly selectedChange = output<AiProviderId>();

  /**
   * Render as soon as there is more than one provider to NAME — not more than
   * one that is currently usable.
   *
   * Hiding the control until two keys are configured was the first cut, and it
   * was wrong: the state it hid is exactly the one someone needs explained.
   * With a single key set, the switch vanishing looks like the feature is
   * missing, whereas a visible pair with the unconfigured half greyed out and
   * a tooltip naming its variable answers the question on the spot — and lights
   * up on its own the moment that key is added.
   */
  protected readonly hasChoice = computed(() => this.providers().length > 1);

  protected choose(option: AiProviderOption): void {
    if (this.busy() || !option.available || option.id === this.selected()) return;
    this.selectedChange.emit(option.id);
  }

  /**
   * The tooltip. An option that cannot be chosen has to say why next to itself
   * — a greyed-out button with no explanation reads as a bug.
   */
  protected hint(option: AiProviderOption): string {
    if (!option.available) {
      return `${option.label} is not configured — set ${option.keyEnv} on the API and restart it.`;
    }
    return option.model ? `${option.detail} · ${option.model}` : option.detail;
  }
}
