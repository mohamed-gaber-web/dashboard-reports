import { Injectable, inject } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { ApiService } from '../../../core/http/api.service';
import { D365_MAX_PAGE_SIZE } from '../../../core/models/odata.model';
import { Analysis } from '../models/analysis.model';
import { AnalystSource } from '../models/analyst-source.model';
import { ReportResult } from '../models/report-spec.model';
import { buildDocument, documentTitle } from './document-builder';

/** Excel's hard ceiling — 1,048,576 rows per sheet, including the header. */
const EXCEL_MAX_ROWS = 1_048_575;

/** Above this we stream CSV instead of building a workbook in memory. */
const XLSX_MAX_ROWS = 50_000;

/**
 * Hard cap on a CSV export.
 *
 * The CSV is assembled in memory (an array of page strings) before the Blob is
 * built, so it is bounded by RAM, not truly streamed. At ~150 bytes/row this is
 * ~75 MB — survivable. Beyond it the page-by-page crawl also turns into hours of
 * sequential ~8 s requests, so we refuse and tell the user to narrow, matching
 * the app's "narrow first" model rather than freezing the tab.
 */
const CSV_MAX_ROWS = 500_000;

/** Thrown when an export would exceed {@link CSV_MAX_ROWS}. Carries the numbers to explain. */
export class ExportTooLargeError extends Error {
  constructor(
    readonly rows: number,
    readonly limit: number,
  ) {
    super(
      `This report covers ${rows.toLocaleString()} rows. CSV export is limited to ` +
        `${limit.toLocaleString()} — narrow the filter (date range, site, search) and export again.`,
    );
    this.name = 'ExportTooLargeError';
  }
}

export interface ExportProgress {
  written: number;
  total: number;
}

/** Everything the designed document needs. See {@link buildDocument}. */
export interface DocumentContext {
  result: ReportResult;
  analysis?: Analysis | null;
  sourceLabel: string;
  brandName: string;
}

/**
 * Exports a computed report.
 *
 * ## The bug this replaces
 *
 * `ReportEngineService` caps its table at 100 rows for rendering. The old export
 * read `result.table.rows` — i.e. **that same 100-row slice** — while a comment
 * insisted "export still receives the full filtered set". It did not. Every
 * "full detail" export ever produced by this app was silently truncated to 100
 * rows. The type now separates `displayRows` from the real total, so that mistake
 * cannot be made silently again.
 *
 * ## Why full detail is CSV, not XLSX
 *
 * `XLSX.writeFile` builds the entire workbook as JS objects on the main thread.
 * At 11M rows × 16 columns that is ~176M cell objects — it exhausts the heap and
 * freezes the tab. CSV is assembled from paged fetches as plain strings (far
 * lighter than cell objects) and capped at {@link CSV_MAX_ROWS} so the in-memory
 * buffer stays bounded. It also opens natively in Excel.
 */
@Injectable({ providedIn: 'root' })
export class ExportService {
  private readonly api = inject(ApiService);

  /**
   * The report as seen: KPI summary plus the rendered sample of the table.
   *
   * The sheet is **labelled with what it actually contains**. If you want every
   * matching row, use {@link exportFullDetail}.
   */
  async exportExcel(result: ReportResult, source: AnalystSource, filter: string): Promise<void> {
    const XLSX = await import('xlsx');
    const workbook = XLSX.utils.book_new();

    // The summary sheet is the report's figures, whichever sections produced
    // them. A report can now be a ranking and nothing else, or two comparison
    // metrics — reading only `kpis` here would hand back an empty workbook for
    // exactly the questions the ranking section was added to answer.
    const summary: Record<string, unknown>[] = [
      { Metric: 'Report', Value: result.title },
      { Metric: 'Rows matching filter', Value: result.rowCount },
      ...result.kpis.map((k) => ({ Metric: k.label, Value: k.value })),
    ];

    for (const block of result.blocks ?? []) {
      if (block.kind !== 'comparison') continue;
      for (const item of block.items) {
        summary.push({
          Metric: item.label,
          Value: item.current,
          [block.previousLabel]: item.previous,
          Change: item.delta,
          'Change %': item.deltaPercent === null ? '—' : `${item.deltaPercent}%`,
        });
      }
    }

    XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(summary), 'Summary');

    // One sheet per ranking. These are computed figures the user asked for by
    // name; leaving them out would mean the workbook does not contain the answer.
    const used = new Set(['Summary']);
    for (const block of result.blocks ?? []) {
      if (block.kind !== 'ranking' || !block.rows.length) continue;
      const rows = block.rows.map((r) => ({
        '#': r.rank,
        Name: r.label,
        [block.measureLabel]: r.display,
        Share: `${r.sharePct}%`,
      }));
      XLSX.utils.book_append_sheet(
        workbook,
        XLSX.utils.json_to_sheet(rows),
        uniqueSheetName(block.title, used),
      );
    }

    const table = result.table;
    if (table) {
      // Small enough to put every row in the workbook? Then do — otherwise be
      // explicit that this sheet is a sample, and point at the CSV export.
      const full = result.rowCount <= XLSX_MAX_ROWS;
      const rows = full
        ? await this.fetchAll(source, filter, result.rowCount)
        : table.displayRows;

      const data = rows.map((row) => {
        const out: Record<string, unknown> = {};
        for (const col of table.columns) {
          const raw = row[col.key];
          out[col.header] = col.format ? col.format(raw as never, row as never) : (raw ?? '');
        }
        return out;
      });

      const name = full ? 'Data' : `Sample (${table.displayLimit} of ${result.rowCount})`;
      XLSX.utils.book_append_sheet(
        workbook,
        XLSX.utils.json_to_sheet(data),
        uniqueSheetName(name, used),
      );
    }

    XLSX.writeFile(workbook, `${this.slug(result.title)}.xlsx`);
  }

  /**
   * Every matching row, written to CSV.
   *
   * Pages are fetched and appended; the assembled parts stay in memory until the
   * Blob is built, so the export is capped at {@link CSV_MAX_ROWS} to keep that
   * bounded. Above the cap it throws {@link ExportTooLargeError} rather than
   * freezing the tab on a multi-million-row crawl.
   */
  async exportFullDetail(
    result: ReportResult,
    source: AnalystSource,
    filter: string,
    onProgress?: (p: ExportProgress) => void,
  ): Promise<void> {
    const table = result.table;
    if (!table) return;

    const total = result.rowCount;
    if (total > CSV_MAX_ROWS) throw new ExportTooLargeError(total, CSV_MAX_ROWS);

    const keys = table.columns.map((c) => c.key);
    const parts: BlobPart[] = ['﻿' + keys.map((k) => csvCell(headerOf(table, k))).join(',') + '\n'];

    let written = 0;
    for (let skip = 0; skip < total; skip += D365_MAX_PAGE_SIZE) {
      const page = await firstValueFrom(
        this.api.getPage<Record<string, unknown>>(
          source.entity,
          {
            filter,
            select: source.select,
            orderby: source.keyField.map((k) => `${k} desc`).join(','),
            top: D365_MAX_PAGE_SIZE,
            skip,
            crossCompany: source.crossCompany,
          },
          source.dataPath,
        ),
      );

      if (!page.rows.length) break;

      // Serialise, append, and let the page go.
      parts.push(page.rows.map((r) => keys.map((k) => csvCell(r[k])).join(',')).join('\n') + '\n');
      written += page.rows.length;
      onProgress?.({ written, total });
    }

    this.download(new Blob(parts, { type: 'text/csv;charset=utf-8' }), `${this.slug(result.title)}.csv`);
  }

  /** Whether a full export would exceed what Excel can even open. */
  exceedsExcelLimit(rowCount: number): boolean {
    return rowCount > EXCEL_MAX_ROWS;
  }

  /**
   * The designed document, sent to the print dialog (→ "Save as PDF").
   *
   * There is no PDF library here on purpose: the browser's own print engine
   * already paginates, embeds fonts and honours `@page`, and it does so without
   * adding a multi-megabyte dependency to a dashboard.
   */
  exportPdf(input: DocumentContext): void {
    const win = window.open('', '_blank', 'width=980,height=1200');
    if (!win) return;
    win.document.write(buildDocument(input));
    win.document.close();
    win.focus();
    // Give the SVG and web fonts a beat to lay out; printing too early prints
    // a half-rendered first page.
    win.setTimeout(() => win.print(), 400);
  }

  /** The same designed document, saved as a standalone `.html` file. */
  exportHtml(input: DocumentContext): void {
    const blob = new Blob([buildDocument(input)], { type: 'text/html;charset=utf-8' });
    this.download(blob, `${this.slug(documentTitle(input))}.html`);
  }

  // ── Internals ────────────────────────────────────────────────────────────
  private async fetchAll(
    source: AnalystSource,
    filter: string,
    total: number,
  ): Promise<Record<string, unknown>[]> {
    const rows: Record<string, unknown>[] = [];
    for (let skip = 0; skip < total; skip += D365_MAX_PAGE_SIZE) {
      const page = await firstValueFrom(
        this.api.getPage<Record<string, unknown>>(
          source.entity,
          {
            filter,
            select: source.select,
            orderby: source.keyField.map((k) => `${k} desc`).join(','),
            top: D365_MAX_PAGE_SIZE,
            skip,
            crossCompany: source.crossCompany,
          },
          source.dataPath,
        ),
      );
      if (!page.rows.length) break;
      rows.push(...page.rows);
    }
    return rows;
  }

  private download(blob: Blob, filename: string): void {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  }

  private slug(title: string): string {
    return (title || 'report').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  }
}

/**
 * A legal, unused sheet name.
 *
 * Excel caps names at 31 characters, forbids `[]:*?/\`, and refuses a workbook
 * with two sheets of the same name outright — and the titles here are written
 * by a model, so all three are reachable. Truncating alone is not enough: two
 * long ranking titles sharing a prefix collide after the cut.
 */
function uniqueSheetName(title: string, used: Set<string>): string {
  const base = (title || 'Sheet').replace(/[[\]:*?/\\]/g, ' ').trim().slice(0, 31) || 'Sheet';
  let name = base;
  for (let i = 2; used.has(name); i++) name = `${base.slice(0, 28)} ${i}`;
  used.add(name);
  return name;
}

function headerOf(table: NonNullable<ReportResult['table']>, key: string): string {
  return table.columns.find((c) => c.key === key)?.header ?? key;
}

function csvCell(value: unknown): string {
  const s = value == null ? '' : String(value);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
