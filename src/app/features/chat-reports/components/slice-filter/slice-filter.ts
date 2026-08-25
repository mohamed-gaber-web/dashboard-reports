import { ChangeDetectionStrategy, Component, computed, input, output } from '@angular/core';
import { IconComponent } from '../../../../shared/ui/icon/icon';
import { ChatReportFilter, ChatReportFilterSpec } from '../../sources/chat-report-sources';

/**
 * The slice form: which rows the next answer is allowed to be about.
 *
 * ## Why this is a form and not a live filter
 *
 * The AI Analyst filters as you type, because there a change costs one `$count`
 * — free, and it changes nothing already on screen. Here a change re-reads the
 * module and may re-fold up to {@link MAX_ANALYZE_ROWS} rows, which is tens of
 * seconds, and it moves the ground under a conversation in progress. Applying on
 * a keystroke would start (and abandon) one of those per character typed. So:
 * fill it in, press Apply, and until then the figures on screen still match the
 * badge describing them.
 *
 * ## Why the controls are conditional
 *
 * Both come from the module's own descriptor. A date range over a module with no
 * date column would build a filter that matches everything and leave the user
 * believing it did something — the same reason the picker names the column it
 * windows on rather than saying "Date range".
 */
@Component({
  selector: 'app-slice-filter',
  imports: [IconComponent],
  templateUrl: './slice-filter.html',
  styleUrl: './slice-filter.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class SliceFilterComponent {
  /** Which controls this module offers. */
  readonly spec = input.required<ChatReportFilterSpec>();
  /** What is currently typed into the form — NOT what is applied. */
  readonly value = input.required<ChatReportFilter>();
  /** True when the form differs from the applied slice. Gates Apply. */
  readonly dirty = input(false);
  /** True when a slice is currently applied. Gates Clear. */
  readonly active = input(false);
  /** Closed while a load is in flight — applying twice over would only queue work. */
  readonly disabled = input(false);

  readonly valueChange = output<Partial<ChatReportFilter>>();
  readonly apply = output<void>();
  readonly clear = output<void>();

  protected readonly icons = {
    search: 'M11 19a8 8 0 1 1 0-16 8 8 0 0 1 0 16zM21 21l-4.3-4.3',
    filter: 'M3 5h18M7 12h10M11 19h2',
    close: 'M18 6 6 18M6 6l12 12',
  };

  protected readonly showSearch = computed(() => !!this.spec().searchPlaceholder);
  protected readonly showDates = computed(() => !!this.spec().dateLabel);

  protected onSearch(event: Event): void {
    this.valueChange.emit({ search: (event.target as HTMLInputElement).value });
  }

  protected onFrom(event: Event): void {
    this.valueChange.emit({ from: (event.target as HTMLInputElement).value || undefined });
  }

  protected onTo(event: Event): void {
    this.valueChange.emit({ to: (event.target as HTMLInputElement).value || undefined });
  }

  /**
   * Enter applies.
   *
   * A single text box with a button beside it reads as a search box, and a
   * search box that ignores Enter is the kind of dead end people press twice
   * before looking for the button.
   */
  protected onKeydown(event: KeyboardEvent): void {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    if (this.dirty() && !this.disabled()) this.apply.emit();
  }
}
