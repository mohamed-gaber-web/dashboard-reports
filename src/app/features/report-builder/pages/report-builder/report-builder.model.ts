import { DestroyRef, Injectable, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { filter as rxFilter, forkJoin, map, of, switchMap, tap } from 'rxjs';
import { AiProviderId, AiProviderService } from '../../../../core/ai/ai-provider.service';
import { Cube, MAX_ANALYZE_ROWS } from '../../../../core/aggregation/aggregate-plan.model';
import { SliceTooLargeError } from '../../../../core/aggregation/aggregation.service';
import { and } from '../../../../core/http/odata-filter.util';
import { ANALYST_SOURCES } from '../../../ai-analyst/analyst-sources';
import { AnalystFilter, AnalystSource } from '../../../ai-analyst/models/analyst-source.model';
import { AnalystDataService } from '../../../ai-analyst/services/analyst-data.service';
import { DataContextService } from '../../../ai-analyst/services/data-context.service';
import { SpecCompilerService } from '../../../ai-analyst/services/spec-compiler.service';
import { ExportTooLargeError } from '../../../ai-analyst/services/export.service';
import {
  BuildStage,
  ConversationTurn,
  ExportFormat,
} from '../../models/conversation.model';
import { ComposedReport, ReportDefinition } from '../../models/report-definition.model';
import { BuilderApiService } from '../../services/builder-api.service';
import { BuilderExportService } from '../../services/builder-export.service';
import { ReportComposerService, TABLE_DISPLAY_LIMIT } from '../../services/report-composer.service';
import { validateDefinition } from '../../services/report-definition.validator';

/**
 * ViewModel for the AI Report Builder.
 *
 * ## Why it looks like this and not like a list ViewModel
 *
 * It never loads a dataset. `Sha_SerialTrans` has ~11,000,000 rows and D365 F&O
 * OData caps any response at 10,000 — and has no `$apply`, no `groupby` and no
 * `SUM`, which it does not even reject, it silently ignores. So:
 *
 * 1. **Count first.** `$count` is exact, transfers zero rows, and returns in a
 *    few seconds at 11M. The screen always knows the true size of the slice.
 * 2. **Gate on the count.** Under {@link MAX_ANALYZE_ROWS} the slice is folded in
 *    a Worker. Over it, we say so and ask the user to narrow — rather than
 *    starting a twenty-minute crawl behind a spinner, or quietly totalling the
 *    first five thousand rows and calling that the answer.
 * 3. **Counts, dates and detail rows never need the fold.** They are native
 *    OData and stay instant at full scale, which is why a "how many X?" question
 *    answers immediately while "top X by revenue" has to total first.
 *
 * ## Conversation state
 *
 * The transcript is prose. The REPORT is held once, as `definition` (what the
 * model asked for) and `report` (what the app computed), and each new answer
 * replaces it. That is what makes "remove the chart" mean something: the
 * definition rides back with the next question so the model can modify what it
 * built instead of rebuilding it from the memory of its own sentences.
 */
@Injectable()
export class ReportBuilderModel {
  private readonly data = inject(AnalystDataService);
  private readonly context = inject(DataContextService);
  private readonly composer = inject(ReportComposerService);
  private readonly compiler = inject(SpecCompilerService);
  private readonly api = inject(BuilderApiService);
  private readonly exporter = inject(BuilderExportService);
  private readonly aiProvider = inject(AiProviderService);
  private readonly destroyRef = inject(DestroyRef);

  // ── Model picker ─────────────────────────────────────────────────────────
  // Passed straight through from the app-wide service. The selection is
  // deliberately NOT owned here: it is a property of the app, so switching
  // provider on this screen switches it on the AI Analyst too.
  readonly aiProviders = this.aiProvider.providers;
  readonly aiProviderId = this.aiProvider.selected;

  /**
   * Switching mid-conversation is safe and needs no reset: the transcript is
   * prose, and the report on screen is a definition the app composed itself, not
   * provider-specific output. The next answer simply comes from the other model,
   * and it can still be asked to change the existing report.
   */
  setAiProvider(id: AiProviderId): void {
    this.aiProvider.select(id);
  }

  // ── Module ───────────────────────────────────────────────────────────────
  /** Shared with the AI Analyst — see `analyst-sources.ts`. */
  readonly sources: readonly AnalystSource[] = ANALYST_SOURCES;

  private readonly _activeId = signal(this.sources[0].id);
  readonly activeId = this._activeId.asReadonly();
  readonly activeSource = computed(
    () => this.sources.find((s) => s.id === this._activeId()) ?? this.sources[0],
  );
  readonly suggestions = computed(() => this.activeSource().suggestions);

  // ── The user's slice ─────────────────────────────────────────────────────
  readonly filter = signal<AnalystFilter>({});
  readonly rowCount = signal<number | null>(null);
  readonly counting = signal(false);
  readonly dataError = signal<string | null>(null);

  /** Folded cubes, keyed by the exact `$filter` they cover. */
  private readonly cubes = new Map<string, Cube>();
  readonly cube = signal<Cube | null>(null);
  readonly folding = signal(false);
  readonly foldLoaded = signal(0);

  readonly analyzeLimit = MAX_ANALYZE_ROWS;

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

  // ── Conversation ─────────────────────────────────────────────────────────
  readonly turns = signal<ConversationTurn[]>([]);
  readonly streaming = signal('');
  readonly busy = signal(false);
  readonly stage = signal<BuildStage>('idle');
  readonly chatError = signal<string | null>(null);

  // ── The report ───────────────────────────────────────────────────────────
  readonly report = signal<ComposedReport | null>(null);
  readonly hasReport = computed(() => this.report() !== null);
  readonly hasDetailTable = computed(() =>
    (this.report()?.blocks ?? []).some((b) => b.kind === 'table'),
  );

  readonly ready = computed(() => this.rowCount() !== null && !this.dataError());
  readonly blockedReason = computed(() => {
    if (this.dataError()) return 'The row count failed to load — retry above before asking.';
    if (this.rowCount() === null) return 'Counting the current slice — the composer unlocks as soon as it lands.';
    return null;
  });

  readonly exporting = signal(false);
  readonly exportWritten = signal(0);

  private controller?: AbortController;
  private searchDebounce?: ReturnType<typeof setTimeout>;
  /** Set by `export_document`; acted on once the turn (and its report) completes. */
  private pendingExport: ExportFormat | null = null;
  /**
   * The definition behind the report on screen. Sent back with the next question
   * so the model modifies what it built. Cleared when the module changes — a
   * definition written against Sales Order fields means nothing on Purchase Order.
   */
  private definition: ReportDefinition | null = null;
  /**
   * The `$filter` the CURRENT REPORT covers, including clauses the definition
   * added. Exporting the user's broader slice would hand back a different dataset
   * from the one on screen.
   */
  private reportFilter?: string;

  constructor() {
    this.destroyRef.onDestroy(() => {
      this.controller?.abort();
      this.data.cancelFold();
      clearTimeout(this.searchDebounce);
    });
    this.refreshCount();
  }

  // ── Module + slice ───────────────────────────────────────────────────────

  /** Switch module. Everything is per-module, so all of it resets. */
  selectSource(id: string): void {
    if (id === this._activeId()) return;
    this.controller?.abort();
    this.data.cancelFold();
    this.turns.set([]);
    this.streaming.set('');
    this.busy.set(false);
    this.stage.set('idle');
    this.chatError.set(null);
    this.report.set(null);
    this.definition = null;
    this.reportFilter = undefined;
    this.cube.set(null);
    this.cubes.clear();
    this.rowCount.set(null);
    this.filter.set({});
    this._activeId.set(id);
    this.refreshCount();
  }

  /** Narrow the slice. Re-counts (free) and drops any cube that no longer applies. */
  setFilter(patch: Partial<AnalystFilter>): void {
    this.filter.update((f) => ({ ...f, ...patch }));
    this.cube.set(null);
    this.data.cancelFold();
    this.refreshCount();
  }

  /**
   * Search, debounced.
   *
   * A count is cheap but not free (~2 s at 11M rows) and it is a round-trip to
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
    this.refreshCount();
  }

  /**
   * How many rows the current filter matches. Zero rows transferred — this is
   * the one real aggregate D365 gives us, and every gate below depends on it.
   */
  refreshCount(): void {
    this.counting.set(true);
    this.dataError.set(null);

    this.data
      .count(this.activeSource(), this.filter())
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (n) => {
          this.rowCount.set(n);
          this.counting.set(false);
          // A cube already folded for this exact filter is still valid.
          const key = this.data.buildFilter(this.activeSource(), this.filter());
          this.cube.set(this.cubes.get(key) ?? null);
        },
        error: () => {
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
    if (total === null || this.folding()) return;

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

  // ── Conversation ─────────────────────────────────────────────────────────

  send(text: string): void {
    if (this.busy() || !this.ready()) return;

    const source = this.activeSource();
    const filter = this.filter();
    const total = this.rowCount() ?? 0;

    const history = [...this.turns(), { role: 'user', content: text } as ConversationTurn];
    this.turns.set(history);
    this.busy.set(true);
    this.stage.set('understanding');
    this.streaming.set('');
    this.chatError.set(null);

    this.controller?.abort();
    this.controller = new AbortController();
    const signal = this.controller.signal;

    // Only aggregates, the schema and a handful of sample rows ever leave the
    // browser. The raw dataset never does. When the slice has not been folded,
    // `DataContext` says `coverage: 'pending'` and the prompt tells the model, in
    // so many words, that no sum is available — we never ship an unlabelled
    // estimate.
    forkJoin({
      sample: this.data.sample(source, filter),
      bounds: this.data.dateBounds(source, filter),
    })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: ({ sample, bounds }) => {
          if (signal.aborted) return;
          this.stage.set('analysing');
          const dataContext = this.context.build(source, total, sample, bounds, this.cube());

          // Whether THIS turn emitted a report. Read off a flag rather than off
          // `stage()`, because a report that computes faster than the prose
          // finishes streaming would already have returned the stage to idle.
          let producedReport = false;

          void this.api.stream(
            history,
            dataContext,
            {
              onText: (t) => {
                this.stage.set('composing');
                this.streaming.update((s) => s + t);
              },
              onReport: (raw) => {
                producedReport = true;
                this.stage.set('computing');
                this.buildReport(raw);
              },
              // The model asked for a download. Defer to the end of the turn: a
              // report emitted in the same reply is still being computed, and
              // exporting now would ship the previous one.
              onExport: (format) => (this.pendingExport = format),
              onDone: () => {
                // Gemini often calls a tool with NO prose at all; without this
                // fallback that turn renders as an empty bubble.
                const reply = this.streaming().trim() || '📊 Composed a report from your data.';
                this.turns.update((t) => [
                  ...t,
                  { role: 'assistant', content: reply, producedReport },
                ]);
                this.streaming.set('');
                this.busy.set(false);
                if (this.stage() !== 'computing') this.stage.set('idle');

                const format = this.pendingExport;
                this.pendingExport = null;
                if (format) void this.runExport(format);
              },
              onError: (message) => {
                this.chatError.set(message);
                this.streaming.set('');
                this.busy.set(false);
                this.stage.set('idle');
              },
            },
            {
              provider: this.aiProvider.selected(),
              sourceLabel: source.label,
              // What the model is looking at, so "change it" has a subject.
              currentReport: this.definition,
              signal,
            },
          );
        },
        error: () => {
          this.chatError.set('We couldn’t read the module’s context from D365.');
          this.busy.set(false);
          this.stage.set('idle');
        },
      });
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
    this.pendingExport = null;
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
    this.send(last.content);
  }

  /**
   * Refine the report on screen with a canned instruction.
   *
   * It goes through `send` like anything the user types, deliberately: a refine
   * button that took a private path would be a second way to change the report
   * and could drift from what typing the same sentence does.
   */
  refine(instruction: string): void {
    if (!this.hasReport()) return;
    this.send(instruction);
  }

  // ── Composing the report ─────────────────────────────────────────────────

  /**
   * Turn the model's definition into a real report.
   *
   * The definition may add its own filters, which narrows the slice further.
   * Narrowing can only shrink it, so the count gate has already passed — but the
   * figures must come from a cube covering *exactly* that narrowed filter, so we
   * re-count, fetch the detail page, and fold if we have not already.
   */
  private buildReport(raw: unknown): void {
    const source = this.activeSource();

    // Validate BEFORE anything else. Everything upstream is model output;
    // everything downstream is app behaviour, and this is the seam.
    const { definition, issues, needsTotals } = validateDefinition(raw, source);
    if (!definition) {
      this.chatError.set(
        issues[0] ?? 'The AI returned a report we could not read. Ask again, or rephrase.',
      );
      this.stage.set('idle');
      return;
    }

    // Kept so the next turn can be told what is on screen.
    this.definition = definition;

    const base = this.data.buildFilter(source, this.filter());
    const compiled = this.compiler.compile(definition.filters, source.fields);
    const effective = and(base, compiled.filter) ?? base;
    const collected = [
      ...issues,
      ...compiled.rejected.map((r) => `${r.reason} (“${r.filter.field}”)`),
    ];

    this.reportFilter = effective;

    // The definition's filters have no `AnalystFilter` representation, so the
    // effective `$filter` is queried directly.
    forkJoin({
      total: this.data.countRaw(source, effective),
      page: this.data.pageRaw(source, effective, 0, TABLE_DISPLAY_LIMIT),
    })
      .pipe(
        switchMap(({ total, page }) => {
          const rows = page.rows;
          const cached = this.cubes.get(effective);

          if (!needsTotals) return of({ total, rows, cube: this.emptyCube(effective, total) });
          if (cached) return of({ total, rows, cube: cached });

          if (total > MAX_ANALYZE_ROWS) {
            // Cannot total this. Render what IS exact — the count and the detail
            // rows — and say plainly why the sums are missing, rather than
            // inventing them.
            collected.push(
              `Sums, averages, charts and rankings need all ${total.toLocaleString()} matching rows ` +
                `to be totalled, which is over the ${MAX_ANALYZE_ROWS.toLocaleString()}-row limit. ` +
                `Narrow the filter (date range, or a search term) and ask again.`,
            );
            return of({ total, rows, cube: this.emptyCube(effective, total) });
          }

          this.folding.set(true);
          this.foldLoaded.set(0);
          // Fold over the EXACT effective filter (user slice + the definition's
          // own clauses). Only the final emission carries a cube; the rest move
          // the progress bar.
          return this.data.foldRaw(source, effective, total).pipe(
            tap((p) => this.foldLoaded.set(p.loaded)),
            rxFilter((p): p is typeof p & { cube: Cube } => !!p.cube),
            map(({ cube }) => {
              this.cubes.set(effective, cube);
              this.folding.set(false);
              return { total, rows, cube };
            }),
          );
        }),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe({
        next: ({ total, rows, cube }) => {
          this.report.set(
            this.composer.composeValidated(
              definition,
              { source, cube, total, tableRows: rows, issues: collected },
              [],
            ),
          );
          this.stage.set('idle');
        },
        error: (e: unknown) => {
          this.folding.set(false);
          this.stage.set('idle');
          this.chatError.set(
            e instanceof SliceTooLargeError
              ? e.message
              : 'We couldn’t compute that report against D365.',
          );
        },
      });
  }

  /** A cube with no totals — for a report that needs none, or could not have them. */
  private emptyCube(filter: string, total: number): Cube {
    return { filter, builtAt: Date.now(), rowsFolded: 0, totalRows: total, totals: {}, dims: {} };
  }

  // ── Export ───────────────────────────────────────────────────────────────

  /**
   * Reachable two ways by design: these back the toolbar buttons, and the model
   * calls the same path when the user asks in chat ("export this as a PDF").
   */
  async runExport(format: ExportFormat): Promise<void> {
    const report = this.report();
    if (!report) return;

    try {
      await this.exporter.export(format, report, this.activeSource(), this.currentFilter());
    } catch {
      this.chatError.set('The export failed. Please try again.');
    }
  }

  /** Every matching row, streamed to CSV — not the rendered page of 100. */
  exportFullDetail(): void {
    const report = this.report();
    if (!report) return;

    this.exporting.set(true);
    this.exportWritten.set(0);

    void this.exporter
      .exportFullDetail(report, this.activeSource(), this.currentFilter(), (written) =>
        this.exportWritten.set(written),
      )
      .catch((e: unknown) =>
        // ExportTooLargeError carries a helpful "narrow it" message; surface it
        // verbatim rather than the generic failure text.
        this.chatError.set(
          e instanceof ExportTooLargeError
            ? e.message
            : 'The export failed part-way through. Please try again.',
        ),
      )
      .finally(() => this.exporting.set(false));
  }

  /** The report as plain text, for the clipboard. */
  copyText(): string {
    const report = this.report();
    if (!report) return '';

    const lines: string[] = [report.title];
    if (report.subtitle) lines.push(report.subtitle);
    if (report.summary) lines.push('', report.summary);

    for (const block of report.blocks) {
      switch (block.kind) {
        case 'metrics':
          lines.push('', ...block.items.map((m) => `${m.label}: ${m.value}`));
          break;
        case 'ranking':
          lines.push('', block.title);
          lines.push(...block.rows.map((r) => `${r.rank}. ${r.label} — ${r.display} (${r.sharePct}%)`));
          break;
        case 'timeline':
          lines.push('', block.title);
          lines.push(
            ...block.points.map(
              (p) => `${p.label}: ${p.display}${p.changePercent === null ? '' : ` (${p.changePercent > 0 ? '+' : ''}${p.changePercent}%)`}`,
            ),
          );
          break;
        case 'comparison':
          lines.push('', block.title ?? `${block.currentLabel} vs ${block.previousLabel}`);
          lines.push(
            ...block.items.map(
              (i) => `${i.label}: ${i.current} vs ${i.previous} (${i.delta})`,
            ),
          );
          break;
        case 'chart':
          lines.push('', block.title);
          lines.push(...block.chart.data.map((d) => `${d.label}: ${d.value.toLocaleString()}`));
          break;
        case 'text':
          lines.push('', block.body);
          break;
        case 'insights':
          lines.push('', block.title ?? 'What this shows');
          lines.push(
            ...block.points.map(
              (p) => `- [${p.kind === 'interpretation' ? 'Interpretation' : 'Observed'}] ${p.text}`,
            ),
          );
          break;
        case 'recommendations':
          lines.push('', block.title ?? 'Recommended actions');
          lines.push(...block.points.map((p) => `- ${p.text}`));
          break;
        case 'table':
          lines.push('', `${block.title ?? 'Detail'}: ${block.table.total.toLocaleString()} rows`);
          break;
      }
    }

    lines.push('', `${report.rowCount.toLocaleString()} rows · every figure computed from Dynamics 365`);
    return lines.join('\n');
  }

  private currentFilter(): string {
    return this.reportFilter ?? this.data.buildFilter(this.activeSource(), this.filter());
  }
}
