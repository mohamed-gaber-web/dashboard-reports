import { Injectable, DestroyRef, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { Observable } from 'rxjs';
import { ODataResponse } from '../../../../core/models/odata.model';
import { SalesOrderService } from '../../../sales-order/services/sales-order.service';
import { ShatatSerialTransService } from '../../../shatat/services/shatat-serial-trans.service';
import { ChatApiService } from '../../services/chat-api.service';
import { DataContextService } from '../../services/data-context.service';
import { ReportEngineService } from '../../services/report-engine.service';
import { ExportService } from '../../services/export.service';
import { ChatMessage } from '../../models/chat-message.model';
import { FieldMeta } from '../../models/field-meta.model';
import { ReportResult, ReportSpec } from '../../models/report-spec.model';
import { SALES_ORDER_FIELDS } from '../../sales-order-fields';
import { SHATAT_SERIAL_TRANS_FIELDS } from '../../shatat-serial-trans-fields';

type Row = Record<string, unknown>;

/** A selectable dataset the AI Analyst can chat against (one per tab). */
export interface AnalystSource {
  id: string;
  label: string;
  fields: FieldMeta[];
  suggestions: string[];
  load: () => Observable<ODataResponse<Row>>;
}

/**
 * ViewModel for the AI Analyst page. Owns the active data source, the dataset,
 * the conversation, the streaming reply, and the currently rendered report.
 * Two tabs (Sales Order / Shatat) swap the source; everything below — context,
 * engine, chat — is source-agnostic. The view only binds.
 */
@Injectable()
export class AiReportModel {
  private readonly sales = inject(SalesOrderService);
  private readonly shatat = inject(ShatatSerialTransService);
  private readonly context = inject(DataContextService);
  private readonly engine = inject(ReportEngineService);
  private readonly chat = inject(ChatApiService);
  private readonly exporter = inject(ExportService);
  private readonly destroyRef = inject(DestroyRef);

  /** The two data sources exposed as tabs. */
  readonly sources: AnalystSource[] = [
    {
      id: 'sales-order',
      label: 'Sales Order',
      fields: SALES_ORDER_FIELDS,
      suggestions: [
        'Summarise the open backorders',
        'Show units remaining by customer',
        'Break down lines by currency as a donut',
        'Which items have the most backorder quantity?',
      ],
      load: () =>
        this.sales.getBackorders() as unknown as Observable<ODataResponse<Row>>,
    },
    {
      id: 'shatat',
      label: 'Shatat',
      fields: SHATAT_SERIAL_TRANS_FIELDS,
      suggestions: [
        'Summarise the serial transactions',
        'Total quantity and amount by transaction type',
        'Show amount by item as a bar chart',
        'Which sites have the most transactions?',
      ],
      load: () =>
        this.shatat.getSerialTrans() as unknown as Observable<ODataResponse<Row>>,
    },
  ];

  private readonly _activeId = signal(this.sources[0].id);
  readonly activeId = this._activeId.asReadonly();
  readonly activeSource = computed(
    () => this.sources.find((s) => s.id === this._activeId()) ?? this.sources[0],
  );

  private readonly _records = signal<Row[]>([]);
  private controller?: AbortController;

  readonly dataLoading = signal(true);
  readonly dataError = signal<string | null>(null);

  readonly messages = signal<ChatMessage[]>([]);
  readonly streaming = signal('');
  readonly busy = signal(false);
  readonly chatError = signal<string | null>(null);
  readonly result = signal<ReportResult | null>(null);

  readonly ready = computed(() => !this.dataLoading() && !this.dataError());
  readonly hasReport = computed(() => this.result() !== null);

  readonly suggestions = computed(() => this.activeSource().suggestions);

  constructor() {
    this.destroyRef.onDestroy(() => this.controller?.abort());
    this.load();
  }

  /** Switch the active data source (tab) and reload from scratch. */
  selectSource(id: string): void {
    if (id === this._activeId()) return;
    this.controller?.abort();
    this.messages.set([]);
    this.streaming.set('');
    this.busy.set(false);
    this.chatError.set(null);
    this.result.set(null);
    this._records.set([]);
    this._activeId.set(id);
    this.load();
  }

  load(): void {
    this.dataLoading.set(true);
    this.dataError.set(null);
    this.activeSource()
      .load()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (response) => {
          this._records.set(response.value ?? []);
          this.dataLoading.set(false);
        },
        error: () => {
          this.dataError.set('We couldn’t load the dataset from D365. Please try again.');
          this.dataLoading.set(false);
        },
      });
  }

  send(text: string): void {
    if (this.busy() || !this.ready()) return;

    const history = [...this.messages(), { role: 'user', content: text } as ChatMessage];
    this.messages.set(history);
    this.busy.set(true);
    this.streaming.set('');
    this.chatError.set(null);

    const rows = this._records();
    const fields = this.activeSource().fields;
    const dataContext = this.context.build(rows, fields);

    this.controller?.abort();
    this.controller = new AbortController();

    void this.chat.stream(
      history,
      dataContext,
      {
        onText: (t) => this.streaming.update((s) => s + t),
        onReport: (spec) => {
          try {
            this.result.set(this.engine.compute(spec as ReportSpec, rows, fields));
          } catch {
            // Malformed spec — ignore; the narration still lands.
          }
        },
        onDone: () => {
          const reply = this.streaming().trim() || '📊 Built a report from your data.';
          this.messages.update((m) => [...m, { role: 'assistant', content: reply }]);
          this.streaming.set('');
          this.busy.set(false);
        },
        onError: (message) => {
          this.chatError.set(message);
          this.streaming.set('');
          this.busy.set(false);
        },
      },
      this.controller.signal,
    );
  }

  exportExcel(): void {
    const r = this.result();
    if (r) this.exporter.exportExcel(r);
  }

  exportPdf(): void {
    const r = this.result();
    if (r) this.exporter.exportPdf(r);
  }
}
