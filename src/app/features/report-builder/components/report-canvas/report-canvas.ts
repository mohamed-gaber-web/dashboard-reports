import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { RbChartComponent } from '../sections/rb-chart/rb-chart';
import { RbComparisonComponent } from '../sections/rb-comparison/rb-comparison';
import { RbInsightsComponent } from '../sections/rb-insights/rb-insights';
import { RbMetricsComponent } from '../sections/rb-metrics/rb-metrics';
import { RbNarrativeComponent } from '../sections/rb-narrative/rb-narrative';
import { RbRankingComponent } from '../sections/rb-ranking/rb-ranking';
import { RbRecommendationsComponent } from '../sections/rb-recommendations/rb-recommendations';
import { RbTableComponent } from '../sections/rb-table/rb-table';
import { RbTimelineComponent } from '../sections/rb-timeline/rb-timeline';
import { ComposedReport, ReportBlock } from '../../models/report-definition.model';

/** A chart block, kept with the heading the sheet would otherwise draw for it. */
interface ChartEntry {
  title: string;
  note?: string;
  chart: Extract<ReportBlock, { kind: 'chart' }>['chart'];
}

/**
 * One row of the report as it is laid out.
 *
 * Charts are the exception to "one block, one row": consecutive charts belong
 * side by side, because two breakdowns of the same slice are meant to be
 * compared and stacking them puts the second below the fold. Everything else
 * takes its own full-width row.
 */
type RenderRow =
  | { kind: 'charts'; charts: ChartEntry[] }
  | { kind: 'block'; block: ReportBlock; first: boolean };

/**
 * Renders a {@link ComposedReport}.
 *
 * It walks `blocks` in order and draws whatever kinds the model chose —
 * `@switch` on a discriminated union, not a component registry. The renderable
 * set must be CLOSED at compile time, because the thing choosing between the
 * branches is LLM output and an open registry would let an invented string
 * select a component.
 *
 * **No business logic lives here.** Every figure, format, share, delta and
 * series was computed by `ReportComposerService` against real D365 rows. What
 * this component owns is layout: how many columns, what gets a heading, which
 * rows sit together.
 *
 * ## Density and layout
 *
 * Both arrive on the definition and land as `data-` attributes plus a set of
 * `--rb-*` custom properties on the sheet. Custom properties specifically:
 * Angular's emulated encapsulation rewrites every selector to require the
 * component's own attribute, so a parent class cannot reach into a child — an
 * inherited variable is the only channel, and it keeps "what minimal means"
 * defined in exactly one place instead of threaded through nine components as a
 * boolean.
 */
@Component({
  selector: 'app-report-canvas',
  imports: [
    RbChartComponent,
    RbComparisonComponent,
    RbInsightsComponent,
    RbMetricsComponent,
    RbNarrativeComponent,
    RbRankingComponent,
    RbRecommendationsComponent,
    RbTableComponent,
    RbTimelineComponent,
  ],
  templateUrl: './report-canvas.html',
  styleUrl: './report-canvas.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ReportCanvasComponent {
  readonly report = input.required<ComposedReport>();

  protected readonly density = computed(() => this.report().density);
  protected readonly layout = computed(() => this.report().layout);

  /**
   * The blocks, with consecutive charts gathered into one grid row.
   *
   * `first` is carried because the opening block reads as the report's lede and
   * is set one step larger — a report that opens with a sentence should look
   * like it opens with a sentence.
   */
  protected readonly rows = computed<RenderRow[]>(() => {
    const rows: RenderRow[] = [];

    for (const block of this.report().blocks) {
      if (block.kind === 'chart') {
        const entry: ChartEntry = { title: block.title, note: block.note, chart: block.chart };
        const last = rows[rows.length - 1];
        if (last?.kind === 'charts') last.charts.push(entry);
        else rows.push({ kind: 'charts', charts: [entry] });
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
    // An executive report is read, not studied: one chart per row, full width.
    if (this.layout() === 'executive') return 'grid-cols-1';
    // Operational packs — the charts are context for the rows below them.
    if (this.layout() === 'operational') {
      return count <= 1 ? 'grid-cols-1' : 'grid-cols-1 @xl:grid-cols-2 @5xl:grid-cols-3';
    }
    if (count <= 1) return 'grid-cols-1';
    if (count === 2) return 'grid-cols-1 @3xl:grid-cols-2';
    return 'grid-cols-1 @3xl:grid-cols-2 @6xl:grid-cols-3';
  }

  /**
   * The heading above a block, or empty for one that labels itself.
   *
   * A stat row needs no heading — every stat is captioned. A ranking, a timeline
   * or a comparison does, because the figures inside are meaningless without
   * knowing what is being ranked or which periods are being compared.
   */
  protected heading(block: ReportBlock): string {
    switch (block.kind) {
      case 'metrics':
        return block.title ?? '';
      case 'table':
        return block.title ?? 'Detail';
      case 'ranking':
      case 'timeline':
        return block.title;
      case 'comparison':
        return block.title ?? `${block.currentLabel} vs ${block.previousLabel}`;
      case 'text':
        return block.title ?? '';
      case 'insights':
        return block.title ?? 'What this shows';
      case 'recommendations':
        return block.title ?? 'Recommended actions';
      default:
        return '';
    }
  }

  protected note(block: ReportBlock): string {
    switch (block.kind) {
      case 'metrics':
      case 'table':
      case 'ranking':
      case 'timeline':
      case 'comparison':
        return block.note ?? '';
      default:
        return '';
    }
  }

  /** The detail table is capped tighter in a minimal report. */
  protected readonly tableMaxHeight = computed(() =>
    this.density() === 'minimal' ? 'min(20rem, 34vh)' : 'min(26rem, 42vh)',
  );
}
