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
import { LAB_STAGE_LABEL, LabStage, LabTurn } from '../../models/report-artifact.model';

/**
 * The Lab's conversation: history, the streaming covering note, the stage line
 * and the composer.
 *
 * Presentational — it holds draft text and a collapsed flag and nothing else. It
 * reads no service, knows nothing about D365 or about artifacts, and emits what
 * the user did.
 *
 * ## Markdown
 *
 * Assistant replies are Markdown, rendered through the app's shared
 * `renderMarkdown`, which **escapes before it emits any markup** — that ordering
 * is the whole security model, so nothing may be inserted after markup
 * generation. The result is bound with `[innerHTML]` so Angular's sanitiser runs
 * as a second layer. User turns are shown exactly as typed and never parsed.
 *
 * Note the split: chat prose is Markdown in the app's DOM, and the REPORT is HTML
 * in a sandbox. They are different trust domains and neither borrows the other's
 * mechanism.
 *
 * ## The stage line and the byte counter
 *
 * The document arrives as tool-call arguments, which are never shown, so a
 * designed report is twenty to forty seconds of nothing on screen. The stages are
 * real work — reading the slice, then designing, then rendering — and the
 * kilobyte counter is the live proof that a document is genuinely arriving rather
 * than the request having stalled. What is never shown is the model's reasoning:
 * no chain-of-thought reaches the browser at all.
 */
@Component({
  selector: 'app-lab-chat',
  imports: [IconComponent],
  templateUrl: './lab-chat.html',
  styleUrl: './lab-chat.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class LabChatComponent {
  readonly messages = input.required<LabTurn[]>();
  readonly streaming = input('');
  readonly busy = input(false);
  readonly stage = input<LabStage>('idle');
  /** Characters of the document received so far. 0 until one starts arriving. */
  readonly progress = input(0);
  readonly error = input<string | null>(null);
  /** Prompts offered while the conversation is empty. */
  readonly suggestions = input<readonly string[]>([]);
  readonly disabled = input(false);
  /** Why the composer is disabled, when it is. A dead control has to say why. */
  readonly disabledReason = input<string | null>(null);

  readonly send = output<string>();
  readonly stop = output<void>();
  readonly retry = output<void>();
  readonly collapsedChange = output<boolean>();

  protected readonly collapsed = signal(false);
  protected readonly draft = signal('');

  private readonly scroller = viewChild<ElementRef<HTMLElement>>('scroller');

  protected readonly icons = {
    sparkle: 'M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9L12 3z M5 3v4M3 5h4M19 17v4M17 19h4',
    send: 'M22 2 11 13M22 2l-7 20-4-9-9-4 20-7z',
    stop: 'M6 6h12v12H6z',
    retry: 'M21 12a9 9 0 1 1-3-6.7M21 3v6h-6',
    report: 'M4 4h16v16H4zM4 9h16M9 9v11',
    alert: 'M12 9v4m0 4h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z',
    chevron: 'm6 9 6 6 6-6',
  };

  constructor() {
    // Follow the conversation as it grows and as tokens stream in. Reading the
    // signals here is what subscribes this effect to them.
    effect(() => {
      this.messages();
      this.streaming();
      this.stage();
      queueMicrotask(() => this.scrollToBottom());
    });
  }

  protected stageLabel(stage: LabStage): string {
    return stage === 'idle' ? '' : LAB_STAGE_LABEL[stage];
  }

  /**
   * The stage line, with the document's size once one starts arriving.
   *
   * Rounded to whole kilobytes: the exact byte count is noise, and a number that
   * changes ten times a second reads as a glitch rather than as progress.
   */
  protected stageDetail(): string {
    const chars = this.progress();
    if (!chars) return '';
    return ` ${Math.round(chars / 1024).toLocaleString()} KB`;
  }

  protected toggleCollapsed(): void {
    const next = !this.collapsed();
    this.collapsed.set(next);
    this.collapsedChange.emit(next);
  }

  /** Assistant replies are Markdown; user messages are shown as typed. */
  protected renderBody(text: string): string {
    return renderMarkdown(text);
  }

  protected submit(): void {
    const text = this.draft().trim();
    if (!text || this.busy() || this.disabled()) return;
    // Asking while collapsed would stream the answer into a hidden scroller.
    if (this.collapsed()) this.toggleCollapsed();
    this.send.emit(text);
    this.draft.set('');
  }

  protected ask(text: string): void {
    if (this.busy() || this.disabled()) return;
    this.send.emit(text);
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
    // down while they are reading earlier messages is worse than not following.
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
    if (distance < 220) el.scrollTop = el.scrollHeight;
  }
}
