import { Injectable, inject } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { ApiService } from '../../../core/http/api.service';
import { D365_MAX_PAGE_SIZE } from '../../../core/models/odata.model';
import { AnalystSource } from '../models/analyst-source.model';
import { ReportResult } from '../models/report-spec.model';

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

    const summary = [
      { Metric: 'Report', Value: result.title },
      { Metric: 'Rows matching filter', Value: result.rowCount },
      ...result.kpis.map((k) => ({ Metric: k.label, Value: k.value })),
    ];
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(summary), 'Summary');

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
      XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(data), name.slice(0, 31));
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

  /** Open a clean printable view of the report and trigger the print/PDF dialog. */
  exportPdf(result: ReportResult): void {
    const win = window.open('', '_blank', 'width=900,height=1200');
    if (!win) return;
    win.document.write(this.printableHtml(result));
    win.document.close();
    win.focus();
    win.setTimeout(() => win.print(), 250);
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

  private printableHtml(result: ReportResult): string {
    const kpis = result.kpis
      .map(
        (k) =>
          `<div class="kpi"><span class="kpi-label">${esc(k.label)}</span>` +
          `<span class="kpi-value">${esc(k.value)}</span></div>`,
      )
      .join('');

    let table = '';
    const t = result.table;
    if (t && t.displayRows.length) {
      const head = t.columns.map((c) => `<th>${esc(c.header)}</th>`).join('');
      const body = t.displayRows
        .map((row) => {
          const cells = t.columns
            .map((c) => {
              const raw = row[c.key];
              const val = c.format ? c.format(raw as never, row as never) : String(raw ?? '');
              return `<td>${esc(val)}</td>`;
            })
            .join('');
          return `<tr>${cells}</tr>`;
        })
        .join('');
      const note =
        t.total > t.displayRows.length
          ? `<p class="sub">Showing ${t.displayRows.length} of ${t.total.toLocaleString()} rows.</p>`
          : '';
      table = `${note}<table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
    }

    return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(result.title)}</title>
      <style>
        * { box-sizing: border-box; }
        body { font-family: 'Segoe UI', system-ui, sans-serif; color: #0c1626; margin: 32px; }
        h1 { font-size: 22px; margin: 0 0 4px; }
        p.sub { color: #55627a; margin: 0 0 20px; font-size: 13px; }
        .kpis { display: flex; flex-wrap: wrap; gap: 12px; margin-bottom: 24px; }
        .kpi { border: 1px solid #e8edf4; border-radius: 12px; padding: 12px 16px; min-width: 150px; }
        .kpi-label { display: block; font-size: 11px; text-transform: uppercase; letter-spacing: .04em; color: #8a95a8; }
        .kpi-value { display: block; font-size: 24px; font-weight: 700; margin-top: 4px; }
        table { width: 100%; border-collapse: collapse; font-size: 12px; }
        th { text-align: left; text-transform: uppercase; font-size: 10px; letter-spacing: .04em; color: #8a95a8; border-bottom: 2px solid #e8edf4; padding: 8px; }
        td { padding: 7px 8px; border-bottom: 1px solid #eef2f7; }
        @media print { body { margin: 12mm; } }
      </style></head>
      <body>
        <h1>${esc(result.title)}</h1>
        <p class="sub">${esc(result.description ?? '')} · ${result.rowCount.toLocaleString()} rows</p>
        <div class="kpis">${kpis}</div>
        ${table}
      </body></html>`;
  }

  private slug(title: string): string {
    return (title || 'report').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  }
}

function headerOf(table: NonNullable<ReportResult['table']>, key: string): string {
  return table.columns.find((c) => c.key === key)?.header ?? key;
}

function csvCell(value: unknown): string {
  const s = value == null ? '' : String(value);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function esc(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
