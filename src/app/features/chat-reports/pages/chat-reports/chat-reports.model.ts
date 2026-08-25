import { DestroyRef, Injectable, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { AiProviderId, AiProviderService } from '../../../../core/ai/ai-provider.service';
import { BrandingService } from '../../../../core/branding/branding.service';
import { MAX_ANALYZE_ROWS } from '../../../../core/aggregation/aggregate-plan.model';
import { SourceOption } from '../../../../shared/models/source-option.model';
import { ChatReportApiService } from '../../services/chat-report-api.service';
import {
  ChatReportExportFormat,
  ChatReportExportService,
} from '../../services/chat-report-export.service';
import { ContextPhase, ReportContextService } from '../../services/report-context.service';
import {
  CHAT_REPORT_SOURCES,
  ChatReportFilter,
  DEFAULT_CHAT_REPORT_SOURCE,
  describeSlice,
  findChatReportSource,
  hasSliceFilter,
  sliceKey,
} from '../../sources/chat-report-sources';
import { ChatApiMessage, ChatTurn } from '../../models/chat-turn.model';
import { ReportPayload } from '../../models/report-payload.model';
import {
  REPORT_STYLES,
  REPORT_STYLE_KEY,
  ReportStyle,
  isReportStyle,
} from '../../models/report-style.model';

/**
 * ViewModel for the chat-reports page.
 *
 * Owns the conversation, the in-flight request, the slice the user has narrowed
 * to, and the grounded data context built from it. The View binds to it and
 * does nothing else (NG-ARCH-02/03); the two services it injects each do one
 * thing — fetch aggregates, and call the endpoint.
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
  private readonly exporter = inject(ChatReportExportService);
  private readonly branding = inject(BrandingService);
  private readonly destroyRef = inject(DestroyRef);

  // ── Source picker ────────────────────────────────────────────────────────
  /** The modules this screen can be pointed at. See `sources/chat-report-sources.ts`. */
  readonly sources: readonly SourceOption[] = CHAT_REPORT_SOURCES;

  private readonly _sourceId = signal(DEFAULT_CHAT_REPORT_SOURCE.id);
  readonly sourceId = this._sourceId.asReadonly();
  readonly source = computed(() => findChatReportSource(this._sourceId()));

  /**
   * Switch module.
   *
   * Everything is per-module, so all of it resets: a transcript about backorder
   * lines is nonsense once the schema underneath it is inventory on hand, and
   * the model would happily keep answering as though the old figures still
   * applied. The slice goes with it — "delivery date in March" means nothing on
   * a module with no delivery date, and carrying it over would silently apply a
   * window the new picker cannot even show. The data context is cached per
   * module and slice, so switching back is instant.
   */
  selectSource(id: string): void {
    if (id === this._sourceId()) return;
    this.controller?.abort();
    // Abandon the slice being left, cache included — a load interrupted by a
    // switch is not a decision to do without totals. See `cancelSlice`.
    this.contextService.cancelSlice(this._sourceId(), this._filter());
    this._turns.set([]);
    this._busy.set(false);
    this._error.set(null);
    this._filter.set({});
    this._draft.set({});
    this._sourceId.set(id);
    this.loadContext();
  }

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

  // ── Report style ─────────────────────────────────────────────────────────
  /** The shapes a reply can take. See `models/report-style.model.ts`. */
  readonly styles = REPORT_STYLES;

  private readonly _style = signal<ReportStyle>(readStyle());
  readonly style = this._style.asReadonly();

  /**
   * Switch style.
   *
   * Deliberately NOT a reset: the style picks which system prompt the NEXT
   * question uses, and the answers already on screen are still valid answers.
   * A transcript that holds a standard report and then an executive one is an
   * accurate record of what was asked. Sticky, because a user who wants the
   * designed brief wants it tomorrow too.
   */
  setStyle(style: ReportStyle): void {
    if (style === this._style()) return;
    this._style.set(style);
    try {
      localStorage.setItem(REPORT_STYLE_KEY, style);
    } catch {
      // Private mode, or storage disabled. The selection still works for this
      // session, which is the part that matters.
    }
  }

  // ── The slice ────────────────────────────────────────────────────────────
  /**
   * Two signals, on purpose: what is typed in the form, and what the figures on
   * screen actually cover.
   *
   * The AI Analyst filters live, because there a change costs one free count.
   * Here it costs a re-read and, on a mid-sized module, a fold of up to a minute
   * — and it moves the ground under a conversation already in progress. So the
   * form is a form: you fill it in, you press Apply, and until you do the badge
   * still describes the numbers you are looking at.
   */
  private readonly _draft = signal<ChatReportFilter>({});
  readonly draft = this._draft.asReadonly();

  private readonly _filter = signal<ChatReportFilter>({});
  readonly filter = this._filter.asReadonly();

  /** Which controls this module offers. Per module — see `ChatReportFilterSpec`. */
  readonly filterSpec = computed(() => this.source().filters);

  /** Whether this module can be sliced at all. */
  readonly filterable = computed(
    () => !!(this.filterSpec().dateLabel || this.filterSpec().searchPlaceholder),
  );

  /** True when the applied slice narrows the module. */
  readonly hasFilter = computed(() => hasSliceFilter(this._filter()));

  /** True when the form holds something not yet applied — what enables Apply. */
  readonly filterDirty = computed(
    () => sliceKey('', this._draft()) !== sliceKey('', this._filter()),
  );

  /** The applied slice in one sentence, for the badge under the header. */
  readonly sliceLabel = computed(() => describeSlice(this.source(), this._filter()));

  /** Type into the form. Nothing is re-read until {@link applyFilter}. */
  setDraft(patch: Partial<ChatReportFilter>): void {
    this._draft.update((f) => ({ ...f, ...patch }));
  }

  /**
   * Commit the form.
   *
   * The transcript is kept rather than wiped — losing a conversation because
   * someone adjusted a date would be its own kind of data loss — but it is
   * marked, because every figure above the mark was computed for a different
   * slice. The model is told the same thing from the other side: the system
   * prompt carries the current slice and an instruction never to reuse an
   * earlier figure from the history.
   */
  applyFilter(): void {
    if (!this.filterDirty()) return;
    const next = normalise(this._draft());

    this.controller?.abort();
    this.contextService.cancelSlice(this.source().id, this._filter());
    this._busy.set(false);
    this._error.set(null);
    this._filter.set(next);
    this._draft.set(next);

    if (this._turns().length) {
      this._turns.update((turns) => [
        ...turns,
        {
          role: 'notice',
          content:
            describeSlice(this.source(), next) ??
            'Filter cleared — figures below cover the whole module again.',
        },
      ]);
    }

    this.loadContext();
  }

  /** Empty the form and apply that, in one press. */
  clearFilter(): void {
    this._draft.set({});
    this.applyFilter();
  }

  // ── Conversation ─────────────────────────────────────────────────────────
  private readonly _turns = signal<ChatTurn[]>([]);
  readonly turns = this._turns.asReadonly();

  private readonly _busy = signal(false);
  readonly busy = this._busy.asReadonly();

  private readonly _error = signal<string | null>(null);
  readonly error = this._error.asReadonly();

  // ── Grounding ────────────────────────────────────────────────────────────
  /**
   * How far the current load has got. Null before the first one starts.
   *
   * A single signal rather than the old loading/loaded pair, because the phases
   * are what the UI has to say out loud: on a large module the wait IS the
   * screen, and "Reading data…" for sixty seconds is indistinguishable from a
   * hang.
   */
  private readonly _phase = signal<ContextPhase | null>(null);
  readonly phase = this._phase.asReadonly();

  private readonly _contextError = signal<string | null>(null);
  readonly contextError = this._contextError.asReadonly();

  readonly context = computed(() => {
    const phase = this._phase();
    return phase?.phase === 'ready' ? phase.context : null;
  });

  readonly contextLoading = computed(
    () => !!this._phase() && this._phase()?.phase !== 'ready' && !this._contextError(),
  );

  /**
   * Rows in the current slice, as soon as they are known.
   *
   * Available from the count onward, not just at the end — it is the number the
   * user is waiting on, and the one that decides whether waiting is worth it.
   */
  readonly rowCount = computed(() => {
    const phase = this._phase();
    if (!phase) return null;
    if (phase.phase === 'ready') return phase.context.rowCount;
    if (phase.phase === 'reading' || phase.phase === 'totalling') return phase.rowCount;
    return null;
  });

  /** Rows behind the aggregates, for the provenance line under each report. */
  readonly groundedRows = computed(() => this.context()?.rowCount ?? null);

  readonly totalling = computed(() => this._phase()?.phase === 'totalling');

  readonly foldPercent = computed(() => {
    const phase = this._phase();
    if (phase?.phase !== 'totalling' || !phase.rowCount) return 0;
    return Math.min(100, Math.round((phase.loaded / phase.rowCount) * 100));
  });

  readonly foldLoaded = computed(() => {
    const phase = this._phase();
    return phase?.phase === 'totalling' ? phase.loaded : 0;
  });

  /** The ceiling on what can be totalled in the browser. Shown when we hit it. */
  readonly analyzeLimit = MAX_ANALYZE_ROWS;

  /**
   * True when the slice is past the fold limit, so there will be no sums at all.
   *
   * Distinct from {@link countsOnly}, which is the same condition observed after
   * the fact. This one is known from the count, which is why the UI can offer
   * the filter as the fix *while* the load is still running.
   */
  readonly tooLarge = computed(() => (this.rowCount() ?? 0) > MAX_ANALYZE_ROWS);

  /** Per module — a starter that the selected dataset cannot answer is worse than none. */
  readonly starters = computed(() => this.source().starters);

  readonly hasConversation = computed(() => this._turns().length > 0);

  /**
   * True when the module was too large to total, so the summary has counts but
   * no sums.
   *
   * Surfaced in the UI because this contract has the MODEL state the figures:
   * a user needs to know the answer can only count rows before they ask for a
   * total that cannot be given.
   */
  readonly countsOnly = computed(() => this.context()?.coverage === 'pending');

  /**
   * Whether asking a question can produce a grounded answer yet.
   *
   * The composer is closed until it does. This screen's whole guarantee is that
   * figures come from real aggregates, and a question asked before they land —
   * or against a slice that matched nothing — is answered by a model with no
   * data and every incentive to fill the silence. Better to hold the box shut
   * for a few seconds and say why than to let one plausible fabrication through.
   */
  readonly canChat = computed(() => (this.context()?.rowCount ?? 0) > 0);

  /** The slice matched nothing. A real answer, and a different one from "still loading". */
  readonly noRows = computed(() => this.context()?.rowCount === 0);

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
    // Only the chat request is abandoned on leaving. The context load is left to
    // finish and cache: it is a read of the same dataset either way, and coming
    // back to a module that is already totalled is the whole point of caching it.
    this.destroyRef.onDestroy(() => this.controller?.abort());
    this.loadContext();
  }

  /**
   * Fetch the aggregates the model reasons over, for the current module and slice.
   *
   * A failure here is not fatal to the page — but it does close the composer.
   * The chat would still function ungrounded, and the backend would be told so
   * and would instruct the model to invent nothing; on a screen whose contract
   * has the model state the figures, that is a worse offer than a clear "we
   * could not read the data, try again".
   */
  loadContext(): void {
    const source = this.source();
    const filter = this._filter();
    const key = sliceKey(source.id, filter);

    this._phase.set({ phase: 'counting' });
    this._contextError.set(null);

    this.contextService
      .load(source, filter)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (phase) => {
          // A slower earlier load must not overwrite the module or the slice the
          // user has since moved to.
          if (this.currentKey() !== key) return;
          this._phase.set(phase);
        },
        error: () => {
          if (this.currentKey() !== key) return;
          this._contextError.set(
            `We couldn’t read the ${source.label} data, so there is nothing to ground answers in.`,
          );
        },
      });
  }

  /** Re-read from D365, discarding every cached slice of this module. */
  reloadContext(): void {
    this.contextService.refresh(this.source().id);
    this.loadContext();
  }

  /**
   * Stop totalling and take the counts.
   *
   * Deliberately not a cancel-the-whole-load: the context still completes, just
   * without sums, which is the same shape an over-limit module produces and
   * which the prompt and the UI already handle honestly.
   */
  skipTotals(): void {
    if (!this.totalling()) return;
    this.contextService.skipTotals();
  }

  private currentKey(): string {
    return sliceKey(this.source().id, this._filter());
  }

  /** Ask a question. Also the path a suggestion chip takes. */
  send(text: string): void {
    const question = text.trim();
    if (!question || this._busy() || !this.canChat()) return;

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
    if (this._busy() || !this.canChat()) return;
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

  /** Start over. The data context is kept — it is the same dataset and slice. */
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
      this.context(),
      this.aiProvider.selected(),
      this._style(),
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

  // ── Export ───────────────────────────────────────────────────────────────

  /**
   * Take one reply away as a document or a workbook.
   *
   * The turn index rather than the payload, so the question that produced it can
   * be recovered — it titles the document, and "Top 10 items by quantity on
   * hand.pdf" is a filename someone can find again a week later.
   */
  exportTurn(index: number, format: ChatReportExportFormat): void {
    const turn = this._turns()[index];
    if (!turn || turn.role !== 'assistant') return;

    this.exporter.export(format, {
      payload: turn.payload,
      question: this.questionBefore(index),
      sourceLabel: this.source().label,
      groundedRows: this.groundedRows(),
      brandName: this.branding.appName(),
    });
  }

  /** The user turn this answer replied to. */
  private questionBefore(index: number): string {
    const turns = this._turns();
    for (let i = index - 1; i >= 0; i--) {
      const turn = turns[i];
      if (turn.role === 'user') return turn.content;
    }
    return '';
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
   *
   * A `notice` turn is dropped. The wire has two roles and the endpoint expects
   * them to alternate, so a slice change is told to the model where it belongs
   * — in the system prompt, which carries the CURRENT slice on every request
   * along with the instruction not to reuse an earlier figure.
   */
  private history(): ChatApiMessage[] {
    return this._turns()
      .filter((turn): turn is Exclude<ChatTurn, { role: 'notice' }> => turn.role !== 'notice')
      .map((turn) =>
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
        // The document's markup is never sent back: it is tens of thousands of
        // characters of CSS and SVG the model wrote itself, and re-sending it
        // every turn would fill the context with its own output. A note that one
        // exists is all "make the KPIs bigger" needs to have a subject.
        case 'html_document':
          return `a designed executive report${component.title ? ` titled “${component.title}”` : ''}`;
      }
    });

    const summary = parts.length ? ` [I rendered ${parts.join('; ')}.]` : '';
    return `${payload.text_response}${summary}`.trim() || '[Report rendered.]';
  }
}

/**
 * The remembered style, or the default.
 *
 * Read through the closed-enum check rather than cast: `localStorage` is
 * user-writable and survives a deploy that removed a style, so an unknown value
 * is treated as absent instead of reaching the wire.
 */
function readStyle(): ReportStyle {
  try {
    const stored = localStorage.getItem(REPORT_STYLE_KEY);
    return isReportStyle(stored) ? stored : 'standard';
  } catch {
    return 'standard';
  }
}

/** Drop empty strings so `{search: ''}` and `{}` are the same slice. */
function normalise(filter: ChatReportFilter): ChatReportFilter {
  const out: ChatReportFilter = {};
  if (filter.from) out.from = filter.from;
  if (filter.to) out.to = filter.to;
  const search = filter.search?.trim();
  if (search) out.search = search;
  return out;
}
