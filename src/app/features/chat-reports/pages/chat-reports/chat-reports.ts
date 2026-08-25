import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  computed,
  effect,
  inject,
  signal,
  viewChild,
} from '@angular/core';
import { PageHeaderComponent } from '../../../../shared/ui/page-header/page-header';
import { ProviderSwitchComponent } from '../../../../shared/ui/provider-switch/provider-switch';
import { SourcePickerComponent } from '../../../../shared/ui/source-picker/source-picker';
import { ChatMessageComponent } from '../../components/chat-message/chat-message';
import { SliceFilterComponent } from '../../components/slice-filter/slice-filter';
import { isReportStyle } from '../../models/report-style.model';
import { ChatReportsModel } from './chat-reports.model';

/**
 * The chat-reports screen: ask a question, get a rendered report in the reply.
 *
 * View only. Every piece of state and every decision lives in
 * {@link ChatReportsModel}, which is provided here so the conversation ends
 * when the route does (NG-ARCH-02/03).
 *
 * The two signals it does own — the composer draft and the transcript's scroll
 * position — are local UI concerns that nothing outside this component reads,
 * which is what NG-ARCH-05 permits a View to keep.
 */
@Component({
  selector: 'app-chat-reports',
  imports: [
    PageHeaderComponent,
    ChatMessageComponent,
    ProviderSwitchComponent,
    SourcePickerComponent,
    SliceFilterComponent,
  ],
  providers: [ChatReportsModel],
  templateUrl: './chat-reports.html',
  styleUrl: './chat-reports.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ChatReportsComponent {
  protected readonly model = inject(ChatReportsModel);

  protected readonly draft = signal('');

  private readonly scroller = viewChild<ElementRef<HTMLElement>>('scroller');

  protected readonly icons = {
    send: 'M22 2 11 13M22 2l-7 20-4-9-9-4 20-7z',
    stop: 'M6 6h12v12H6z',
    alert: 'M12 9v4m0 4h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z',
  };

  /**
   * What the box says when you cannot type in it.
   *
   * A disabled input with its normal prompt still in it reads as broken. Each
   * reason the composer is closed is a different problem with a different fix,
   * so each one says which.
   */
  protected readonly composerPlaceholder = computed(() => {
    if (this.model.canChat()) return `Ask about ${this.model.source().label}…`;
    if (this.model.contextError()) return 'Data unavailable — retry above to start asking';
    if (this.model.noRows()) return 'No rows match this filter — widen it to start asking';
    return `Reading ${this.model.source().label} data…`;
  });

  constructor() {
    // Follow the transcript as it grows. Reading the signals here is what
    // subscribes this effect to them.
    effect(() => {
      this.model.turns();
      this.model.busy();
      queueMicrotask(() => this.scrollToBottom());
    });
  }

  protected submit(): void {
    const text = this.draft().trim();
    if (!text || this.model.busy()) return;
    this.model.send(text);
    this.draft.set('');
  }

  /** A suggestion chip sends its own text verbatim — the same path as typing it. */
  protected onAction(action: string): void {
    if (this.model.busy()) return;
    this.model.send(action);
  }

  /**
   * The shared picker emits a plain id, so the closed union is re-established
   * here rather than cast — the Model's setter refuses anything else, and this
   * keeps the View from being the place a bad value gets in.
   */
  protected onStyle(id: string): void {
    if (isReportStyle(id)) this.model.setStyle(id);
  }

  protected onKeydown(event: KeyboardEvent): void {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      this.submit();
    }
  }

  /** Grow the composer with its content, up to the CSS max-height. */
  protected onInput(event: Event): void {
    const el = event.target as HTMLTextAreaElement;
    this.draft.set(el.value);
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  }

  private scrollToBottom(): void {
    const el = this.scroller()?.nativeElement;
    if (!el) return;
    // Only follow when the user is already near the bottom — yanking the view
    // down while they are reading an earlier report is worse than not following.
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
    if (distance < 260) el.scrollTop = el.scrollHeight;
  }
}
