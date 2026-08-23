import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  effect,
  input,
  output,
  signal,
  viewChild,
} from '@angular/core';
import { IconComponent } from '../../../../shared/ui/icon/icon';
import { renderMarkdown } from '../../../../shared/utils/markdown.util';
import { DocumentFormat } from '../../models/analysis.model';
import { ChatMessage } from '../../models/chat-message.model';

/**
 * Conversational panel: message history, streaming reply, and the composer.
 *
 * ## Markdown
 *
 * Claude replies in Markdown, and this used to render it as raw text — bold came
 * through as literal asterisks and tables as pipes. Replies are now rendered via
 * {@link renderMarkdown}, which escapes before it emits any markup, and are bound
 * with `[innerHTML]` so Angular's sanitiser runs over the result as a second
 * layer. Neither layer is load-bearing alone.
 */
@Component({
  selector: 'app-chat-panel',
  imports: [IconComponent],
  templateUrl: './chat-panel.html',
  styleUrl: './chat-panel.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ChatPanelComponent {
  readonly messages = input.required<ChatMessage[]>();
  readonly streaming = input('');
  readonly busy = input(false);
  readonly error = input<string | null>(null);
  /** Whether there is anything worth putting in a document yet. */
  readonly canExport = input(false);

  readonly send = output<string>();
  /**
   * Emitted so the page can shrink the dock to fit. The panel cannot do it
   * alone: its height is set by the workspace that docks it.
   */
  readonly collapsedChange = output<boolean>();
  readonly stop = output<void>();
  readonly retry = output<void>();
  readonly exportDoc = output<DocumentFormat>();

  /**
   * Collapsed to the composer alone.
   *
   * The dock is a fixed band at the bottom of the workspace — that is the point,
   * the composer must not move between turns. But once a report is on screen the
   * report is what you want the height for, and the history has already been
   * read. Collapsing keeps the conversation exactly where it is and gives its
   * rows to the report.
   */
  protected readonly collapsed = signal(false);

  protected readonly draft = signal('');
  protected readonly copiedIndex = signal<number | null>(null);

  private readonly scroller = viewChild<ElementRef<HTMLElement>>('scroller');

  protected readonly icons = {
    sparkle: 'M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9L12 3z M5 3v4M3 5h4M19 17v4M17 19h4',
    send: 'M22 2 11 13M22 2l-7 20-4-9-9-4 20-7z',
    stop: 'M6 6h12v12H6z',
    copy: 'M9 9h10v10H9zM5 15V5h10',
    check: 'M20 6 9 17l-5-5',
    retry: 'M21 12a9 9 0 1 1-3-6.7M21 3v6h-6',
    pdf: 'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8zM14 2v6h6',
    html: 'm8 9-3 3 3 3M16 9l3 3-3 3',
    alert: 'M12 9v4m0 4h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z',
    chevron: 'm6 9 6 6 6-6',
  };

  protected toggleCollapsed(): void {
    const next = !this.collapsed();
    this.collapsed.set(next);
    this.collapsedChange.emit(next);
  }

  constructor() {
    // Follow the conversation as it grows and as tokens stream in. Reading the
    // signals here is what subscribes this effect to them.
    effect(() => {
      this.messages();
      this.streaming();
      this.busy();
      queueMicrotask(() => this.scrollToBottom());
    });
  }

  /** Assistant replies are Markdown; user messages are shown as typed. */
  protected renderBody(text: string): string {
    return renderMarkdown(text);
  }

  protected submit(): void {
    const text = this.draft().trim();
    if (!text || this.busy()) return;
    // Asking while collapsed would stream the answer into a hidden scroller.
    if (this.collapsed()) this.toggleCollapsed();
    this.send.emit(text);
    this.draft.set('');
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

  protected async copy(text: string, index: number): Promise<void> {
    try {
      await navigator.clipboard.writeText(text);
      this.copiedIndex.set(index);
      setTimeout(() => this.copiedIndex.update((i) => (i === index ? null : i)), 1600);
    } catch {
      // Clipboard denied (insecure origin, or the user said no). The message is
      // still on screen and selectable, so there is nothing useful to report.
    }
  }

  private scrollToBottom(): void {
    const el = this.scroller()?.nativeElement;
    if (!el) return;
    // Only follow when the user is already near the bottom — yanking the view
    // down while they are reading earlier messages is worse than not following.
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
    if (distance < 220) el.scrollTop = el.scrollHeight;
  }
}
