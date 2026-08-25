import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { ReportChartComponent } from '../report-sections/report-chart/report-chart';
import { ReportComparisonComponent } from '../report-sections/report-comparison/report-comparison';
import { ReportDetailTableComponent } from '../report-sections/report-detail-table/report-detail-table';
import { ReportListComponent } from '../report-sections/report-list/report-list';
import { ReportMetricsComponent } from '../report-sections/report-metrics/report-metrics';
import { ReportNarrativeComponent } from '../report-sections/report-narrative/report-narrative';
import { ReportRankingComponent } from '../report-sections/report-ranking/report-ranking';
import { ChartResult, ReportBlock, ReportResult } from '../../models/report-spec.model';

/**
 * One row of the report as it is laid out.
 *
 * Charts are the exception to "one block, one row": consecutive charts belong
 * side by side, because two breakdowns of the same slice are meant to be
 * compared and stacking them puts the second below the fold. Everything else
 * occupies its own full-width row.
 */
type RenderRow =
  | { kind: 'charts'; charts: ChartResult[] }
  | { kind: 'block'; block: ReportBlock; first: boolean };

/**
 * Renders a computed {@link ReportResult}.
 *
 * ## What changed, and why it matters
 *
 * This component used to draw a FIXED report: a title, then stats, then charts,
 * then a detail table, in that order, every time. The model could only pick how
 * many of each — so "what are my top products?" and "why did sales fall?" came
 * back as the same dashboard with different numbers in it.
 *
 * It now walks `result.blocks` in order and draws whatever kinds the model
 * chose. `@switch` on a discriminated union, not a component registry: the set
 * of renderable blocks must be CLOSED at compile time, because the thing
 * choosing between them is LLM output.
 *
 * The View holds no business logic. Everything it binds — figures, formats,
 * shares, deltas, chart series — was computed by `ReportEngineService` against
 * real D365 data. What lives here is layout: how many columns, what gets a
 * heading, which rows sit together.
 */
@Component({
  selector: 'app-dynamic-report',
  imports: [
    ReportChartComponent,
    ReportComparisonComponent,
    ReportDetailTableComponent,
    ReportListComponent,
    ReportMetricsComponent,
    ReportNarrativeComponent,
    ReportRankingComponent,
  ],
  templateUrl: './dynamic-report.html',
  styleUrl: './dynamic-report.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class DynamicReportComponent {
  readonly result = input.required<ReportResult>();

  /**
   * The look the model asked for. It is part of the spec, so "make it compact"
   * or "use one colour" in chat lands here on the next `emit_report` — the
   * report above the conversation restyles without a settings screen.
   */
  protected readonly design = computed(() => this.result().design);

  protected readonly compact = computed(() => this.design().density === 'compact');

  /**
   * The blocks, with consecutive charts gathered into one grid row.
   *
   * `first` is carried because the opening block of a report reads as its lede
   * and is set one step larger — a report that opens with a sentence should look
   * like it opens with a sentence.
   */
  protected readonly rows = computed<RenderRow[]>(() => {
    const blocks = this.result().blocks ?? [];
    const rows: RenderRow[] = [];

    for (const block of blocks) {
      if (block.kind === 'chart') {
        const last = rows[rows.length - 1];
        if (last?.kind === 'charts') last.charts.push(block.chart);
        else rows.push({ kind: 'charts', charts: [block.chart] });
        continue;
      }
      rows.push({ kind: 'block', block, first: rows.length === 0 });
    }

    return rows;
  });

  protected readonly isEmpty = computed(() => this.rows().length === 0);

  /**
   * Column classes for a run of charts.
   *
   * `@`-prefixed breakpoints measure the SHEET's own width, not the viewport —
   * the sheet sits in a scrolling pane beside a sidebar, so the viewport says
   * nothing useful about how much room a chart actually has.
   */
  protected chartCols(count: number): string {
    const layout = this.design().chartLayout;
    // "Bigger charts" is the usual reason to ask: one per row, full sheet width.
    if (layout === 'stacked') return 'grid-cols-1';
    // "Fit more in": pack two-across as soon as there is any room at all.
    if (layout === 'grid') {
      return count <= 1 ? 'grid-cols-1' : 'grid-cols-1 @xl:grid-cols-2 @5xl:grid-cols-3';
    }
    if (count <= 1) return 'grid-cols-1';
    if (count === 2) return 'grid-cols-1 @3xl:grid-cols-2';
    return 'grid-cols-1 @3xl:grid-cols-2 @6xl:grid-cols-3';
  }

  /**
   * The heading above a block, or empty for one that labels itself.
   *
   * A stat row needs no heading — every stat is captioned. A ranking or a
   * comparison does, because the figures inside it are meaningless without
   * knowing what is being ranked or which periods are being compared.
   */
  protected heading(block: ReportBlock): string {
    switch (block.kind) {
      case 'metrics':
        return block.title ?? '';
      case 'comparison':
        return block.title ?? `${block.currentLabel} vs ${block.previousLabel}`;
      case 'ranking':
        return block.title;
      case 'table':
        return block.title ?? 'Detail';
      case 'text':
        return block.title ?? '';
      case 'list':
        return block.title ?? (block.variant === 'insights' ? 'What this shows' : 'Recommended actions');
      default:
        return '';
    }
  }

  protected note(block: ReportBlock): string {
    return block.kind === 'comparison' || block.kind === 'ranking' ? (block.note ?? '') : '';
  }

  /** The detail table is capped tighter in a compact report. */
  protected readonly tableMaxHeight = computed(() =>
    this.compact() ? 'min(20rem, 34vh)' : 'min(26rem, 42vh)',
  );
}
