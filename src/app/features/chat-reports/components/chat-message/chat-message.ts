import { ChangeDetectionStrategy, Component, computed, input, output } from '@angular/core';
import { DynamicReportRendererComponent } from '../dynamic-report-renderer/dynamic-report-renderer';
import { ReportPayload } from '../../models/report-payload.model';

/**
 * One assistant turn: the prose bubble, the report embedded inside it, and the
 * quick-suggestion chips underneath.
 *
 * All three are one reply, so they are one component. Splitting the chips out
 * would mean the page correlating them back to their message by index — and
 * getting that wrong shows the previous answer's follow-ups under the current
 * one, which reads as the assistant contradicting itself.
 *
 * Presentational only: it renders what it is given and emits what was clicked.
 * It owns no state and fetches nothing (NG-ARCH-03/05).
 */
@Component({
  selector: 'app-chat-message',
  imports: [DynamicReportRendererComponent],
  templateUrl: './chat-message.html',
  styleUrl: './chat-message.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ChatMessageComponent {
  readonly payload = input.required<ReportPayload>();
  /** Chips are only actionable on the newest turn, and never while one is in flight. */
  readonly actionsEnabled = input(true);
  /**
   * How many rows the aggregates behind this answer covered, when it was
   * grounded in real data.
   *
   * Drives the provenance line under a report. Unlike the AI Analyst — where
   * the app computes every figure from the dataset and the model cannot state a
   * number — this feature's contract has the MODEL author the figures. They are
   * grounded in real aggregates, but they are not recomputed and verified. That
   * difference is material to anyone deciding whether to act on the number, so
   * it is stated on the report rather than left for the reader to assume.
   */
  readonly groundedRows = input<number | null>(null);

  /** A chip was clicked. Its text is sent verbatim as the next user message. */
  readonly actionSelected = output<string>();

  protected readonly hasReport = computed(() => this.payload().components.length > 0);
  protected readonly hasActions = computed(() => this.payload().suggested_actions.length > 0);
  protected readonly dropped = computed(() => this.payload().dropped);

  protected select(action: string): void {
    if (!this.actionsEnabled()) return;
    this.actionSelected.emit(action);
  }
}
