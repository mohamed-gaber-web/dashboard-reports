import { DestroyRef, Injectable, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { AiProviderId, AiProviderService } from '../../../../core/ai/ai-provider.service';
import { ChatReportApiService } from '../../services/chat-report-api.service';
import { ReportContextService, ReportDataContext } from '../../services/report-context.service';
import { ChatApiMessage, ChatTurn } from '../../models/chat-turn.model';
import { ReportPayload } from '../../models/report-payload.model';

/** Prompts offered on the empty screen, before there is a conversation. */
const STARTERS: readonly string[] = [
  'Summarise the open backorders',
  'Top 5 customers by units remaining',
  'Break down backorder lines by currency',
  'Which products have the most stock waiting to ship?',
];

/**
 * ViewModel for the chat-reports page.
 *
 * Owns the conversation, the in-flight request, and the grounded data context.
 * The View binds to it and does nothing else (NG-ARCH-02/03); the two services
 * it injects each do one thing — fetch aggregates, and call the endpoint.
 *
 * Provided in the page component, not root: the conversation belongs to the
 * screen, and leaving the route should end it rather than leave a stale
 * transcript waiting to reappear.
 */
@Injectable()
export class ChatReportsModel {
  private readonly api = inject(ChatReportApiService);
  private readonly contextService = inject(ReportContextService);
  private readonly aiProvider = inject(AiProviderService);
  private readonly destroyRef = inject(DestroyRef);

  // ── Model picker ─────────────────────────────────────────────────────────
  // Passed straight through from the app-wide service. The View binds to its
  // Model and to nothing else (NG-ARCH-03), and the selection is deliberately
  // NOT owned here: it is a property of the app, so switching provider on this
  // screen switches it on the AI Analyst too.
  readonly aiProviders = this.aiProvider.providers;
  readonly aiProviderId = this.aiProvider.selected;

  /**
   * Switching mid-conversation is safe and needs no reset: the history sent to
   * the endpoint is prose plus the grounded aggregates, neither of which is
   * provider-specific. The next answer simply comes from the other model.
   */
  setAiProvider(id: AiProviderId): void {
    this.aiProvider.select(id);
  }

  // ── Conversation ─────────────────────────────────────────────────────────
  private readonly _turns = signal<ChatTurn[]>([]);
  readonly turns = this._turns.asReadonly();

  private readonly _busy = signal(false);
  readonly busy = this._busy.asReadonly();

  private readonly _error = signal<string | null>(null);
  readonly error = this._error.asReadonly();

  // ── Grounding ────────────────────────────────────────────────────────────
  private readonly _context = signal<ReportDataContext | null>(null);
  readonly context = this._context.asReadonly();

  private readonly _contextLoading = signal(true);
  readonly contextLoading = this._contextLoading.asReadonly();

  private readonly _contextError = signal<string | null>(null);
  readonly contextError = this._contextError.asReadonly();

  readonly starters = STARTERS;

  readonly hasConversation = computed(() => this._turns().length > 0);

  /** Rows behind the aggregates, for the provenance line under each report. */
  readonly groundedRows = computed(() => this._context()?.rowCount ?? null);

  /**
   * Index of the newest assistant turn.
   *
   * Only that turn's chips stay live: an older reply's follow-ups were written
   * against a conversation state that has since moved on, and clicking one
   * silently asks a question whose context is gone.
   */
  readonly latestAssistantIndex = computed(() => {
    const turns = this._turns();
    for (let i = turns.length - 1; i >= 0; i--) {
      if (turns[i].role === 'assistant') return i;
    }
    return -1;
  });

  private controller?: AbortController;

  constructor() {
    this.destroyRef.onDestroy(() => this.controller?.abort());
    this.loadContext();
  }

  /**
   * Fetch the aggregates the model reasons over.
   *
   * A failure here is not fatal — the chat still works, it is just ungrounded,
   * and the backend is told so explicitly and instructs the model not to invent
   * business figures. The UI says so too, rather than letting a user assume the
   * numbers came from D365.
   */
  loadContext(): void {
    this._contextLoading.set(true);
    this._contextError.set(null);

    this.contextService
      .load()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (context) => {
          this._context.set(context);
          this._contextLoading.set(false);
        },
        error: () => {
          this._contextError.set(
            'We couldn’t read the sales-order data, so answers won’t be grounded in it.',
          );
          this._contextLoading.set(false);
        },
      });
  }

  /** Ask a question. Also the path a suggestion chip takes. */
  send(text: string): void {
    const question = text.trim();
    if (!question || this._busy()) return;

    this._turns.update((turns) => [...turns, { role: 'user', content: question }]);
    this._busy.set(true);
    this._error.set(null);

    void this.request();
  }

  /**
   * Ask the last question again.
   *
   * The failed or unsatisfying assistant turn is dropped first, so the retry
   * sees the history the original saw rather than appending to a bad answer.
   */
  retry(): void {
    if (this._busy()) return;
    const turns = [...this._turns()];
    while (turns.length && turns[turns.length - 1].role === 'assistant') turns.pop();
    if (!turns.length) return;
    this._turns.set(turns);
    this._busy.set(true);
    this._error.set(null);
    void this.request();
  }

  /** Abandon the in-flight reply. The question stays, so Retry still works. */
  stop(): void {
    if (!this._busy()) return;
    this.controller?.abort();
    this._busy.set(false);
  }

  /** Start over. The data context is kept — it is the same dataset. */
  clear(): void {
    this.controller?.abort();
    this._turns.set([]);
    this._busy.set(false);
    this._error.set(null);
  }

  private async request(): Promise<void> {
    // Supersede any in-flight reply. Two answers racing into one transcript is
    // worse than losing the one the user already moved on from.
    this.controller?.abort();
    this.controller = new AbortController();
    const controller = this.controller;

    const result = await this.api.send(
      this.history(),
      this._context(),
      this.aiProvider.selected(),
      controller.signal,
    );

    // A newer request started, or the component went away, while this was in
    // flight. Its result is stale — dropping it is the point of the check.
    if (controller.signal.aborted) return;

    this._busy.set(false);

    if (result.ok) {
      this.append(result.payload);
      return;
    }
    // An empty message means "aborted", which the user already knows about.
    if (result.error) this._error.set(result.error);
  }

  private append(payload: ReportPayload): void {
    this._turns.update((turns) => [...turns, { role: 'assistant', payload }]);
  }

  /**
   * The conversation in wire form.
   *
   * An assistant turn is sent as its prose plus a compact note of what the
   * report contained. Without that note the model is blind to its own output —
   * "make that a line chart" or "now break it down by customer" has no subject,
   * and it rebuilds the whole report from memory of its own sentences. The full
   * payload is deliberately NOT sent back: it is mostly numbers the model
   * already stated, and resending them every turn would grow the context
   * without adding anything it does not already know.
   */
  private history(): ChatApiMessage[] {
    return this._turns().map((turn) =>
      turn.role === 'user'
        ? { role: 'user' as const, content: turn.content }
        : { role: 'assistant' as const, content: this.describe(turn.payload) },
    );
  }

  private describe(payload: ReportPayload): string {
    const parts = payload.components.map((component) => {
      switch (component.type) {
        case 'kpi_grid':
          return `a KPI grid (${component.items.map((i) => i.label).join(', ')})`;
        case 'chart':
          return `a ${component.chart_type} chart titled “${component.title}”`;
        case 'table':
          return `a table titled “${component.title}” with columns ${component.headers.join(', ')}`;
      }
    });

    const summary = parts.length ? ` [I rendered ${parts.join('; ')}.]` : '';
    return `${payload.text_response}${summary}`.trim() || '[Report rendered.]';
  }
}
