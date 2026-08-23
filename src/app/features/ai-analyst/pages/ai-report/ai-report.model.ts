import { Injectable, DestroyRef, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { filter, forkJoin, map, of, switchMap, tap } from 'rxjs';
import { environment } from '../../../../../environments/environment';
import { Cube, MAX_ANALYZE_ROWS } from '../../../../core/aggregation/aggregate-plan.model';
import { SliceTooLargeError } from '../../../../core/aggregation/aggregation.service';
import { and, SearchField } from '../../../../core/http/odata-filter.util';
import {
  SALES_LINE_SELECT_FIELDS,
  SALES_SELECT_FIELDS,
} from '../../../sales-order/models/sales-order.model';
import {
  SHATAT_SEARCH_FIELDS,
  SHATAT_SERIAL_TRANS_SELECT,
} from '../../../shatat/models/shatat-serial-trans.model';
import { AnalystDataService } from '../../services/analyst-data.service';
import { ChatApiService } from '../../services/chat-api.service';
import { DataContextService } from '../../services/data-context.service';
import { BrandingService } from '../../../../core/branding/branding.service';
import { DocumentContext, ExportService, ExportTooLargeError } from '../../services/export.service';
import { ReportEngineService, TABLE_DISPLAY_LIMIT } from '../../services/report-engine.service';
import { SpecCompilerService } from '../../services/spec-compiler.service';
import { AnalystFilter, AnalystSource } from '../../models/analyst-source.model';
import { Analysis, DocumentFormat } from '../../models/analysis.model';
import { ChatMessage } from '../../models/chat-message.model';
import { DEFAULT_DESIGN, ReportResult, ReportSpec } from '../../models/report-spec.model';
import { SALES_ORDER_DATE_FIELD, SALES_ORDER_FIELDS } from '../../sales-order-fields';
import { SHATAT_DATE_FIELD, SHATAT_SERIAL_TRANS_FIELDS } from '../../shatat-serial-trans-fields';
import {
  PURCHASE_ORDER_DATE_FIELD,
  PURCHASE_ORDER_FIELDS,
  PURCHASE_ORDER_SEARCH_FIELDS,
  PURCHASE_ORDER_SELECT,
} from '../../purchase-order-fields';

/**
 * ViewModel for the AI Analyst page.
 *
 * ## Why this looks different from a normal list ViewModel
 *
 * It used to `load()` the whole dataset into a signal and aggregate it in memory.
 * That is not possible here: `Sha_SerialTrans` has **~11,000,000 rows**, and D365
 * caps any response at 10,000. The old code therefore analysed a truncated slice
 * and presented the result as the complete picture.
 *
 * D365 F&O OData has no `$apply` / `groupby` / `SUM` — and does not even reject
 * `$apply`, it silently ignores it — so totals can only be got by reading rows.
 * The design that falls out of those two facts:
 *
 * 1. **Count first.** `$count` is exact, costs zero rows, and runs in ~2 s at 11M.
 *    The UI always shows how many rows the current filter matches.
 * 2. **Gate on the count.** Under {@link MAX_ANALYZE_ROWS} we fold the slice in a
 *    Worker (~30 s for 250k). Over it, we say so and ask the user to narrow —
 *    rather than starting a 20-minute crawl behind a spinner, or quietly
 *    analysing the first 5,000 rows.
 * 3. **Counts, dates and tables never need the fold** — they are native OData and
 *    stay instant at full 11M scale.
 */
/** D365 rejects a bare string on an enum — the literal has to be type-qualified. */
const BACKORDER = "Microsoft.Dynamics.DataEntities.SalesStatus'Backorder'";

/**
 * The Sales Order tab's query descriptor, derived from `environment.salesOrder`.
 *
 * A source is either **composite** (Growpath's `GP_SalesHeaderAndLineData`, which
 * carries the header columns as `SalesTable_*`) or **split** (Shatat, where those
 * columns live on a separate entity). The analyst issues single-entity queries and
 * cannot join, so on a split source it sees the LINE half only — and the
 * `SalesTable_*` fields are withheld from the schema rather than advertised and
 * then 400'd by D365. `SalesOrderService` still joins them for the report screens;
 * this narrowing applies to the chat tab alone.
 */
const SALES_ORDER_SOURCE = (() => {
  const cfg = environment.salesOrder;
  const company = `dataAreaId eq '${cfg.company}'`;
  const composite = !cfg.headerEntity;

  if (composite) {
    return {
      entity: cfg.lineEntity,
      fields: SALES_ORDER_FIELDS,
      select: SALES_SELECT_FIELDS,
      dateField: SALES_ORDER_DATE_FIELD,
      baseFilter:
        `${company} and RemainInventPhysical gt 0 ` +
        `and SalesTable_SalesStatus eq ${BACKORDER} and SalesStatus eq ${BACKORDER}`,
      searchFields: [
        { field: 'SalesId', mode: 'prefix' },
        { field: 'ItemId', mode: 'prefix' },
        { field: 'CustAccount', mode: 'prefix' },
        { field: 'SalesTable_SalesName', mode: 'contains' },
      ] as SearchField[],
    };
  }

  return {
    entity: cfg.lineEntity,
    fields: SALES_ORDER_FIELDS.filter((f) => !f.key.startsWith('SalesTable_')),
    select: SALES_LINE_SELECT_FIELDS,
    // The composite's delivery date is a header column; the line's own requested
    // ship date is the nearest equivalent the split source can window on.
    dateField: 'ShippingDateRequested',
    baseFilter: `${company} and RemainInventPhysical gt 0 and SalesStatus eq ${BACKORDER}`,
    searchFields: [
      { field: 'SalesId', mode: 'prefix' },
      { field: 'ItemId', mode: 'prefix' },
      { field: 'CustAccount', mode: 'prefix' },
      { field: 'Name', mode: 'contains' },
    ] as SearchField[],
  };
})();

@Injectable()
export class AiReportModel {
  private readonly data = inject(AnalystDataService);
  private readonly context = inject(DataContextService);
  private readonly engine = inject(ReportEngineService);
  private readonly compiler = inject(SpecCompilerService);
  private readonly chat = inject(ChatApiService);
  private readonly exporter = inject(ExportService);
  private readonly branding = inject(BrandingService);
  private readonly destroyRef = inject(DestroyRef);

  readonly sources: AnalystSource[] = [
    {
      id: 'sales-order',
      label: 'Sales Order',
      description: 'Open backorder lines with remaining physical inventory',
      fields: SALES_ORDER_SOURCE.fields,
      suggestions: [
        'Summarise the open backorders',
        'Show units remaining by customer',
        'Break down lines by currency as a donut',
        'Which items have the most backorder quantity?',
      ],
      entity: SALES_ORDER_SOURCE.entity,
      dataPath: environment.salesOrder.source.dataPath,
      authConfig: environment.salesOrder.source.auth,
      crossCompany: environment.salesOrder.source.crossCompany,
      baseFilter: SALES_ORDER_SOURCE.baseFilter,
      keyField: ['SalesId', 'LineNum'],
      select: SALES_ORDER_SOURCE.select,
      searchFields: SALES_ORDER_SOURCE.searchFields,
      dateField: SALES_ORDER_SOURCE.dateField,
      currencyField: 'CurrencyCode',
    },
    {
      id: 'transaction',
      label: 'Transaction',
      description: 'Serial number transactions by site, warehouse and item',
      fields: SHATAT_SERIAL_TRANS_FIELDS,
      suggestions: [
        'Total quantity and amount by transaction type',
        'Show amount by item as a bar chart',
        'Which sites have the most transactions?',
        'Break down transactions by warehouse',
      ],
      entity: 'Sha_SerialTrans',
      dataPath: environment.shatat.dataPath,
      authConfig: environment.shatat.auth,
      crossCompany: true,
      baseFilter: `dataAreaId eq '${environment.shatat.company}'`,
      keyField: ['SerialTransRecId'],
      select: SHATAT_SERIAL_TRANS_SELECT,
      searchFields: SHATAT_SEARCH_FIELDS,
      dateField: SHATAT_DATE_FIELD,
      // Shatat has no currency column. The old engine hardcoded `CurrencyCode`
      // and so scanned the whole dataset to find nothing.
      currencyField: undefined,
    },
    {
      id: 'purchase-order',
      label: 'Purchase Order',
      description: 'Purchase order headers by vendor, status, site and terms',
      fields: PURCHASE_ORDER_FIELDS,
      // A header entity has no amounts, so every suggestion here counts orders
      // rather than totalling them — see purchase-order-fields.ts.
      suggestions: [
        'How many purchase orders per vendor?',
        'Break down orders by status as a donut',
        'Which receiving sites have the most orders?',
        'Count orders by currency and approval status',
      ],
      entity: 'PurchaseOrderHeadersV2',
      dataPath: environment.shatat.dataPath,
      authConfig: environment.shatat.auth,
      crossCompany: true,
      baseFilter: `dataAreaId eq '${environment.shatat.company}'`,
      keyField: ['PurchaseOrderNumber'],
      select: PURCHASE_ORDER_SELECT,
      searchFields: PURCHASE_ORDER_SEARCH_FIELDS,
      dateField: PURCHASE_ORDER_DATE_FIELD,
      currencyField: 'CurrencyCode',
    },
  ];

  private readonly _activeId = signal(this.sources[0].id);
  readonly activeId = this._activeId.asReadonly();
  readonly activeSource = computed(
    () => this.sources.find((s) => s.id === this._activeId()) ?? this.sources[0],
  );

  // ── The user's slice ─────────────────────────────────────────────────────
  readonly filter = signal<AnalystFilter>({});
  readonly rowCount = signal<number | null>(null);
  readonly counting = signal(false);
  readonly dataError = signal<string | null>(null);

  // ── The fold ─────────────────────────────────────────────────────────────
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

  // ── Chat ─────────────────────────────────────────────────────────────────
  readonly messages = signal<ChatMessage[]>([]);
  readonly streaming = signal('');
  readonly busy = signal(false);
  readonly chatError = signal<string | null>(null);
  readonly result = signal<ReportResult | null>(null);

  /** The written half of the report. Survives a new question; replaced by a new one. */
  readonly analysis = signal<Analysis | null>(null);

  readonly ready = computed(() => this.rowCount() !== null && !this.dataError());
  readonly hasReport = computed(() => this.result() !== null);
  readonly hasAnalysis = computed(() => this.analysis() !== null);
  /** A document needs something to show; a bare heading is not a report. */
  readonly canExportDocument = computed(() => this.hasReport() || this.hasAnalysis());
  readonly suggestions = computed(() => this.activeSource().suggestions);

  private controller?: AbortController;
  private searchDebounce?: ReturnType<typeof setTimeout>;
  /** Set by the `export_document` tool; acted on once the turn completes. */
  private pendingExport: DocumentFormat | null = null;
  /**
   * The spec behind the report currently on screen, sent back with the next
   * question so the model can modify what it built instead of rebuilding it
   * from the memory of its own prose. Cleared when the source changes — a spec
   * written against Sales Order fields means nothing on Purchase Order.
   */
  private lastSpec: ReportSpec | null = null;

  constructor() {
    this.destroyRef.onDestroy(() => {
      this.controller?.abort();
      this.data.cancelFold();
      clearTimeout(this.searchDebounce);
    });
    this.refreshCount();
  }

  /** Switch tab. Everything is per-source, so all of it resets. */
  selectSource(id: string): void {
    if (id === this._activeId()) return;
    this.controller?.abort();
    this.data.cancelFold();
    this.messages.set([]);
    this.streaming.set('');
    this.busy.set(false);
    this.chatError.set(null);
    this.result.set(null);
    this.lastSpec = null;
    this.analysis.set(null);
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
   * A count is cheap but not free (~2 s at 11M rows), and it is a round-trip to
   * D365. Firing one per keystroke would queue a dozen requests for a word.
   */
  setSearch(term: string): void {
    clearTimeout(this.searchDebounce);
    this.searchDebounce = setTimeout(() => this.setFilter({ search: term || undefined }), 350);
  }

  readonly hasFilter = computed(() => {
    const f = this.filter();
    return !!(f.search || f.from || f.to);
  });

  clearFilter(): void {
    clearTimeout(this.searchDebounce);
    this.filter.set({});
    this.cube.set(null);
    this.data.cancelFold();
    this.refreshCount();
  }

  /**
   * How many rows the current filter matches. Zero rows transferred — this is the
   * one real aggregate D365 gives us, and every gate below depends on it.
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
          // A cube we already folded for this exact filter is still valid.
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

  // ── Chat ─────────────────────────────────────────────────────────────────
  send(text: string): void {
    if (this.busy() || !this.ready()) return;

    const source = this.activeSource();
    const filter = this.filter();
    const total = this.rowCount() ?? 0;

    const history = [...this.messages(), { role: 'user', content: text } as ChatMessage];
    this.messages.set(history);
    this.busy.set(true);
    this.streaming.set('');
    this.chatError.set(null);

    this.controller?.abort();
    this.controller = new AbortController();
    const signal = this.controller.signal;

    // Build the LLM's context from server aggregates. The cube may be absent —
    // in which case DataContext says `coverage: 'pending'` and the model is told,
    // explicitly, not to propose sums. We never ship an unlabelled estimate.
    forkJoin({
      sample: this.data.sample(source, filter),
      bounds: this.data.dateBounds(source, filter),
    })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: ({ sample, bounds }) => {
          const dataContext = this.context.build(source, total, sample, bounds, this.cube());

          void this.chat.stream(
            history,
            dataContext,
            {
              onText: (t) => this.streaming.update((s) => s + t),
              onReport: (spec) => this.renderReport(spec as ReportSpec),
              onAnalysis: (a) => this.analysis.set(a),
              // The model asked for a download. Defer to the end of the turn:
              // a report emitted in the same reply is still rendering, and
              // exporting now would ship the previous one.
              onExport: (format) => (this.pendingExport = format),
              onDone: () => {
                const reply = this.streaming().trim() || '📊 Built a report from your data.';
                this.messages.update((m) => [...m, { role: 'assistant', content: reply }]);
                this.streaming.set('');
                this.busy.set(false);

                const format = this.pendingExport;
                this.pendingExport = null;
                if (format) this.exportDocument(format);
              },
              onError: (message) => {
                this.chatError.set(message);
                this.streaming.set('');
                this.busy.set(false);
              },
            },
            signal,
            // What the model is looking at, so "change it" has a subject.
            this.lastSpec,
          );
        },
        error: () => {
          this.chatError.set('We couldn’t read the dataset context from D365.');
          this.busy.set(false);
        },
      });
  }

  /**
   * Turn the LLM's spec into a real report.
   *
   * The spec may add its own filters, which narrows the slice further. Narrowing
   * can only shrink it, so the gate already passed — but the numbers must come
   * from a cube that covers *exactly* that narrowed filter, so we re-count, fetch
   * the table page, and fold if we haven't already.
   */
  private renderReport(spec: ReportSpec): void {
    // Kept so the next turn can be told what is on screen — see ChatApiService.
    this.lastSpec = spec;
    const source = this.activeSource();
    const base = this.data.buildFilter(source, this.filter());
    const { filter: specFilter, rejected } = this.compiler.compile(spec.filters, source.fields);
    const effective = and(base, specFilter) ?? base;
    const omitted = rejected.map((r) => `${r.reason} (“${r.filter.field}”)`);

    // Remember it so an export ships exactly what the report shows, not the
    // user's broader slice.
    this.lastReportFilter = effective;

    const needsCube = this.specNeedsCube(spec);

    // The spec's filters have no AnalystFilter representation, so the effective
    // `$filter` is queried directly.
    forkJoin({
      total: this.data.countRaw(source, effective),
      page: this.data.pageRaw(source, effective, 0, TABLE_DISPLAY_LIMIT),
    })
      .pipe(
        switchMap(({ total, page }) => {
          const rows = page.rows;
          const cached = this.cubes.get(effective);

          if (!needsCube) return of({ total, rows, cube: this.emptyCube(effective, total) });
          if (cached) return of({ total, rows, cube: cached });

          if (total > MAX_ANALYZE_ROWS) {
            // Cannot total this. Render what IS exact — the count and the table —
            // and say plainly why the sums are missing, rather than inventing them.
            omitted.push(
              `Sums, averages and group-bys need all ${total.toLocaleString()} matching rows ` +
                `to be totalled, which is over the ${MAX_ANALYZE_ROWS.toLocaleString()}-row ` +
                `limit. Narrow the filter (date range, site, transaction type) and ask again.`,
            );
            return of({ total, rows, cube: this.emptyCube(effective, total) });
          }

          this.folding.set(true);
          this.foldLoaded.set(0);
          // foldRaw over the EXACT effective filter (user slice + the spec's own
          // clauses), and emit progress so the "Totalling… %" indicator advances.
          // Only the final emission carries a cube; progress emissions move the bar.
          return this.data.foldRaw(source, effective, total).pipe(
            tap((p) => this.foldLoaded.set(p.loaded)),
            filter((p): p is typeof p & { cube: Cube } => !!p.cube),
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
          this.result.set(
            this.engine.compute(spec, { source, cube, total, tableRows: rows, omitted }),
          );
        },
        error: (e: unknown) => {
          this.folding.set(false);
          this.chatError.set(
            e instanceof SliceTooLargeError
              ? e.message
              : 'We couldn’t compute that report against D365.',
          );
        },
      });
  }

  /** Counts alone never need a fold — `$count` is exact and free at any scale. */
  private specNeedsCube(spec: ReportSpec): boolean {
    const kpiNeedsSum = (spec.kpis ?? []).some((k) => k.agg !== 'count');
    const hasCharts = (spec.charts ?? []).length > 0;
    return kpiNeedsSum || hasCharts;
  }

  /** A cube with no totals — used when a report needs none, or couldn't have them. */
  private emptyCube(filter: string, total: number): Cube {
    return { filter, builtAt: Date.now(), rowsFolded: 0, totalRows: total, totals: {}, dims: {} };
  }

  // ── Export ───────────────────────────────────────────────────────────────
  /** KPI summary + the table. Fetches every row when the slice is small enough. */
  exportExcel(): void {
    const r = this.result();
    if (r) void this.exporter.exportExcel(r, this.activeSource(), this.reportFilter());
  }

  /**
   * Every matching row, streamed to CSV. This is the export that used to silently
   * ship 100 rows regardless of how many matched.
   */
  exportFullDetail(): void {
    const r = this.result();
    if (!r) return;

    this.exporting.set(true);
    this.exportWritten.set(0);

    void this.exporter
      .exportFullDetail(r, this.activeSource(), this.reportFilter(), (p) =>
        this.exportWritten.set(p.written),
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

  /**
   * The designed document — narrative analysis, KPIs, charts and the detail page.
   *
   * Reachable two ways by design: these methods back the toolbar buttons, and the
   * model calls the same path when the user asks in chat ("export this as a PDF").
   */
  exportDocument(format: DocumentFormat): void {
    const context = this.documentContext();
    if (!context) return;
    if (format === 'html') this.exporter.exportHtml(context);
    else this.exporter.exportPdf(context);
  }

  exportPdf(): void {
    this.exportDocument('pdf');
  }

  exportHtml(): void {
    this.exportDocument('html');
  }

  /**
   * Assemble what the document needs.
   *
   * A report with no analysis still exports (KPIs, charts, table). An analysis
   * with no report exports too — a written brief is a legitimate document. Only
   * having neither is refused, which `canExportDocument` already gates in the UI.
   */
  private documentContext(): DocumentContext | null {
    const result = this.result();
    const analysis = this.analysis();
    if (!result && !analysis) return null;

    return {
      result: result ?? this.emptyResult(analysis),
      analysis,
      sourceLabel: this.activeSource().label,
      brandName: this.branding.appName(),
    };
  }

  /** A report-shaped shell for an analysis that has no computed report behind it. */
  private emptyResult(analysis: Analysis | null): ReportResult {
    return {
      title: analysis?.headline ?? 'Analysis',
      design: DEFAULT_DESIGN,
      rowCount: this.rowCount() ?? 0,
      kpis: [],
      charts: [],
    };
  }

  // ── Chat controls ────────────────────────────────────────────────────────
  /** Abandon the in-flight reply but keep what has already streamed. */
  stop(): void {
    if (!this.busy()) return;
    this.controller?.abort();
    const partial = this.streaming().trim();
    if (partial) this.messages.update((m) => [...m, { role: 'assistant', content: partial }]);
    this.streaming.set('');
    this.busy.set(false);
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
    const history = [...this.messages()];
    while (history.length && history[history.length - 1].role === 'assistant') history.pop();
    const last = history.pop();
    if (!last) return;
    this.messages.set(history);
    this.send(last.content);
  }

  readonly exporting = signal(false);
  readonly exportWritten = signal(0);

  /**
   * The `$filter` the CURRENT REPORT covers — including any clauses the LLM's spec
   * added. Exporting the user's broader slice instead would hand back a different
   * dataset from the one on screen.
   */
  private reportFilter(): string {
    return this.lastReportFilter ?? this.data.buildFilter(this.activeSource(), this.filter());
  }

  private lastReportFilter?: string;
}
