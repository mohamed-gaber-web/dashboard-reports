import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  inject,
  input,
  output,
  signal,
} from '@angular/core';
import { IconComponent } from '../../../../shared/ui/icon/icon';
import { ChatReportExportFormat } from '../../services/chat-report-export.service';

/**
 * "Export" on one chat reply.
 *
 * Per reply, not per screen: each answer in the transcript is its own report,
 * and a single toolbar button would have to guess which one the user meant —
 * almost always the wrong guess once the conversation has moved on.
 *
 * Presentational. It owns only whether its own menu is open, which is the kind
 * of local UI state NG-ARCH-05 permits a View to keep, and emits the chosen
 * format for the page to act on.
 */
@Component({
  selector: 'app-export-menu',
  imports: [IconComponent],
  templateUrl: './export-menu.html',
  styleUrl: './export-menu.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { '(document:click)': 'onDocumentClick($event)' },
})
export class ExportMenuComponent {
  readonly disabled = input(false);
  readonly chosen = output<ChatReportExportFormat>();

  private readonly host = inject(ElementRef<HTMLElement>);

  protected readonly open = signal(false);

  protected readonly icons = {
    download: 'M12 3v12m0 0 4-4m-4 4-4-4M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2',
    chevronDown: 'm6 9 6 6 6-6',
    pdf: 'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8l-6-6zM14 2v6h6M9 15h6M9 18h4',
    html: 'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8l-6-6zM14 2v6h6m-8 4-2 2 2 2m4-4 2 2-2 2',
    excel: 'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8l-6-6zM14 2v6h6M9 13l6 4m0-4-6 4',
  };

  protected toggle(event: Event): void {
    event.stopPropagation();
    if (this.disabled()) return;
    this.open.update((open) => !open);
  }

  /** Run and close — the menu never stays open behind a download. */
  protected choose(format: ChatReportExportFormat): void {
    this.open.set(false);
    this.chosen.emit(format);
  }

  protected onKeydown(event: KeyboardEvent): void {
    if (event.key !== 'Escape' || !this.open()) return;
    event.preventDefault();
    this.open.set(false);
    (this.host.nativeElement as HTMLElement).querySelector<HTMLElement>('.xm-trigger')?.focus();
  }

  protected onDocumentClick(event: Event): void {
    if (!this.open()) return;
    const el = this.host.nativeElement as HTMLElement;
    if (!el.contains(event.target as Node)) this.open.set(false);
  }
}
