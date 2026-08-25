import { ChangeDetectionStrategy, Component, HostListener, inject, signal } from '@angular/core';
import { IconComponent } from '../../../../shared/ui/icon/icon';
import { ProviderSwitchComponent } from '../../../../shared/ui/provider-switch/provider-switch';
import { SkeletonComponent } from '../../../../shared/ui/skeleton/skeleton';
import { BuilderChatComponent } from '../../components/builder-chat/builder-chat';
import { ReportCanvasComponent } from '../../components/report-canvas/report-canvas';
import { ExportFormat } from '../../models/conversation.model';
import { ReportBuilderModel } from './report-builder.model';

/**
 * AI Report Builder — the conversational reporting screen.
 *
 * ## Layout
 *
 * One control bar, then a workspace that fills whatever height is left: the
 * report on top (scrolls) and the conversation docked underneath (fixed height).
 * Stacked rather than side by side because the charts and the detail table are
 * the widest things on the page, and a chat column would take ~360px from them
 * on every screen while sitting in acres of its own.
 *
 * ## What this component owns
 *
 * Chrome and menus. It binds to its Model and to nothing else, and the Model
 * holds every piece of state and every decision. There is no logic here that
 * could produce a figure, a filter or a report.
 */
@Component({
  selector: 'app-report-builder',
  imports: [
    IconComponent,
    ProviderSwitchComponent,
    SkeletonComponent,
    BuilderChatComponent,
    ReportCanvasComponent,
  ],
  providers: [ReportBuilderModel],
  templateUrl: './report-builder.html',
  styleUrl: './report-builder.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ReportBuilderComponent {
  protected readonly model = inject(ReportBuilderModel);

  protected readonly exportOpen = signal(false);
  protected readonly chatCollapsed = signal(false);
  protected readonly copied = signal(false);

  protected readonly icons = {
    spark: 'M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9L12 3z M5 3v4M3 5h4M19 17v4M17 19h4',
    database: 'M12 3c4.4 0 8 1.3 8 3v12c0 1.7-3.6 3-8 3s-8-1.3-8-3V6c0-1.7 3.6-3 8-3z M4 6c0 1.7 3.6 3 8 3s8-1.3 8-3 M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3',
    search: 'M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16zM21 21l-4.35-4.35',
    close: 'M18 6 6 18M6 6l12 12',
    check: 'M20 6 9 17l-5-5',
    chevronDown: 'm6 9 6 6 6-6',
    download: 'M12 3v12m0 0 4-4m-4 4-4-4M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2',
    pdf: 'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8zM14 2v6h6',
    html: 'm8 9-3 3 3 3M16 9l3 3-3 3',
    excel: 'M4 4h16v16H4zM9 4v16M4 10h16',
    copy: 'M9 9h10v10H9zM5 15V5h10',
    retry: 'M21 12a9 9 0 1 1-3-6.7M21 3v6h-6',
    wand: 'M15 4V2m0 20v-2M4.9 4.9 3.5 3.5m17 17-1.4-1.4M4 15H2m20 0h-2M6 21 21 6l-3-3L3 18z',
  };

  /**
   * Canned refinements, offered beside the report.
   *
   * They are sentences, not switches, and they go through the same `send` path
   * as anything typed — a button that took a private route would be a second way
   * to change the report and could drift from what typing it does.
   */
  protected readonly refinements = [
    { label: 'More executive', prompt: 'Make this report more executive: fewer figures, a short summary and the key insights only.' },
    { label: 'More detail', prompt: 'Give me a more detailed version of this report — add the supporting breakdowns and the reasoning.' },
    { label: 'Explain the change', prompt: 'Why do these figures look the way they do? Add the comparison and the contributing factors.' },
  ];

  protected toggleExport(event: MouseEvent): void {
    event.stopPropagation();
    this.exportOpen.update((open) => !open);
  }

  /** A menu that does not close when you click elsewhere is a menu you fight. */
  @HostListener('document:click')
  protected closeMenus(): void {
    this.exportOpen.set(false);
  }

  @HostListener('document:keydown.escape')
  protected onEscape(): void {
    this.exportOpen.set(false);
  }

  protected runExport(format: ExportFormat): void {
    this.exportOpen.set(false);
    void this.model.runExport(format);
  }

  protected runCsv(): void {
    this.exportOpen.set(false);
    this.model.exportFullDetail();
  }

  protected onSourceChange(event: Event): void {
    this.model.selectSource((event.target as HTMLSelectElement).value);
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

  protected async copyReport(): Promise<void> {
    const text = this.model.copyText();
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      this.copied.set(true);
      setTimeout(() => this.copied.set(false), 1600);
    } catch {
      // Clipboard denied (insecure origin, or the user said no). The report is
      // still on screen and selectable, so there is nothing useful to report.
    }
  }
}
