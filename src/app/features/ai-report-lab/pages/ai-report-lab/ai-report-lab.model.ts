import { DestroyRef, Injectable, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { forkJoin, of, switchMap } from 'rxjs';
import { AiProviderId, AiProviderService } from '../../../../core/ai/ai-provider.service';
import { Cube, MAX_ANALYZE_ROWS } from '../../../../core/aggregation/aggregate-plan.model';
import { ANALYST_SOURCES } from '../../../ai-analyst/analyst-sources';
import { AnalystFilter, AnalystSource } from '../../../ai-analyst/models/analyst-source.model';
import {
  AnalystDataService,
  DateBounds,
} from '../../../ai-analyst/services/analyst-data.service';
import { DataContextService } from '../../../ai-analyst/services/data-context.service';
import {
  ModuleContextPhase,
  ModuleContextService,
} from '../../../ai-analyst/services/module-context.service';
import {
  GeneratedReportArtifact,
  LabExportFormat,
  LabStage,
  LabTurn,
  PreviewWidth,
} from '../../models/report-artifact.model';
import { buildArtifactDocument } from '../../services/artifact-document';
import { parseArtifact } from '../../services/artifact.parser';
import { LabApiService } from '../../services/lab-api.service';
import { LabExportService, PrintUnavailableError } from '../../services/lab-export.service';
import { buildLabContext, describeSlice } from '../../services/lab-context.builder';

type Row = Record<string, unknown>;

/**
 * Slices this size or smaller are totalled automatically, as soon as they are
 * counted.
 *
 * The Report Builder makes totalling an explicit button because it can answer
 * plenty of questions from counts alone. This screen cannot: the model writes the
 * figures, so without sums it has nothing to write a report FROM, and the first
 * question of every session would be answered with an apology. 50,000 rows is
 * five pages and a couple of seconds — worth spending unasked.
 *
 * Above it, the button appears and the fold stays manual up to
 * {@link MAX_ANALYZE_ROWS}: 250,000 rows is closer to thirty seconds, and thirty
 * seconds of work nobody asked for is a hang.
 */
export const AUTO_TOTAL_ROWS = 50_000;

/**
 * ViewModel for the AI Report Lab.
 *
 * ## What it owns
 *
 * The whole prototype's state: which module, which slice, the figures behind it,
 * the conversation, and the one document currently on screen. The View binds to
 * this and to nothing else.
 *
 * ## Why the data is loaded BEFORE the question, not with it
 *
 * The other AI screens fetch their sample rows and date bounds at send time,
 * inside the turn. This one prefetches them the moment a slice settles, because
 * the prototype has to make "what is being sent to Claude?" answerable *before*
 * anything is sent — the inspector renders {@link contextMarkdown}, and a context
 * that only exists mid-request could not be inspected at all. It also means a
 * refinement spends no round trips on data it already has.
 *
 * ## The pipeline is reused, not reimplemented
 *
 * `count → gate → fold → aggregate` is `AnalystDataService` and
 * `DataContextService`, exactly as the AI Analyst and the Report Builder use
 * them. `Sha_SerialTrans` has ~11,000,000 rows and D365 F&O OData has no
 * `$apply`, no `groupby` and no `SUM` — it silently ignores `$apply` and returns
 * raw rows with HTTP 200 — so a total means reading every matching row through
 * the Worker fold, and `$count` is what prices that before a single row moves.
 * Nothing about the experiment changes any of that, so nothing about it is
 * duplicated here.
 *
 * ## Conversation state
 *
 * The transcript is prose. The DOCUMENT is held once and each successful reply
 * replaces it — which is what makes "remove the table" mean something. It rides
 * back with the next question so the model modifies what it built rather than
 * rebuilding it from the memory of its own covering notes.
 */
@Injectable()
export class AiReportLabModel {
  private readonly data = inject(AnalystDataService);
  private readonly contextBuilder = inject(DataContextService);
  private readonly moduleContext = inject(ModuleContextService);
  private readonly api = inject(LabApiService);
  private readonly exporter = inject(LabExportService);
  private readonly aiProvider = inject(AiProviderService);
  private readonly destroyRef = inject(DestroyRef);

  // ── Model picker ─────────────────────────────────────────────────────────
  // Passed through from the app-wide service. The selection is deliberately NOT
  // owned here: it is a property of the app, so switching provider on this
  // screen switches it everywhere.
  readonly aiProviders = this.aiProvider.providers;
  readonly aiProviderId = this.aiProvider.selected;

  readonly providerLabel = computed(
    () => this.aiProviders().find((p) => p.id === this.aiProviderId())?.label ?? this.aiProviderId(),
  );

  /**
   * Switching mid-conversation needs no reset: the transcript is prose and the
   * document is HTML, neither of which is provider-specific. The next answer
   * simply comes from the other model, and it can still be asked to change the
   * report already on screen.
   */
  setAiProvider(id: AiProviderId): void {
    this.aiProvider.select(id);
  }

  // ── Module ───────────────────────────────────────────────────────────────
  /** Shared with both existing AI screens — see `analyst-sources.ts`. */
  readonly sources: readonly AnalystSource[] = ANALYST_SOURCES;

  private readonly _activeId = signal(this.sources[0].id);
  readonly activeId = this._activeId.asReadonly();
  readonly activeSource = computed(
    () => this.sources.find((s) => s.id === this._activeId()) ?? this.sources[0],
  );

  /**
   * Starter prompts: the module's own three, plus one that exercises the thing
   * this screen exists to test — whether asking for a different KIND of report
   * produces a differently SHAPED document rather than the same dashboard.
   */
  readonly suggestions = computed(() => [
    ...this.activeSource().suggestions.slice(0, 3),
    'Give me a one-page executive summary',
  ]);

  private readonly _modulePhase = signal<ModuleContextPhase | null>(null);
  readonly modulePhase = this._modulePhase.asReadonly();

  /** The normalized module, as soon as it is known — metadata needs no I/O. */
  readonly moduleContextValue = computed(() => {
    const phase = this._modulePhase();
    return phase && phase.phase !== 'error' ? phase.context : null;
  });

  readonly moduleContextError = computed(() => {
    const phase = this._modulePhase();
    return phase?.phase === 'error' ? phase.message : null;
  });

  /** Earliest/latest value of the module's date field, when it has one. */
  private readonly dateRange = computed(() => {
    const phase = this._modulePhase();
    return phase?.phase === 'ready' ? phase.dateRange : undefined;
  });

  // ── The slice ────────────────────────────────────────────────────────────
  readonly filter = signal<AnalystFilter>({});
  readonly rowCount = signal<number | null>(null);
  readonly counting = signal(false);
  readonly dataError = signal<string | null>(null);

  private readonly sample = signal<Row[]>([]);
  private readonly bounds = signal<DateBounds>({});

  /** Folded cubes, keyed by the exact `$filter` they cover. */
  private readonly cubes = new Map<string, Cube>();
  readonly cube = signal<Cube | null>(null);
  readonly folding = signal(false);
  readonly foldLoaded = signal(0);

  readonly analyzeLimit = MAX_ANALYZE_ROWS;
  readonly autoTotalLimit = AUTO_TOTAL_ROWS;

  /** True when the slice is small enough to total. `$count` tells us for free. */
  readonly canAnalyze = computed(() => {
    const n = this.rowCount();
    return n !== null && n > 0 && n <= MAX_ANALYZE_ROWS;
  });

  /** True when the user must narrow before any SUM is possible. */
  readonly tooLarge = computed(() => (this.rowCount() ?? 0) > MAX_ANALYZE_ROWS);

  readonly foldProgress = computed(() => {
    const total = this.rowCount() ?? 0;
    return total ? Math.min(100, Math.round((this.foldLoaded() / total) * 100)) : 0;
  });

  readonly hasFilter = computed(() => {
    const f = this.filter();
    return !!(f.search || f.from || f.to);
  });

  /** How the data has been narrowed, as a sentence. Also goes in the document footer. */
  readonly sliceSentence = computed(() => describeSlice(this.filter(), this.moduleContextValue()));

  /** The aggregates for the current slice — real figures, or an honest gap. */
  private readonly dataContext = computed(() => {
    const total = this.rowCount();
    if (total === null) return null;
    return this.contextBuilder.build(
      this.activeSource(),
      total,
      this.sample(),
      this.bounds(),
      this.cube(),
    );
  });

  /**
   * Everything the model will be told, as Markdown.
   *
   * Exposed rather than built inside `send()` so the inspector can render it —
   * the grounding argument is only as good as a person's ability to check what
   * was actually sent.
   */
  readonly contextMarkdown = computed(() => {
    const module = this.moduleContextValue();
    const data = this.dataContext();
    if (!module || !data) return null;

    return buildLabContext({
      module,
      data,
      filter: this.filter(),
      ...(this.dateRange() ? { dateRange: this.dateRange() } : {}),
    });
  });

  // ── Conversation ─────────────────────────────────────────────────────────
  readonly turns = signal<LabTurn[]>([]);
  readonly streaming = signal('');
  readonly busy = signal(false);
  readonly stage = signal<LabStage>('idle');
  readonly progress = signal(0);
  readonly chatError = signal<string | null>(null);

  // ── The report ───────────────────────────────────────────────────────────
  readonly artifact = signal<GeneratedReportArtifact | null>(null);
  readonly hasArtifact = computed(() => this.artifact() !== null);

  /**
   * The complete document, and the ONLY thing the preview, the HTML export and
   * the PDF are built from. See `artifact-document.ts`.
   */
  readonly artifactDocument = computed(() => {
    const artifact = this.artifact();
    return artifact ? buildArtifactDocument(artifact) : null;
  });

  readonly previewWidth = signal<PreviewWidth>('desktop');
  readonly exporting = signal(false);

  readonly ready = computed(
    () => !!this.contextMarkdown() && !this.dataError() && (this.rowCount() ?? 0) > 0,
  );

  /** A dead composer has to say why it is dead. */
  readonly blockedReason = computed(() => {
    if (this.moduleContextError()) return this.moduleContextError();
    if (this.dataError()) return 'The data failed to load — retry above before asking.';
    if (this.rowCount() === null) return 'Reading this module — the composer unlocks as soon as it lands.';
    if (this.rowCount() === 0) {
      return this.hasFilter()
        ? 'This filter matches no rows. Widen the date range or clear the search, then ask.'
        : 'This module has no rows to report on.';
    }
    if (!this.contextMarkdown()) return 'Preparing the module’s figures…';
    return null;
  });

  private controller?: AbortController;
  private searchDebounce?: ReturnType<typeof setTimeout>;

  /**
   * Guards against a slower earlier load overwriting a newer one.
   *
   * Switching module fires a count that can take seconds on an 11M-row entity;
   * without this, switching back and forth lands the first module's row count
   * next to the second module's name.
   */
  private loadToken = 0;

  constructor() {
    this.destroyRef.onDestroy(() => {
      this.controller?.abort();
      this.data.cancelFold();
      clearTimeout(this.searchDebounce);
    });
    this.loadModuleContext();
    this.refreshData();
  }

  // ── Module + slice ───────────────────────────────────────────────────────

  /** Re-describe the selected module. Cheap: only the date range is read. */
  loadModuleContext(): void {
    this.moduleContext
      .load(this._activeId())
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((phase) => {
        // A slower earlier load must not overwrite the module the user has since
        // moved to.
        if (phase.phase !== 'error' && phase.context.moduleId !== this._activeId()) return;
        this._modulePhase.set(phase);
      });
  }

  /** Switch module. Everything on this screen is per-module, so all of it resets. */
  selectSource(id: string): void {
    if (id === this._activeId()) return;

    this.controller?.abort();
    this.data.cancelFold();
    clearTimeout(this.searchDebounce);

    this.turns.set([]);
    this.streaming.set('');
    this.busy.set(false);
    this.stage.set('idle');
    this.progress.set(0);
    this.chatError.set(null);
    // A document about backorder lines is nonsense once the schema under it is
    // inventory on hand, and leaving it up would invite a refinement against
    // figures that no longer exist.
    this.artifact.set(null);

    this.cube.set(null);
    this.cubes.clear();
    this.rowCount.set(null);
    this.sample.set([]);
    this.bounds.set({});
    this.filter.set({});
    this._activeId.set(id);
    // Cleared before reloading so the panel cannot show the previous module's
    // schema next to the new module's name for the length of one request.
    this._modulePhase.set(null);

    this.loadModuleContext();
    this.refreshData();
  }

  /** Narrow the slice. Re-reads the count (free) and drops any cube that no longer applies. */
  setFilter(patch: Partial<AnalystFilter>): void {
    this.filter.update((f) => ({ ...f, ...patch }));
    this.cube.set(null);
    this.data.cancelFold();
    this.refreshData();
  }

  /**
   * Search, debounced.
   *
   * A count is cheap but not free (~2 s at 11M rows) and it is a round trip to
   * D365. Firing one per keystroke would queue a dozen requests for one word.
   */
  setSearch(term: string): void {
    clearTimeout(this.searchDebounce);
    this.searchDebounce = setTimeout(() => this.setFilter({ search: term || undefined }), 350);
  }

  clearFilter(): void {
    clearTimeout(this.searchDebounce);
    this.filter.set({});
    this.cube.set(null);
    this.data.cancelFold();
    this.refreshData();
  }

  /**
   * Everything needed to describe the current slice: the exact count, a handful
   * of sample rows, and the date bounds.
   *
   * The count comes first and alone because it is the gate — it decides whether
   * totalling is even offered, and it costs nothing. The sample and bounds follow
   * only when there is something to sample.
   */
  refreshData(): void {
    const source = this.activeSource();
    const filter = this.filter();
    const token = ++this.loadToken;

    this.counting.set(true);
    this.dataError.set(null);

    this.data
      .count(source, filter)
      .pipe(
        switchMap((total) => {
          if (token !== this.loadToken) return of(null);
          this.rowCount.set(total);
          // A cube already folded for this exact filter is still valid.
          this.cube.set(this.cubes.get(this.data.buildFilter(source, filter)) ?? null);

          if (!total) return of({ sample: [] as Row[], bounds: {} as DateBounds });
          return forkJoin({
            sample: this.data.sample(source, filter),
            bounds: this.data.dateBounds(source, filter),
          });
        }),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe({
        next: (result) => {
          if (token !== this.loadToken || !result) return;
          this.sample.set(result.sample);
          this.bounds.set(result.bounds);
          this.counting.set(false);
          this.autoTotal();
        },
        error: () => {
          if (token !== this.loadToken) return;
          this.dataError.set('We couldn’t reach D365. Please try again.');
          this.counting.set(false);
        },
      });
  }

  /** Fold the current slice so sums and group-bys become available. */
  analyze(): void {
    const source = this.activeSource();
    const filter = this.filter();
    const total = this.rowCount();
    if (total === null || total === 0 || this.folding()) return;

    const key = this.data.buildFilter(source, filter);
    const cached = this.cubes.get(key);
    if (cached) {
      this.cube.set(cached);
      return;
    }

    this.folding.set(true);
    this.foldLoaded.set(0);
    this.dataError.set(null);

    try {
      this.data
        .fold(source, filter, total)
        .pipe(takeUntilDestroyed(this.destroyRef))
        .subscribe({
          next: (p) => {
            this.foldLoaded.set(p.loaded);
            if (p.cube) {
              this.cubes.set(key, p.cube);
              this.cube.set(p.cube);
            }
          },
          error: (e: unknown) => {
            this.dataError.set(e instanceof Error ? e.message : 'The analysis failed.');
            this.folding.set(false);
          },
          complete: () => this.folding.set(false),
        });
    } catch (e) {
      // SliceTooLargeError — the gate. Say the real number, don't start a crawl.
      this.dataError.set(e instanceof Error ? e.message : 'This slice is too large to analyse.');
      this.folding.set(false);
    }
  }

  cancelAnalyze(): void {
    this.data.cancelFold();
    this.folding.set(false);
  }

  /** See {@link AUTO_TOTAL_ROWS} for why a small slice is folded unasked. */
  private autoTotal(): void {
    const total = this.rowCount() ?? 0;
    if (total > 0 && total <= AUTO_TOTAL_ROWS && !this.cube() && !this.folding()) this.analyze();
  }

  // ── Conversation ─────────────────────────────────────────────────────────

  send(text: string): void {
    if (this.busy()) return;

    const context = this.contextMarkdown();
    if (!context) {
      this.chatError.set(this.blockedReason() ?? 'The module’s data has not loaded yet.');
      return;
    }

    const source = this.activeSource();
    const history = [...this.turns(), { role: 'user', content: text } as LabTurn];

    this.turns.set(history);
    this.busy.set(true);
    this.stage.set('reading');
    this.streaming.set('');
    this.progress.set(0);
    this.chatError.set(null);

    this.controller?.abort();
    this.controller = new AbortController();
    const signal = this.controller.signal;

    // Whether THIS turn produced a document, and what the parser had to repair.
    // Read off locals rather than off signals, because a fast reply can settle
    // the stage before the prose finishes streaming.
    let produced = false;
    let issues: string[] = [];

    const current = this.artifact();

    void this.api.stream(
      history,
      {
        onText: (t) => {
          if (this.stage() === 'reading') this.stage.set('analysing');
          this.streaming.update((s) => s + t);
        },
        onProgress: (chars) => {
          this.stage.set('designing');
          this.progress.set(chars);
        },
        onArtifact: (raw) => {
          this.stage.set('rendering');

          const result = parseArtifact(raw, {
            module: source.id,
            moduleLabel: source.label,
            provider: this.providerLabel(),
            ...(this.sliceSentence() ? { slice: this.sliceSentence() } : {}),
          });

          issues = result.issues;

          if (result.artifact) {
            produced = true;
            this.artifact.set(result.artifact);
          } else {
            // Nothing renderable came back. Say what went wrong and leave the
            // previous report on screen — replacing a good report with a blank
            // pane is a worse outcome than a failed refinement.
            this.chatError.set(
              result.issues[0] ?? 'The AI returned a report the app could not read.',
            );
          }
        },
        onDone: () => {
          // Gemini often calls a tool with NO prose at all; without this fallback
          // that turn renders as an empty bubble.
          const reply = this.streaming().trim() || '📄 Designed a report from your data.';
          this.turns.update((t) => [
            ...t,
            {
              role: 'assistant',
              content: reply,
              ...(produced ? { producedArtifact: true } : {}),
              ...(issues.length ? { issues } : {}),
            },
          ]);
          this.streaming.set('');
          this.busy.set(false);
          this.stage.set('idle');
          this.progress.set(0);
        },
        onError: (message) => {
          this.chatError.set(message);
          this.streaming.set('');
          this.busy.set(false);
          this.stage.set('idle');
          this.progress.set(0);
        },
      },
      {
        provider: this.aiProviderId(),
        context,
        moduleLabel: source.label,
        // What the model is looking at, so "change it" has a subject.
        ...(current ? { currentArtifact: { title: current.title, html: current.html } } : {}),
        signal,
      },
    );
  }

  /** Abandon the in-flight reply but keep what has already streamed. */
  stop(): void {
    if (!this.busy()) return;
    this.controller?.abort();
    const partial = this.streaming().trim();
    if (partial) this.turns.update((t) => [...t, { role: 'assistant', content: partial }]);
    this.streaming.set('');
    this.busy.set(false);
    this.stage.set('idle');
    this.progress.set(0);
  }

  /**
   * Ask the last question again.
   *
   * The failed or unsatisfying assistant turn is dropped first, so the retry sees
   * the same history the original did rather than appending to a bad answer.
   */
  retry(): void {
    if (this.busy()) return;
    const history = [...this.turns()];
    while (history.length && history[history.length - 1].role === 'assistant') history.pop();
    const last = history.pop();
    if (!last) return;
    this.turns.set(history);
    this.chatError.set(null);
    this.send(last.content);
  }

  /**
   * Refine the report on screen with a canned instruction.
   *
   * It goes through `send` like anything typed, deliberately: a refine button
   * taking a private path would be a second way to change the report and could
   * drift from what typing the same sentence does.
   */
  refine(instruction: string): void {
    if (!this.hasArtifact()) return;
    this.send(instruction);
  }

  // ── Export ───────────────────────────────────────────────────────────────

  /** Both formats render the same document string. See `lab-export.service.ts`. */
  async runExport(format: LabExportFormat): Promise<void> {
    const artifact = this.artifact();
    if (!artifact || this.exporting()) return;

    this.exporting.set(true);
    this.chatError.set(null);

    try {
      await this.exporter.export(format, artifact);
    } catch (e: unknown) {
      // PrintUnavailableError carries the way out (export the HTML and print it);
      // surface it verbatim rather than the generic failure text.
      this.chatError.set(
        e instanceof PrintUnavailableError ? e.message : 'The export failed. Please try again.',
      );
    } finally {
      this.exporting.set(false);
    }
  }

  setPreviewWidth(width: PreviewWidth): void {
    this.previewWidth.set(width);
  }
}
