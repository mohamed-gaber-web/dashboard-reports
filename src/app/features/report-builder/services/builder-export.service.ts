import { Injectable, inject } from '@angular/core';
import { BrandingService } from '../../../core/branding/branding.service';
import { Analysis } from '../../ai-analyst/models/analysis.model';
import { AnalystSource } from '../../ai-analyst/models/analyst-source.model';
import {
  ChartResult,
  ReportBlock as SpecBlock,
  ReportChartType,
  ReportResult,
  ResolvedDesign,
} from '../../ai-analyst/models/report-spec.model';
import { DocumentContext, ExportService } from '../../ai-analyst/services/export.service';
import { ExportFormat } from '../models/conversation.model';
import { ComposedReport, ComputedChart, ReportBlock } from '../models/report-definition.model';

/**
 * Exports a {@link ComposedReport} to HTML, PDF or Excel.
 *
 * ## Why this is an adapter and not an exporter
 *
 * §22 of the brief: the report definition is the SINGLE source of truth for every
 * export, and there must be no per-format AI logic. There is already a document
 * pipeline in this codebase that satisfies that — `document-builder.ts` renders
 * one self-contained HTML string (inlined CSS, charts as literal SVG, palette
 * resolved to hex because a `var()` would not exist in a detached file), and the
 * PDF is that same string sent to `window.print()`, so the two formats cannot
 * drift. `ExportService` wraps it and also owns the Excel workbook and the paged
 * full-detail CSV, including the row caps that keep a multi-million-row export
 * from freezing the tab.
 *
 * Writing a second copy of all that for a second report screen would be two
 * document renderers to keep in step, and the second one is the one that ends up
 * missing the fix. So this maps the builder's blocks onto the shape that
 * pipeline already renders, and the mapping is small enough to read in one go.
 *
 * ## What the mapping costs
 *
 * Three block kinds have no exact counterpart, and each is converted to the
 * nearest honest thing rather than dropped:
 *
 * - `pie` → `donut`. Same figures, same slices, one less ring.
 * - `timeline` → an ordered COLUMN chart. It is literally the same buckets; what
 *   the document loses is the per-step change beside each period, which is a
 *   presentation, not a figure.
 * - insight/recommendation claim tags → a text prefix ("Interpretation: …",
 *   "High priority: …"). The distinction survives in words when it cannot
 *   survive in styling.
 *
 * Nothing is silently lost, and no figure is recomputed on the way out.
 */
@Injectable({ providedIn: 'root' })
export class BuilderExportService {
  private readonly exporter = inject(ExportService);
  private readonly branding = inject(BrandingService);

  /**
   * @param filter the `$filter` the report actually covers — the user's slice
   *   plus any clause the definition added. Exporting the broader slice would
   *   hand back a different dataset from the one on screen.
   */
  async export(
    format: ExportFormat,
    report: ComposedReport,
    source: AnalystSource,
    filter: string,
  ): Promise<void> {
    const result = this.toReportResult(report);

    if (format === 'excel') {
      await this.exporter.exportExcel(result, source, filter);
      return;
    }

    const context: DocumentContext = {
      result,
      analysis: this.toAnalysis(report),
      sourceLabel: source.label,
      brandName: this.branding.appName(),
    };

    if (format === 'html') this.exporter.exportHtml(context);
    else this.exporter.exportPdf(context);
  }

  /** Every matching row as CSV — not the rendered page of 100. */
  exportFullDetail(
    report: ComposedReport,
    source: AnalystSource,
    filter: string,
    onProgress?: (written: number) => void,
  ): Promise<void> {
    return this.exporter.exportFullDetail(
      this.toReportResult(report),
      source,
      filter,
      (p) => onProgress?.(p.written),
    );
  }

  // ── Mapping ──────────────────────────────────────────────────────────────

  /**
   * The builder's report, in the shape the document pipeline renders.
   *
   * `kpis` / `charts` / `table` are flattened projections of `blocks`, derived
   * here rather than computed independently — the Excel summary sheet reads them
   * and must not be able to disagree with the page.
   */
  private toReportResult(report: ComposedReport): ReportResult {
    const blocks = report.blocks.map((b) => this.toSpecBlock(b));

    return {
      title: report.title,
      description: report.subtitle,
      design: this.toDesign(report),
      rowCount: report.rowCount,
      blocks,
      kpis: blocks.flatMap((b) => (b.kind === 'metrics' ? b.items : [])),
      charts: blocks.flatMap((b) => (b.kind === 'chart' ? [b.chart] : [])),
      table: blocks.find((b) => b.kind === 'table')?.table,
      omitted: report.issues.length ? report.issues : undefined,
    };
  }

  /**
   * The builder's density/layout vocabulary expressed in the document's.
   *
   * They are not the same vocabulary and are not meant to be: `minimal` is "say
   * less", `compact` is "use less space". A minimal report does want the tighter
   * document, so they line up here even though they do not mean the same thing.
   */
  private toDesign(report: ComposedReport): ResolvedDesign {
    return {
      density: report.density === 'minimal' ? 'compact' : 'comfortable',
      palette: 'categorical',
      chartLayout:
        report.layout === 'executive' ? 'stacked' : report.layout === 'operational' ? 'grid' : 'auto',
    };
  }

  private toSpecBlock(block: ReportBlock): SpecBlock {
    switch (block.kind) {
      case 'metrics':
        return { kind: 'metrics', title: block.title, items: block.items };

      case 'chart':
        return { kind: 'chart', chart: this.toChartResult(block.chart, block.title, block.note) };

      case 'table':
        return { kind: 'table', title: block.title, table: block.table };

      case 'ranking':
        return {
          kind: 'ranking',
          title: block.title,
          note: block.note,
          rows: block.rows,
          chart: block.showBars,
          measureLabel: block.measureLabel,
        };

      case 'comparison':
        return {
          kind: 'comparison',
          title: block.title,
          note: block.note,
          currentLabel: block.currentLabel,
          previousLabel: block.previousLabel,
          items: block.items,
        };

      case 'timeline':
        // The same buckets, drawn as an ordered column chart. The per-step change
        // is a reading aid on screen, not a figure the document would otherwise
        // be missing.
        return {
          kind: 'chart',
          chart: {
            type: 'column',
            title: block.title,
            // The screen lists newest first; an axis has to read oldest → newest.
            data: [...block.points].reverse().map((p) => ({ label: p.label, value: p.value })),
            labels: [...block.points].reverse().map((p) => p.label),
            series: [
              { label: block.measureLabel, values: [...block.points].reverse().map((p) => p.value) },
            ],
            ordered: true,
            note: block.note,
          },
        };

      case 'text':
        return { kind: 'text', title: block.title, body: block.body };

      case 'insights':
        return {
          kind: 'list',
          variant: 'insights',
          title: block.title,
          items: block.points.map((p) =>
            p.kind === 'interpretation' ? `Interpretation: ${p.text}` : p.text,
          ),
        };

      case 'recommendations':
        return {
          kind: 'list',
          variant: 'recommendations',
          title: block.title,
          items: block.points.map((p) => {
            const priority = p.priority ? `${capitalise(p.priority)} priority: ` : '';
            const because = p.rationale ? ` (${p.rationale})` : '';
            return `${priority}${p.text}${because}`;
          }),
        };
    }
  }

  private toChartResult(chart: ComputedChart, title: string, note: string | undefined): ChartResult {
    // `pie` is the one mark the document renderer has no case for; a donut is the
    // same figures with a hole in the middle.
    const type: ReportChartType = chart.kind === 'pie' ? 'donut' : chart.kind;
    return {
      type,
      title,
      data: chart.data,
      labels: chart.labels,
      series: chart.series,
      ordered: chart.ordered,
      note: [note, chart.note].filter(Boolean).join(' · ') || undefined,
      format: chart.format,
    };
  }

  /**
   * The written brief that opens an exported document.
   *
   * The AI Analyst gets this from a separate `write_analysis` tool call; the
   * builder has it already, because `summary` and the insight/recommendation
   * sections are part of the definition. That is the point of putting them
   * there — one contract, and the document cannot disagree with the screen.
   *
   * Null when there is no prose at all: a bare KPI page is a legitimate export,
   * and inventing a summary for it would be the one thing this feature must
   * never do.
   */
  private toAnalysis(report: ComposedReport): Analysis | null {
    const insights = report.blocks.flatMap((b) => (b.kind === 'insights' ? b.points : []));
    const actions = report.blocks.flatMap((b) => (b.kind === 'recommendations' ? b.points : []));
    if (!report.summary && !insights.length && !actions.length) return null;

    return {
      headline: report.title,
      summary: report.summary ?? report.subtitle ?? '',
      findings: insights.map((p) => ({
        title: p.kind === 'interpretation' ? 'Interpretation' : 'Observed',
        detail: p.text,
      })),
      recommendations: actions.length ? actions.map((p) => p.text) : undefined,
    };
  }
}

function capitalise(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}
