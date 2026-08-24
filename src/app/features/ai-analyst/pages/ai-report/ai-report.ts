import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  computed,
  inject,
  signal,
} from '@angular/core';
import { IconComponent } from '../../../../shared/ui/icon/icon';
import { ProviderSwitchComponent } from '../../../../shared/ui/provider-switch/provider-switch';
import { SkeletonComponent } from '../../../../shared/ui/skeleton/skeleton';
import { AnalysisPanelComponent } from '../../components/analysis-panel/analysis-panel';
import { ChatPanelComponent } from '../../components/chat-panel/chat-panel';
import { DynamicReportComponent } from '../../components/dynamic-report/dynamic-report';
import { AiReportModel } from './ai-report.model';

/**
 * AI Analyst screen — chat with the selected model to build & export dashboard
 * reports. Which model that is comes from the picker in the control bar.
 */
@Component({
  selector: 'app-ai-report',
  imports: [
    IconComponent,
    SkeletonComponent,
    ChatPanelComponent,
    DynamicReportComponent,
    AnalysisPanelComponent,
    ProviderSwitchComponent,
  ],
  templateUrl: './ai-report.html',
  styleUrl: './ai-report.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
  providers: [AiReportModel],
  // Close whichever menu is open on any click that lands outside it.
  host: { '(document:click)': 'onDocumentClick($event)' },
})
export class AiReportComponent {
  protected readonly model = inject(AiReportModel);
  private readonly host = inject(ElementRef<HTMLElement>);

  /**
   * Export menu open state. The toolbar previously carried up to four loose
   * ghost buttons (Excel, Full CSV, PDF, HTML) that appeared and disappeared
   * with the report state, so the toolbar's width changed as you used it. One
   * button that opens a menu keeps the chrome stable.
   */
  protected readonly exportOpen = signal(false);

  /**
   * Mirrors the chat panel's own collapsed state, because the dock's height
   * lives here: the panel folds its history away, and the band it sits in has
   * to stop reserving the space for it.
   */
  protected readonly chatCollapsed = signal(false);

  /**
   * Source picker state. The list of modules is expected to grow well past the
   * two it started with, so the options live in a menu instead of a tab strip
   * whose width grew with every module added.
   */
  protected readonly sourceOpen = signal(false);
  protected readonly sourceQuery = signal('');

  /**
   * The filter box only earns its space once scanning the list is slower than
   * typing. Below that it is a control asking to be used for no reason.
   */
  private static readonly SEARCH_FROM = 6;

  protected readonly showSourceSearch = computed(
    () => this.model.sources.length >= AiReportComponent.SEARCH_FROM,
  );

  protected readonly visibleSources = computed(() => {
    const query = this.sourceQuery().trim().toLowerCase();
    if (!query) return this.model.sources;
    return this.model.sources.filter(
      (source) =>
        source.label.toLowerCase().includes(query) ||
        (source.description ?? '').toLowerCase().includes(query),
    );
  });

  protected toggleExport(event: Event): void {
    event.stopPropagation();
    this.sourceOpen.set(false);
    this.exportOpen.update((open) => !open);
  }

  protected toggleSource(event: Event): void {
    event.stopPropagation();
    this.exportOpen.set(false);
    const open = !this.sourceOpen();
    this.sourceQuery.set('');
    this.sourceOpen.set(open);
    if (open) this.focusMenu();
  }

  /**
   * Move focus INTO the menu once it exists.
   *
   * It used to open with focus left on the trigger, which made the arrow-key
   * handler — bound to the menu — unreachable: you could open the list from the
   * keyboard and then not walk it. With a search box the box takes focus (you
   * are most likely to type); without one the selected option does, so Up/Down
   * starts from where you are rather than from the top of the list.
   *
   * The menu is rendered by the change detection this signal triggers, so
   * neither element exists yet — focus on the next task, not this one.
   */
  private focusMenu(): void {
    setTimeout(() => {
      if (this.showSourceSearch()) {
        this.query<HTMLInputElement>('.source-search-input')?.focus();
        return;
      }
      const active =
        this.query<HTMLElement>('.source-item-active') ?? this.query<HTMLElement>('.source-item');
      active?.focus();
    });
  }

  /**
   * The trigger's own keys. A combobox opens on Enter, Space, ArrowDown or
   * ArrowUp — this one only opened on click, so keyboard users had a button
   * that announced `aria-haspopup` and then did nothing they expected.
   */
  protected onTriggerKeydown(event: KeyboardEvent): void {
    if (event.key === 'Escape' && this.sourceOpen()) {
      event.preventDefault();
      this.sourceOpen.set(false);
      return;
    }
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    event.preventDefault();
    if (this.sourceOpen()) {
      this.focusMenu();
      return;
    }
    this.exportOpen.set(false);
    this.sourceQuery.set('');
    this.sourceOpen.set(true);
    this.focusMenu();
  }

  protected onSourceSearch(event: Event): void {
    this.sourceQuery.set((event.target as HTMLInputElement).value);
  }

  /**
   * Switch source and close — the menu never stays open over the result.
   *
   * Focus goes back to the trigger: the element that had it is being removed
   * from the DOM, and focus falling to <body> drops a keyboard user out of the
   * toolbar entirely.
   */
  protected chooseSource(id: string): void {
    this.sourceOpen.set(false);
    this.model.selectSource(id);
    setTimeout(() => this.query<HTMLElement>('.source-trigger')?.focus());
  }

  /**
   * Keyboard support for the menu: arrows walk the options, Escape closes and
   * hands focus back to the trigger so the tab order is not lost mid-list.
   */
  protected onSourceKeydown(event: KeyboardEvent): void {
    if (event.key === 'Escape') {
      event.preventDefault();
      this.sourceOpen.set(false);
      this.query<HTMLElement>('.source-trigger')?.focus();
      return;
    }
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;

    event.preventDefault();
    const items = Array.from(
      (this.host.nativeElement as HTMLElement).querySelectorAll<HTMLElement>('.source-item'),
    );
    if (!items.length) return;

    const current = items.indexOf(document.activeElement as HTMLElement);
    const step = event.key === 'ArrowDown' ? 1 : -1;
    // From the search box (index -1) ArrowUp should land on the last option.
    const next = current === -1 ? (step === 1 ? 0 : items.length - 1) : current + step;
    items[(next + items.length) % items.length].focus();
  }

  protected onDocumentClick(event: Event): void {
    this.closeOutside(event, '.export-menu-wrap', this.exportOpen);
    this.closeOutside(event, '.source-picker-wrap', this.sourceOpen);
  }

  private closeOutside(
    event: Event,
    selector: string,
    open: ReturnType<typeof signal<boolean>>,
  ): void {
    if (!open()) return;
    const wrap = this.query<HTMLElement>(selector);
    if (wrap && !wrap.contains(event.target as Node)) open.set(false);
  }

  private query<T extends HTMLElement>(selector: string): T | null {
    return (this.host.nativeElement as HTMLElement).querySelector<T>(selector);
  }

  /** Run an export and close the menu — the menu never stays open behind a download. */
  protected runExport(kind: 'pdf' | 'html' | 'excel' | 'csv'): void {
    this.exportOpen.set(false);
    switch (kind) {
      case 'pdf':
        this.model.exportPdf();
        break;
      case 'html':
        this.model.exportHtml();
        break;
      case 'excel':
        this.model.exportExcel();
        break;
      case 'csv':
        this.model.exportFullDetail();
        break;
    }
  }

  protected onSearch(event: Event): void {
    this.model.setSearch((event.target as HTMLInputElement).value);
  }

  protected onFrom(event: Event): void {
    this.model.setFilter({ from: (event.target as HTMLInputElement).value || undefined });
  }

  protected onTo(event: Event): void {
    this.model.setFilter({ to: (event.target as HTMLInputElement).value || undefined });
  }

  protected readonly icons = {
    excel: 'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8l-6-6zM14 2v6h6M9 13l6 4m0-4-6 4',
    pdf: 'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8l-6-6zM14 2v6h6M9 15h6M9 18h4',
    html: 'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8l-6-6zM14 2v6h6m-8 4-2 2 2 2m4-4 2 2-2 2',
    spark:
      'M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9L12 3z M5 3v4M3 5h4M19 17v4M17 19h4',
    search: 'M11 19a8 8 0 1 1 0-16 8 8 0 0 1 0 16zM21 21l-4.3-4.3',
    close: 'M18 6 6 18M6 6l12 12',
    check: 'M20 6 9 17l-5-5',
    download: 'M12 3v12m0 0 4-4m-4 4-4-4M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2',
    chevronDown: 'm6 9 6 6 6-6',
    database: 'M12 3c4.4 0 8 1.3 8 3s-3.6 3-8 3-8-1.3-8-3 3.6-3 8-3zM4 6v12c0 1.7 3.6 3 8 3s8-1.3 8-3V6',
  };
}
