import { Injectable } from '@angular/core';
import * as XLSX from 'xlsx';
import { ReportResult } from '../models/report-spec.model';

/** Exports a computed report to Excel (.xlsx) and to PDF (via the print dialog). */
@Injectable({ providedIn: 'root' })
export class ExportService {
  /** Build a two-sheet workbook (KPIs + data table) and download it. */
  exportExcel(result: ReportResult): void {
    const workbook = XLSX.utils.book_new();

    const kpiSheet = XLSX.utils.json_to_sheet(
      result.kpis.map((k) => ({ Metric: k.label, Value: k.value })),
    );
    XLSX.utils.book_append_sheet(workbook, kpiSheet, 'Summary');

    if (result.table && result.table.rows.length) {
      const headers = result.table.columns.map((c) => c.header);
      const keys = result.table.columns.map((c) => c.key);
      const data = result.table.rows.map((row) => {
        const out: Record<string, unknown> = {};
        result.table!.columns.forEach((col, i) => {
          out[headers[i]] = col.format
            ? col.format(row[keys[i]] as never, row as never)
            : (row[keys[i]] ?? '');
        });
        return out;
      });
      const dataSheet = XLSX.utils.json_to_sheet(data);
      XLSX.utils.book_append_sheet(workbook, dataSheet, 'Data');
    }

    XLSX.writeFile(workbook, `${this.slug(result.title)}.xlsx`);
  }

  /** Open a clean printable view of the report and trigger the print/PDF dialog. */
  exportPdf(result: ReportResult): void {
    const win = window.open('', '_blank', 'width=900,height=1200');
    if (!win) return;
    win.document.write(this.printableHtml(result));
    win.document.close();
    win.focus();
    // Give the new window a tick to lay out before printing.
    win.setTimeout(() => win.print(), 250);
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
    if (result.table && result.table.rows.length) {
      const cols = result.table.columns;
      const head = cols.map((c) => `<th>${esc(c.header)}</th>`).join('');
      const body = result.table.rows
        .map((row) => {
          const cells = cols
            .map((c) => {
              const raw = row[c.key];
              const val = c.format ? c.format(raw as never, row as never) : String(raw ?? '');
              return `<td>${esc(val)}</td>`;
            })
            .join('');
          return `<tr>${cells}</tr>`;
        })
        .join('');
      table = `<table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
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
        <p class="sub">${esc(result.description ?? '')} · ${result.rowCount} rows</p>
        <div class="kpis">${kpis}</div>
        ${table}
      </body></html>`;
  }

  private slug(title: string): string {
    return (title || 'report').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  }
}

function esc(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
