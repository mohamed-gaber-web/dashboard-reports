import { Injectable, DestroyRef, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { SalesOrderService } from '../../../sales-order/services/sales-order.service';
import { SalesBackorderRecord } from '../../../sales-order/models/sales-order.model';
import { ChatApiService } from '../../services/chat-api.service';
import { DataContextService } from '../../services/data-context.service';
import { ReportEngineService } from '../../services/report-engine.service';
import { ExportService } from '../../services/export.service';
import { ChatMessage } from '../../models/chat-message.model';
import { ReportResult, ReportSpec } from '../../models/report-spec.model';
import { SALES_ORDER_FIELDS } from '../../sales-order-fields';

type Row = Record<string, unknown>;

/**
 * ViewModel for the AI Analyst page. Owns the dataset, the conversation, the
 * streaming reply, and the currently rendered report. The view only binds.
 */
@Injectable()
export class AiReportModel {
  private readonly sales = inject(SalesOrderService);
  private readonly context = inject(DataContextService);
  private readonly engine = inject(ReportEngineService);
  private readonly chat = inject(ChatApiService);
  private readonly exporter = inject(ExportService);
  private readonly destroyRef = inject(DestroyRef);

  private readonly fields = SALES_ORDER_FIELDS;
  private readonly _records = signal<SalesBackorderRecord[]>([]);
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

  readonly suggestions = [
    'Summarise the open backorders',
    'Show units remaining by customer',
    'Break down lines by currency as a donut',
    'Which items have the most backorder quantity?',
  ];

  constructor() {
    this.destroyRef.onDestroy(() => this.controller?.abort());
    this.load();
  }

  load(): void {
    this.dataLoading.set(true);
    this.dataError.set(null);
    this.sales
      .getBackorders()
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

    const rows = this._records() as unknown as Row[];
    const dataContext = this.context.build(rows, this.fields);

    this.controller?.abort();
    this.controller = new AbortController();

    void this.chat.stream(
      history,
      dataContext,
      {
        onText: (t) => this.streaming.update((s) => s + t),
        onReport: (spec) => {
          try {
            this.result.set(this.engine.compute(spec as ReportSpec, rows, this.fields));
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
