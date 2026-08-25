import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  computed,
  inject,
  input,
  output,
  signal,
} from '@angular/core';
import { IconComponent } from '../icon/icon';
import { SourceOption } from '../../models/source-option.model';

/**
 * Picks which dataset a screen is pointed at.
 *
 * ## Why a menu and not a segmented control
 *
 * A segment shows every option at once, so its width is a function of the
 * option count — fine at two, a wrapping toolbar at eight. The module list is
 * expected to keep growing, so this is fixed-width whatever the list holds, and
 * grows a filter box only once scanning is slower than typing.
 *
 * ## Why it owns its own open state
 *
 * Everything a dropdown needs to be usable — outside-click, Escape, arrow-key
 * navigation, focus moving into the menu and back to the trigger — is behaviour,
 * not configuration. Leaving it to each host meant the AI Analyst's page
 * component carried ~90 lines of it, and the second screen to want a picker
 * would have carried the same lines again, drifting on the details that are
 * easiest to get wrong.
 */
@Component({
  selector: 'app-source-picker',
  imports: [IconComponent],
  templateUrl: './source-picker.html',
  styleUrl: './source-picker.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
  // Close on any click that lands outside this component.
  host: { '(document:click)': 'onDocumentClick($event)' },
})
export class SourcePickerComponent {
  readonly options = input.required<readonly SourceOption[]>();
  readonly selected = input.required<string>();
  /** Names what is being picked — the trigger's eyebrow and the menu's title. */
  readonly label = input('Source');
  readonly disabled = input(false);

  readonly selectedChange = output<string>();

  private readonly host = inject(ElementRef<HTMLElement>);

  protected readonly open = signal(false);
  protected readonly query = signal('');

  /**
   * The filter box only earns its space once scanning the list is slower than
   * typing. Below that it is a control asking to be used for no reason.
   */
  private static readonly SEARCH_FROM = 6;

  protected readonly showSearch = computed(
    () => this.options().length >= SourcePickerComponent.SEARCH_FROM,
  );

  /**
   * The selected option, or the first as a fallback.
   *
   * Typed as possibly-undefined on purpose: an index into an array is not proof
   * of an element, and a host that passes an empty list would otherwise render
   * `undefined.label` at runtime while type-checking clean.
   */
  protected readonly current = computed<SourceOption | undefined>(
    () => this.options().find((o) => o.id === this.selected()) ?? this.options()[0],
  );

  protected readonly visible = computed(() => {
    const q = this.query().trim().toLowerCase();
    if (!q) return this.options();
    return this.options().filter(
      (o) => o.label.toLowerCase().includes(q) || (o.description ?? '').toLowerCase().includes(q),
    );
  });

  protected readonly icons = {
    database: 'M12 3c4.4 0 8 1.3 8 3s-3.6 3-8 3-8-1.3-8-3 3.6-3 8-3zM4 6v12c0 1.7 3.6 3 8 3s8-1.3 8-3V6',
    chevronDown: 'm6 9 6 6 6-6',
    check: 'M20 6 9 17l-5-5',
    search: 'M11 19a8 8 0 1 1 0-16 8 8 0 0 1 0 16zM21 21l-4.3-4.3',
  };

  protected toggle(event: Event): void {
    event.stopPropagation();
    if (this.disabled()) return;
    const next = !this.open();
    this.query.set('');
    this.open.set(next);
    if (next) this.focusMenu();
  }

  /**
   * The trigger's own keys.
   *
   * A combobox opens on ArrowDown/ArrowUp. Without this the trigger announces
   * `aria-haspopup` and then does nothing a keyboard user expects.
   */
  protected onTriggerKeydown(event: KeyboardEvent): void {
    if (event.key === 'Escape' && this.open()) {
      event.preventDefault();
      this.open.set(false);
      return;
    }
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    event.preventDefault();
    if (this.disabled()) return;
    if (!this.open()) {
      this.query.set('');
      this.open.set(true);
    }
    this.focusMenu();
  }

  /**
   * Keyboard support inside the menu: arrows walk the options, Escape closes
   * and hands focus back to the trigger so the tab order is not lost mid-list.
   */
  protected onMenuKeydown(event: KeyboardEvent): void {
    if (event.key === 'Escape') {
      event.preventDefault();
      this.open.set(false);
      this.query$('.sp-trigger')?.focus();
      return;
    }
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;

    event.preventDefault();
    const items = Array.from(this.el().querySelectorAll<HTMLElement>('.sp-item'));
    if (!items.length) return;

    const current = items.indexOf(document.activeElement as HTMLElement);
    const step = event.key === 'ArrowDown' ? 1 : -1;
    // From the search box (index -1) ArrowUp should land on the last option.
    const next = current === -1 ? (step === 1 ? 0 : items.length - 1) : current + step;
    items[(next + items.length) % items.length].focus();
  }

  protected onSearch(event: Event): void {
    this.query.set((event.target as HTMLInputElement).value);
  }

  /**
   * Choose and close. Focus returns to the trigger because the element that had
   * it is being removed from the DOM, and focus falling to <body> drops a
   * keyboard user out of the toolbar entirely.
   */
  protected choose(id: string): void {
    this.open.set(false);
    if (id !== this.selected()) this.selectedChange.emit(id);
    setTimeout(() => this.query$('.sp-trigger')?.focus());
  }

  protected onDocumentClick(event: Event): void {
    if (!this.open()) return;
    if (!this.el().contains(event.target as Node)) this.open.set(false);
  }

  /**
   * Move focus INTO the menu once it exists.
   *
   * With a search box the box takes focus (you are most likely to type);
   * without one the selected option does, so Up/Down starts from where you are
   * rather than from the top. The menu is rendered by the change detection this
   * signal triggers, so neither element exists yet — focus on the next task.
   */
  private focusMenu(): void {
    setTimeout(() => {
      if (this.showSearch()) {
        this.query$<HTMLInputElement>('.sp-search-input')?.focus();
        return;
      }
      (this.query$<HTMLElement>('.sp-item-active') ?? this.query$<HTMLElement>('.sp-item'))?.focus();
    });
  }

  private el(): HTMLElement {
    return this.host.nativeElement as HTMLElement;
  }

  private query$<T extends HTMLElement>(selector: string): T | null {
    return this.el().querySelector<T>(selector);
  }
}
