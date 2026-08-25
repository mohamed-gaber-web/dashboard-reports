import {
  ChartComponentSpec,
  HtmlDocumentComponentSpec,
  KpiGridComponentSpec,
  ReportPayload,
  TableComponentSpec,
} from '../models/report-payload.model';

/**
 * Builds a Chat Reports reply as one self-contained HTML document — used for
 * both the HTML download and the PDF, which is that same document sent to the
 * print dialog.
 *
 * ## Why one builder for both formats
 *
 * PDF here is "print this page", so the two are the same document under
 * different media rules. One builder means a change to the design lands in both
 * and the PDF can never drift into being the poor relation, which is what
 * happens when a print stylesheet is maintained separately.
 *
 * ## Why everything is inlined
 *
 * The file is opened from a `blob:` URL or written into a fresh `about:blank`
 * window. Neither can resolve the app's stylesheets, fonts or JS, so the
 * document carries its own CSS and the charts are emitted as literal SVG. An
 * exported file that only renders correctly while the app is running is not an
 * export.
 *
 * ## Why the provenance line is not optional
 *
 * On screen every report carries a line saying these figures were WRITTEN by the
 * model from real aggregates, not recomputed by the app. An exported document is
 * the copy that gets forwarded to someone who never saw that line — so it is
 * repeated in the masthead and the footer. This is the one contract in the app
 * where the numbers are model-authored, and a shared PDF that omits the caveat
 * is the single most misleading artefact it could produce.
 *
 * Pure: no Angular, no DOM reads, no I/O. Everything it needs is in the payload.
 */

/** Escapes before any markup is emitted — the ordering IS the security model. */
function esc(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Print-safe palette.
 *
 * Literal hex, not the app's `--color-chart-*` variables: those do not exist in
 * a detached document, so a `var()` would resolve to nothing and the charts
 * would print unfilled.
 */
const PALETTE = [
  '#2563eb',
  '#f24c1a',
  '#0ea5e9',
  '#8b5cf6',
  '#10b981',
  '#f59e0b',
  '#ec4899',
  '#64748b',
];

const color = (i: number) => PALETTE[i % PALETTE.length];

/** Plot geometry shared by the axis charts. */
const PLOT = { w: 660, h: 220, left: 54, right: 16, top: 14, bottom: 34 };

function niceNumber(value: number): string {
  return Number.isFinite(value) ? value.toLocaleString(undefined, { maximumFractionDigits: 2 }) : '—';
}

/** Horizontal gridlines plus their value labels, and the y-mapper. */
function frame(max: number, min: number): { grid: string; y: (v: number) => number } {
  const lo = Math.min(0, min);
  const span = max - lo || 1;
  const y = (v: number) => PLOT.h - PLOT.bottom - ((v - lo) / span) * (PLOT.h - PLOT.top - PLOT.bottom);
  const grid = [0, 0.5, 1]
    .map((f) => {
      const value = lo + span * f;
      const yy = y(value);
      return (
        `<line x1="${PLOT.left}" y1="${yy}" x2="${PLOT.w - PLOT.right}" y2="${yy}" class="grid"/>` +
        `<text x="${PLOT.left - 6}" y="${yy + 3}" class="axis" text-anchor="end">${esc(niceNumber(value))}</text>`
      );
    })
    .join('');
  return { grid, y };
}

/**
 * Sparse x-axis labels.
 *
 * Every label on a 30-point axis overlaps into an unreadable band at print
 * width, so past a dozen points only every nth is written.
 */
function xAxis(labels: string[], x: (i: number) => number): string {
  const step = Math.max(1, Math.ceil(labels.length / 12));
  return labels
    .map((label, i) =>
      i % step === 0 || i === labels.length - 1
        ? `<text x="${x(i)}" y="${PLOT.h - 12}" class="axis" text-anchor="middle">${esc(
            label.length > 14 ? `${label.slice(0, 13)}…` : label,
          )}</text>`
        : '',
    )
    .join('');
}

function legend(chart: ChartComponentSpec): string {
  if (chart.datasets.length < 2) return '';
  return (
    `<ul class="legend legend-row">` +
    chart.datasets
      .map(
        (d, i) =>
          `<li><span class="swatch" style="background:${color(i)}"></span><span>${esc(d.label)}</span></li>`,
      )
      .join('') +
    `</ul>`
  );
}

/** All series of a bar chart, grouped per category. */
function barSvg(chart: ChartComponentSpec): string {
  const { labels, datasets } = chart;
  if (!labels.length || !datasets.length) return '';

  const all = datasets.flatMap((d) => d.data);
  const { grid, y } = frame(Math.max(...all, 0), Math.min(...all, 0));

  const inner = PLOT.w - PLOT.left - PLOT.right;
  const band = inner / labels.length;
  const width = Math.max(2, (band * 0.68) / datasets.length);
  const zero = y(0);

  const bars = labels
    .map((_, i) => {
      const groupLeft = PLOT.left + band * i + (band - width * datasets.length) / 2;
      return datasets
        .map((d, s) => {
          const value = d.data[i] ?? 0;
          const top = Math.min(y(value), zero);
          const height = Math.max(1, Math.abs(zero - y(value)));
          return `<rect x="${groupLeft + width * s}" y="${top}" width="${width}" height="${height}" rx="2" fill="${color(s)}"/>`;
        })
        .join('');
    })
    .join('');

  const x = (i: number) => PLOT.left + band * i + band / 2;
  return (
    legend(chart) +
    `<svg viewBox="0 0 ${PLOT.w} ${PLOT.h}" width="100%" height="${PLOT.h}" role="img">` +
    `${grid}${bars}${xAxis(labels, x)}</svg>`
  );
}

/** All series of a line chart. */
function lineSvg(chart: ChartComponentSpec): string {
  const { labels, datasets } = chart;
  if (!labels.length || !datasets.length) return '';

  const all = datasets.flatMap((d) => d.data);
  const { grid, y } = frame(Math.max(...all, 0), Math.min(...all, 0));

  const inner = PLOT.w - PLOT.left - PLOT.right;
  const x = (i: number) =>
    labels.length > 1 ? PLOT.left + (i / (labels.length - 1)) * inner : PLOT.left + inner / 2;

  const lines = datasets
    .map((d, s) => {
      const points = labels.map((_, i) => `${x(i)},${y(d.data[i] ?? 0)}`).join(' ');
      const dots =
        labels.length <= 24
          ? labels
              .map((_, i) => `<circle cx="${x(i)}" cy="${y(d.data[i] ?? 0)}" r="2.6" fill="${color(s)}"/>`)
              .join('')
          : '';
      return (
        `<polyline points="${points}" fill="none" stroke="${color(s)}" stroke-width="2" ` +
        `stroke-linejoin="round" stroke-linecap="round"/>${dots}`
      );
    })
    .join('');

  return (
    legend(chart) +
    `<svg viewBox="0 0 ${PLOT.w} ${PLOT.h}" width="100%" height="${PLOT.h}" role="img">` +
    `${grid}${lines}${xAxis(labels, x)}</svg>`
  );
}

/**
 * A pie or doughnut, with its legend.
 *
 * The first series only — which is what the on-screen renderer does too, and
 * what the tool schema tells the model to send.
 */
function pieSvg(chart: ChartComponentSpec, hole: boolean): string {
  const values = chart.datasets[0]?.data ?? [];
  const total = values.reduce((sum, v) => sum + Math.max(0, v), 0);
  if (!total) return '';

  const cx = 90;
  const cy = 90;
  const r = hole ? 66 : 45;
  const stroke = hole ? 26 : 90;
  const circumference = 2 * Math.PI * r;

  let offset = 0;
  const arcs = chart.labels
    .map((_, i) => {
      const portion = Math.max(0, values[i] ?? 0) / total;
      const dash = portion * circumference;
      const seg =
        `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${color(i)}" ` +
        `stroke-width="${stroke}" stroke-dasharray="${dash} ${circumference - dash}" ` +
        `stroke-dashoffset="${-offset}" transform="rotate(-90 ${cx} ${cy})"/>`;
      offset += dash;
      return seg;
    })
    .join('');

  const centre = hole
    ? `<text x="${cx}" y="${cy - 2}" class="donut-total">${esc(niceNumber(total))}</text>` +
      `<text x="${cx}" y="${cy + 14}" class="donut-cap">total</text>`
    : '';

  const items = chart.labels
    .map((label, i) => {
      const value = values[i] ?? 0;
      const pct = Math.round((Math.max(0, value) / total) * 100);
      return (
        `<li><span class="swatch" style="background:${color(i)}"></span>` +
        `<span class="lg-label">${esc(label)}</span>` +
        `<span class="lg-val">${esc(niceNumber(value))} · ${pct}%</span></li>`
      );
    })
    .join('');

  return (
    `<div class="donut-wrap">` +
    `<svg viewBox="0 0 180 180" width="180" height="180" role="img">${arcs}${centre}</svg>` +
    `<ul class="legend">${items}</ul></div>`
  );
}

function chartSvg(chart: ChartComponentSpec): string {
  switch (chart.chart_type) {
    case 'line':
      return lineSvg(chart);
    case 'pie':
      return pieSvg(chart, false);
    case 'doughnut':
      return pieSvg(chart, true);
    default:
      return barSvg(chart);
  }
}

function kpiHtml(component: KpiGridComponentSpec): string {
  if (!component.items.length) return '';
  const tiles = component.items
    .map((item, i) => {
      // `isPositive` is whether the change is GOOD, not whether it is
      // arithmetically positive — falling costs are positive.
      const tone = item.change === undefined ? '' : item.isPositive ? ' kpi-good' : ' kpi-bad';
      const change = item.change ? `<span class="kpi-change${tone}">${esc(item.change)}</span>` : '';
      return (
        `<div class="kpi" style="border-top-color:${color(i)}">` +
        `<span class="kpi-label">${esc(item.label)}</span>` +
        `<span class="kpi-value">${esc(item.value)}</span>${change}</div>`
      );
    })
    .join('');
  return `<section class="block"><h2>At a glance</h2><div class="kpis">${tiles}</div></section>`;
}

function tableHtml(component: TableComponentSpec): string {
  if (!component.headers.length || !component.rows.length) return '';
  const head = component.headers.map((h) => `<th>${esc(h)}</th>`).join('');
  const body = component.rows
    .map((row) => `<tr>${component.headers.map((_, i) => `<td>${esc(row[i] ?? '')}</td>`).join('')}</tr>`)
    .join('');
  return (
    `<section class="block"><h2>${esc(component.title || 'Detail')}</h2>` +
    `<table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></section>`
  );
}

/**
 * The Executive style's report, carried into the exported file as-is.
 *
 * Inlined rather than framed, because this file's whole purpose is to be
 * printed or forwarded: an `<iframe>` has a fixed height and would print one
 * screenful of an eight-section report. The security calculus is different here
 * too — a saved `.html` is a document the user chose to open, not a live page
 * holding a D365 token, and the script tags were already stripped server-side.
 *
 * The fragment brings its own `<style>`, which applies to this document as well.
 * That is accepted: the model is told to scope its rules under `.report`, and
 * the worst case is that the masthead adopts the report's own type — never that
 * a figure changes. The provenance footer is emitted after it regardless, which
 * is the part that must survive.
 */
function documentHtml(component: HtmlDocumentComponentSpec): string {
  if (!component.html.trim()) return '';
  return `<section class="block block-document">${component.html}</section>`;
}

function chartHtml(component: ChartComponentSpec): string {
  const body = chartSvg(component);
  // A chart with no usable data is left out rather than printed as an empty
  // frame with a caption implying there was something to see.
  if (!body) return '';
  return (
    `<section class="block"><figure class="chart">` +
    `<figcaption>${esc(component.title)}</figcaption>${body}</figure></section>`
  );
}

export interface ReportDocumentInput {
  payload: ReportPayload;
  /** The question that produced it. The document's title. */
  question: string;
  /** Which module the figures came from, e.g. "Inventory". */
  sourceLabel: string;
  /** Rows the aggregates behind the answer covered, when it was grounded. */
  groundedRows: number | null;
  /** App/company name for the letterhead. */
  brandName: string;
}

/** The document's title — the question asked, since that is what it answers. */
export function reportDocumentTitle(input: ReportDocumentInput): string {
  const question = input.question.trim();
  if (question) return question.length > 120 ? `${question.slice(0, 117)}…` : question;
  return `${input.sourceLabel} report`;
}

/** The provenance sentence. Stated twice in the document, deliberately. */
export function provenanceLine(groundedRows: number | null): string {
  return groundedRows === null
    ? 'Figures written by AI — no dataset was attached to this answer.'
    : `Figures written by AI from aggregates over ${groundedRows.toLocaleString()} live Dynamics 365 rows. ` +
        'Grounded in real data, but not recomputed by the application.';
}

/** Render the complete, self-contained document. */
export function buildReportDocument(input: ReportDocumentInput): string {
  const { payload, sourceLabel, groundedRows, brandName } = input;
  const title = reportDocumentTitle(input);
  const provenance = provenanceLine(groundedRows);
  const printed = new Date().toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });

  const commentary = payload.text_response
    ? `<section class="block"><h2>Summary</h2><p class="lede">${esc(payload.text_response)}</p></section>`
    : '';

  // Components in the order the model chose — the document is the report the
  // user read, not a re-layout of it.
  const body = payload.components
    .map((component) => {
      switch (component.type) {
        case 'kpi_grid':
          return kpiHtml(component);
        case 'chart':
          return chartHtml(component);
        case 'table':
          return tableHtml(component);
        case 'html_document':
          return documentHtml(component);
        default:
          return '';
      }
    })
    .join('');

  // Anything the reply asked for that could not be rendered as sent. Carried
  // into the document too — a shared report that quietly answers half the
  // question is worse than one that says so.
  const dropped = payload.dropped.length
    ? `<section class="block caveat"><h2>Not included</h2><ul>` +
      payload.dropped.map((d) => `<li>${esc(d)}</li>`).join('') +
      `</ul></section>`
    : '';

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>${esc(title)}</title>
<style>
  :root {
    --ink:#0c1626; --muted:#55627a; --faint:#8a95a8;
    --line:#e6ecf4; --line-soft:#f0f4f9; --bg:#fff; --panel:#f8fafc;
    --brand:${PALETTE[0]}; --accent:${PALETTE[1]};
  }
  * { box-sizing:border-box; }
  body {
    margin:0; background:var(--bg); color:var(--ink);
    font:15px/1.6 "Segoe UI", -apple-system, system-ui, sans-serif;
    -webkit-print-color-adjust:exact; print-color-adjust:exact;
  }
  .page { max-width:940px; margin:0 auto; padding:40px 44px 64px; }

  header.mast { border-bottom:3px solid var(--brand); padding-bottom:18px; margin-bottom:26px; }
  .brand { display:flex; align-items:center; gap:10px; margin-bottom:14px; }
  .brand-dot { width:26px; height:26px; border-radius:8px;
    background:linear-gradient(135deg,var(--brand),var(--accent)); }
  .brand-name { font-size:13px; font-weight:700; letter-spacing:.08em; text-transform:uppercase; color:var(--muted); }
  h1 { font-size:28px; line-height:1.28; margin:0 0 8px; letter-spacing:-.02em; }
  .meta { color:var(--faint); font-size:13px; display:flex; flex-wrap:wrap; gap:6px 14px; }
  .meta strong { color:var(--muted); font-weight:600; }

  /* The caveat that makes this contract honest. Loud enough to be read. */
  .provenance { margin-top:14px; border-radius:8px; border:1px solid #f0d9a8;
    background:#fdf8ec; padding:9px 12px; font-size:12px; color:#6b5518; }

  .block { margin-bottom:28px; break-inside:avoid; }
  h2 { font-size:12px; text-transform:uppercase; letter-spacing:.09em; color:var(--faint);
       margin:0 0 12px; padding-bottom:7px; border-bottom:1px solid var(--line); }
  .lede { font-size:16px; line-height:1.7; margin:0; white-space:pre-line; }

  .kpis { display:grid; grid-template-columns:repeat(auto-fit,minmax(150px,1fr)); gap:12px; }
  .kpi { border:1px solid var(--line); border-top:3px solid var(--brand);
    border-radius:10px; padding:13px 15px; background:#fff; }
  .kpi-label { display:block; font-size:10.5px; text-transform:uppercase; letter-spacing:.05em; color:var(--faint); }
  .kpi-value { display:block; font-size:24px; font-weight:700; margin-top:5px; letter-spacing:-.02em; }
  .kpi-change { display:block; margin-top:3px; font-size:12px; font-weight:600; color:var(--muted); }
  .kpi-good { color:#157f45; }
  .kpi-bad { color:#c02626; }

  figure.chart { margin:0; padding:16px; border:1px solid var(--line); border-radius:10px; break-inside:avoid; }
  figcaption { font-size:13px; font-weight:600; margin-bottom:10px; }
  .axis { font-size:10px; fill:var(--faint); }
  .grid { stroke:var(--line); stroke-width:1; }
  .donut-wrap { display:flex; gap:24px; align-items:center; flex-wrap:wrap; }
  .donut-total { font-size:20px; font-weight:700; text-anchor:middle; fill:var(--ink); }
  .donut-cap { font-size:9px; text-anchor:middle; fill:var(--faint); text-transform:uppercase; letter-spacing:.08em; }
  ul.legend { list-style:none; padding:0; margin:0; flex:1; min-width:200px; }
  ul.legend li { display:flex; align-items:center; gap:8px; padding:3px 0; font-size:12.5px; }
  ul.legend.legend-row { display:flex; flex-wrap:wrap; gap:4px 16px; margin-bottom:8px; }
  .swatch { width:10px; height:10px; border-radius:3px; flex:none; }
  .lg-label { flex:1; }
  .lg-val { color:var(--faint); font-variant-numeric:tabular-nums; }

  table { width:100%; border-collapse:collapse; font-size:12px; }
  th { text-align:left; font-size:10px; text-transform:uppercase; letter-spacing:.05em;
       color:var(--faint); border-bottom:2px solid var(--line); padding:8px 9px; }
  td { padding:7px 9px; border-bottom:1px solid var(--line-soft); }
  tbody tr:nth-child(even) { background:var(--panel); }

  .caveat { border:1px solid #f0d9a8; background:#fdf8ec; border-radius:10px; padding:14px 16px; }
  .caveat h2 { border:0; color:#8a6d1f; margin-bottom:6px; padding:0; }
  .caveat ul { margin:0; padding-left:18px; font-size:13px; color:#6b5518; }

  footer { margin-top:34px; padding-top:14px; border-top:1px solid var(--line);
    font-size:11px; color:var(--faint); display:flex; flex-wrap:wrap; justify-content:space-between; gap:8px 12px; }

  @media print {
    .page { max-width:none; padding:0; }
    @page { margin:14mm; }
    body { font-size:11.5pt; }
    h1 { font-size:21pt; }
    figure.chart, .block { break-inside:avoid; }
    thead { display:table-header-group; }
  }
  @media (max-width:640px) { .page { padding:24px 18px 40px; } h1 { font-size:23px; } }
</style></head>
<body><div class="page">
  <header class="mast">
    <div class="brand"><span class="brand-dot"></span><span class="brand-name">${esc(brandName)}</span></div>
    <h1>${esc(title)}</h1>
    <div class="meta">
      <span><strong>${esc(sourceLabel)}</strong></span>
      <span>${esc(printed)}</span>
    </div>
    <p class="provenance">${esc(provenance)}</p>
  </header>
  ${commentary}
  ${body}
  ${dropped}
  <footer>
    <span>${esc(brandName)} · ${esc(sourceLabel)}</span>
    <span>${esc(provenance)}</span>
  </footer>
</div></body></html>`;
}
