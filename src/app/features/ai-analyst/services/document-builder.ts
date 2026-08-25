import { Analysis } from '../models/analysis.model';
import {
  ChartResult,
  ReportBlock,
  ReportResult,
  reportColor,
} from '../models/report-spec.model';

/**
 * Builds the exported document — one self-contained HTML string, used for both
 * the HTML download and the PDF (which is that same document sent to the print
 * dialog).
 *
 * ## Why one builder for both formats
 *
 * PDF here is "print this page", so the two formats are the same document under
 * different media rules. Keeping one builder means a change to the design lands
 * in both, and the PDF can never drift into being the poor relation — which is
 * what happens when a print stylesheet is maintained separately.
 *
 * ## Why it walks blocks
 *
 * The report on screen is an ordered list of {@link ReportBlock}s chosen by the
 * model, so the document has to be too. Rendering a fixed KPI/chart/table
 * sequence here while the screen showed a ranking and two paragraphs would mean
 * the exported file quietly answered a different question from the one the user
 * just read — the worst possible place for that divergence, since the export is
 * the artefact that gets forwarded.
 *
 * ## Why everything is inlined
 *
 * The file is opened from a `blob:` URL or written into a fresh `about:blank`
 * window. Neither can resolve the app's stylesheets, fonts or JS, so the document
 * carries its own CSS, and charts are emitted as literal SVG rather than by
 * mounting the Angular chart components. An exported file that only renders
 * correctly while the app is running is not an export.
 *
 * ## Colours are resolved, not referenced
 *
 * The app themes itself with CSS variables (`--color-chart-1`). Those do not
 * exist in the exported document, so palette colours are read off the live
 * document at build time and written in as literal hex. This is also what keeps a
 * re-branded app's exports on-brand.
 */

/** Print-safe palette, resolved from the running app's theme where possible. */
function resolvePalette(): string[] {
  const fallback = [
    '#2563eb',
    '#f24c1a',
    '#0ea5e9',
    '#8b5cf6',
    '#10b981',
    '#f59e0b',
    '#ec4899',
    '#64748b',
  ];
  if (typeof document === 'undefined') return fallback;
  const styles = getComputedStyle(document.documentElement);
  return fallback.map((hex, i) => {
    const value = styles.getPropertyValue(`--color-chart-${i + 1}`).trim();
    // A var() that resolves to another var() is no use in a detached document.
    return value && !value.includes('var(') ? value : hex;
  });
}

/**
 * Resolve a computed colour to something a detached document can render.
 *
 * A report can carry its own palette (`design.palette` — a single-hue ramp for
 * "make it one colour"), and those colours are CSS variables and `color-mix()`
 * expressions so the app can re-theme them at runtime. Neither survives in an
 * exported file, and an index-based palette here would ignore `datum.color`
 * entirely — so a recoloured report would print in the ORIGINAL colours, which
 * is the sort of drift nobody notices until a client sees the PDF.
 *
 * A hidden probe on <html> inherits the theme's custom properties, so the
 * browser does the resolving for us — one code path for `var()`, `color-mix()`
 * and anything else CSS grows later.
 */
function colorResolver(): { resolve: (value?: string) => string | undefined; done: () => void } {
  if (typeof document === 'undefined') return { resolve: (v) => v, done: () => {} };

  const probe = document.createElement('span');
  probe.style.display = 'none';
  document.documentElement.appendChild(probe);

  return {
    resolve: (value) => {
      if (!value) return undefined;
      if (!value.includes('var(') && !value.includes('color-mix(')) return value;
      probe.style.color = '';
      probe.style.color = value;
      // An unparseable value leaves the property empty; fall back rather than
      // writing `color: ''` into the document.
      return getComputedStyle(probe).color || undefined;
    },
    done: () => probe.remove(),
  };
}

function esc(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Everything a chart renderer needs beyond the chart itself. */
interface Paint {
  palette: string[];
  resolve: (value?: string) => string | undefined;
}

/** How this chart's values are written. Falls back when the engine set none. */
function valueFormat(chart: ChartResult): (value: number) => string {
  return chart.format ?? ((v: number) => v.toLocaleString());
}

/** The single hue a line or column series is drawn in. */
function seriesColor(chart: ChartResult, paint: Paint): string {
  return paint.resolve(chart.series?.[0]?.color) ?? paint.palette[0];
}

/** A horizontal bar chart as standalone SVG. */
function barSvg(chart: ChartResult, paint: Paint): string {
  const data = chart.data.slice(0, 12);
  if (!data.length) return '';
  const fmt = valueFormat(chart);
  const max = Math.max(...data.map((d) => d.value), 1);
  const rowH = 26;
  const labelW = 150;
  const barW = 420;
  const height = data.length * rowH + 8;

  const rows = data
    .map((d, i) => {
      const w = Math.max(2, Math.round((d.value / max) * barW));
      const y = i * rowH + 4;
      const label = d.label.length > 22 ? `${d.label.slice(0, 21)}…` : d.label;
      const fill = paint.resolve(d.color) ?? paint.palette[i % paint.palette.length];
      return (
        `<text x="0" y="${y + 13}" class="lbl">${esc(label)}</text>` +
        `<rect x="${labelW}" y="${y + 3}" width="${w}" height="14" rx="3" fill="${fill}"/>` +
        `<text x="${labelW + w + 6}" y="${y + 13}" class="val">${esc(fmt(d.value))}</text>`
      );
    })
    .join('');

  return `<svg viewBox="0 0 ${labelW + barW + 70} ${height}" width="100%" height="${height}" role="img">${rows}</svg>`;
}

/** A donut chart as standalone SVG, with a legend. */
function donutSvg(chart: ChartResult, paint: Paint): string {
  const data = chart.data.slice(0, 8);
  const total = data.reduce((sum, d) => sum + d.value, 0);
  if (!total) return '';
  const fmt = valueFormat(chart);

  const cx = 90;
  const cy = 90;
  const r = 66;
  const stroke = 26;
  const circumference = 2 * Math.PI * r;

  let offset = 0;
  const arcs = data
    .map((d, i) => {
      const portion = d.value / total;
      const dash = portion * circumference;
      const seg =
        `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${paint.resolve(d.color) ?? paint.palette[i % paint.palette.length]}" ` +
        `stroke-width="${stroke}" stroke-dasharray="${dash} ${circumference - dash}" ` +
        `stroke-dashoffset="${-offset}" transform="rotate(-90 ${cx} ${cy})"/>`;
      offset += dash;
      return seg;
    })
    .join('');

  const legend = data
    .map((d, i) => {
      const pct = Math.round((d.value / total) * 100);
      const label = d.label.length > 20 ? `${d.label.slice(0, 19)}…` : d.label;
      return (
        `<li><span class="swatch" style="background:${paint.resolve(d.color) ?? paint.palette[i % paint.palette.length]}"></span>` +
        `<span class="lg-label">${esc(label)}</span>` +
        `<span class="lg-val">${esc(fmt(d.value))} · ${pct}%</span></li>`
      );
    })
    .join('');

  return (
    `<div class="donut-wrap">` +
    `<svg viewBox="0 0 180 180" width="180" height="180" role="img">${arcs}` +
    `<text x="${cx}" y="${cy - 2}" class="donut-total">${esc(fmt(total))}</text>` +
    `<text x="${cx}" y="${cy + 14}" class="donut-cap">total</text></svg>` +
    `<ul class="legend">${legend}</ul></div>`
  );
}

/** Plot geometry shared by the two axis charts. Zero-anchored, like the app's. */
const PLOT = { w: 660, h: 210, left: 52, right: 14, top: 12, bottom: 30 };

function plotFrame(max: number, fmt: (v: number) => string): { grid: string; y: (v: number) => number } {
  const span = max || 1;
  const y = (v: number) => PLOT.h - PLOT.bottom - (v / span) * (PLOT.h - PLOT.top - PLOT.bottom);
  const grid = [0, 0.5, 1]
    .map((f) => {
      const value = span * f;
      const yy = y(value);
      return (
        `<line x1="${PLOT.left}" y1="${yy}" x2="${PLOT.w - PLOT.right}" y2="${yy}" class="grid"/>` +
        `<text x="${PLOT.left - 6}" y="${yy + 3}" class="axis" text-anchor="end">${esc(fmt(value))}</text>`
      );
    })
    .join('');
  return { grid, y };
}

/**
 * Sparse x-axis labels.
 *
 * Every label on a 24-point axis overlaps into an unreadable band at print
 * width, so past a dozen points only every nth is written — the same
 * concession `app-line-chart` makes on screen.
 */
function xLabels(labels: string[], x: (i: number) => number): string {
  const step = Math.max(1, Math.ceil(labels.length / 12));
  return labels
    .map((label, i) =>
      i % step === 0 || i === labels.length - 1
        ? `<text x="${x(i)}" y="${PLOT.h - 10}" class="axis" text-anchor="middle">${esc(label)}</text>`
        : '',
    )
    .join('');
}

/** A line (optionally filled) as standalone SVG. */
function lineSvg(chart: ChartResult, paint: Paint, filled: boolean): string {
  const data = chart.data;
  if (!data.length) return '';
  const fmt = valueFormat(chart);
  const color = seriesColor(chart, paint);
  const max = Math.max(...data.map((d) => d.value), 1);
  const { grid, y } = plotFrame(max, fmt);

  const inner = PLOT.w - PLOT.left - PLOT.right;
  const x = (i: number) => (data.length > 1 ? PLOT.left + (i / (data.length - 1)) * inner : PLOT.left + inner / 2);

  const points = data.map((d, i) => `${x(i)},${y(d.value)}`).join(' ');
  const floor = PLOT.h - PLOT.bottom;
  const area = filled
    ? `<path d="M ${x(0)},${floor} L ${points.split(' ').join(' L ')} L ${x(data.length - 1)},${floor} Z" fill="${color}" opacity="0.14"/>`
    : '';
  const dots = data
    .map((d, i) => `<circle cx="${x(i)}" cy="${y(d.value)}" r="2.6" fill="${color}"/>`)
    .join('');

  return (
    `<svg viewBox="0 0 ${PLOT.w} ${PLOT.h}" width="100%" height="${PLOT.h}" role="img">` +
    `${grid}${area}` +
    `<polyline points="${points}" fill="none" stroke="${color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>` +
    `${data.length <= 24 ? dots : ''}${xLabels(data.map((d) => d.label), x)}</svg>`
  );
}

/** A vertical column chart as standalone SVG. */
function columnSvg(chart: ChartResult, paint: Paint): string {
  const data = chart.data.slice(0, 24);
  if (!data.length) return '';
  const fmt = valueFormat(chart);
  const color = seriesColor(chart, paint);
  const max = Math.max(...data.map((d) => d.value), 1);
  const { grid, y } = plotFrame(max, fmt);

  const inner = PLOT.w - PLOT.left - PLOT.right;
  const band = inner / data.length;
  const width = Math.max(3, band * 0.62);
  const x = (i: number) => PLOT.left + band * i + band / 2;
  const floor = PLOT.h - PLOT.bottom;

  const bars = data
    .map((d, i) => {
      const top = y(d.value);
      return `<rect x="${x(i) - width / 2}" y="${top}" width="${width}" height="${Math.max(1, floor - top)}" rx="2" fill="${paint.resolve(d.color) ?? color}"/>`;
    })
    .join('');

  return (
    `<svg viewBox="0 0 ${PLOT.w} ${PLOT.h}" width="100%" height="${PLOT.h}" role="img">` +
    `${grid}${bars}${xLabels(data.map((d) => d.label), x)}</svg>`
  );
}

function chartSvg(chart: ChartResult, paint: Paint): string {
  switch (chart.type) {
    case 'donut':
      return donutSvg(chart, paint);
    case 'column':
      return columnSvg(chart, paint);
    case 'line':
      return lineSvg(chart, paint, false);
    case 'area':
      return lineSvg(chart, paint, true);
    default:
      return barSvg(chart, paint);
  }
}

// ── Blocks ──────────────────────────────────────────────────────────────────

/**
 * The report's blocks, whichever shape the result arrived in.
 *
 * A `ReportResult` built before this change (or by a caller that only fills the
 * flattened `kpis`/`charts`/`table` projections) still exports, mapped onto the
 * layout it used to produce. One code path downstream, no second renderer.
 */
function blocksOf(result: ReportResult): ReportBlock[] {
  if (result.blocks?.length) return result.blocks;

  const legacy: ReportBlock[] = [];
  if (result.kpis.length) legacy.push({ kind: 'metrics', title: 'At a glance', items: result.kpis });
  for (const chart of result.charts) legacy.push({ kind: 'chart', chart });
  if (result.table) legacy.push({ kind: 'table', title: 'Detail', table: result.table });
  return legacy;
}

/** A titled block. An empty body renders nothing — no heading over a hole. */
function section(title: string, body: string): string {
  if (!body) return '';
  return `<section class="block">${title ? `<h2>${esc(title)}</h2>` : ''}${body}</section>`;
}

function renderBlock(block: ReportBlock, result: ReportResult, paint: Paint): string {
  switch (block.kind) {
    case 'metrics': {
      const tiles = block.items
        .map(
          (k, i) =>
            `<div class="kpi" style="border-top-color:${paint.resolve(reportColor(result.design.palette, i)) ?? paint.palette[i % paint.palette.length]}">` +
            `<span class="kpi-label">${esc(k.label)}</span>` +
            `<span class="kpi-value">${esc(k.value)}</span></div>`,
        )
        .join('');
      return section(block.title ?? 'At a glance', `<div class="kpis">${tiles}</div>`);
    }

    case 'chart': {
      const body = chartSvg(block.chart, paint);
      // A chart with no data is left out entirely rather than printed as an
      // empty frame with a caption implying there was something to see.
      if (!body) return '';
      const note = block.chart.note ? `<p class="note">${esc(block.chart.note)}</p>` : '';
      return `<section class="block"><figure class="chart"><figcaption>${esc(block.chart.title)}</figcaption>${note}${body}</figure></section>`;
    }

    case 'comparison': {
      const note = block.note ? `<p class="note">${esc(block.note)}</p>` : '';
      const cards = block.items
        .map((item) => {
          const pct = item.deltaPercent === null ? '—' : `${item.deltaPercent > 0 ? '+' : ''}${item.deltaPercent}%`;
          const arrow = item.direction === 'up' ? '▲' : item.direction === 'down' ? '▼' : '–';
          return (
            `<div class="cmp cmp-${item.sentiment}">` +
            `<span class="kpi-label">${esc(item.label)}</span>` +
            `<span class="kpi-value">${esc(item.current)}</span>` +
            `<span class="cmp-delta">${arrow} ${esc(pct)} <span class="cmp-abs">(${esc(item.delta)})</span></span>` +
            `<span class="cmp-base">${esc(block.previousLabel)}: ${esc(item.previous)}</span>` +
            `</div>`
          );
        })
        .join('');
      return section(
        block.title ?? `${block.currentLabel} vs ${block.previousLabel}`,
        `${note}<div class="kpis">${cards}</div>`,
      );
    }

    case 'ranking': {
      if (!block.rows.length) return '';
      const note = block.note ? `<p class="note">${esc(block.note)}</p>` : '';
      const rows = block.rows
        .map(
          (r) =>
            `<tr><td class="rk-pos">${r.rank}</td><td>${esc(r.label)}</td>` +
            `<td class="num">${esc(r.display)}</td><td class="num">${r.sharePct}%</td></tr>`,
        )
        .join('');
      return section(
        block.title,
        `${note}<table><thead><tr><th>#</th><th>Name</th><th class="num">${esc(block.measureLabel)}</th><th class="num">Share</th></tr></thead><tbody>${rows}</tbody></table>`,
      );
    }

    case 'table': {
      const t = block.table;
      if (!t.displayRows.length) return '';
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
      // Say what this table is. It is a page of the answer, not the answer.
      const note =
        t.total > t.displayRows.length
          ? `<p class="note">Showing the first ${t.displayRows.length.toLocaleString()} of ` +
            `${t.total.toLocaleString()} matching rows. Export to CSV for the complete set.</p>`
          : `<p class="note">All ${t.total.toLocaleString()} matching rows.</p>`;
      return section(
        block.title ?? 'Detail',
        `${note}<table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`,
      );
    }

    case 'text':
      return section(block.title ?? '', `<p class="lede">${esc(block.body)}</p>`);

    case 'list': {
      const items = block.items.map((i) => `<li>${esc(i)}</li>`).join('');
      return block.variant === 'recommendations'
        ? section(block.title ?? 'Recommended actions', `<ul class="actions">${items}</ul>`)
        : section(block.title ?? 'What this shows', `<ul class="insights">${items}</ul>`);
    }
  }
}

export interface DocumentInput {
  result: ReportResult;
  analysis?: Analysis | null;
  /** Dataset the report was built from, e.g. "Shatat · Serial Transactions". */
  sourceLabel: string;
  /** App/company name for the letterhead. */
  brandName: string;
}

/** The document's title — the analysis headline wins, since it is the point. */
export function documentTitle(input: DocumentInput): string {
  return input.analysis?.headline?.trim() || input.result.title;
}

/**
 * Render the complete, self-contained document.
 *
 * The written analysis opens it and the recommended actions close it — that is
 * how a brief is read, and both are prose the model wrote rather than figures.
 * Between them sits the report exactly as designed, block for block.
 */
export function buildDocument(input: DocumentInput): string {
  const { result, analysis, sourceLabel, brandName } = input;
  const palette = resolvePalette();
  const { resolve, done: releaseProbe } = colorResolver();
  const paint: Paint = { palette, resolve };
  const title = documentTitle(input);
  const printed = new Date().toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });

  const summary = analysis?.summary
    ? `<section class="block"><h2>Summary</h2><p class="lede">${esc(analysis.summary)}</p></section>`
    : '';

  const findings = analysis?.findings?.length
    ? `<section class="block"><h2>Key findings</h2><ol class="findings">` +
      analysis.findings
        .map((f) => `<li><h3>${esc(f.title)}</h3><p>${esc(f.detail)}</p></li>`)
        .join('') +
      `</ol></section>`
    : '';

  const body = blocksOf(result)
    .map((block) => renderBlock(block, result, paint))
    .join('');

  releaseProbe();

  const recommendations = analysis?.recommendations?.length
    ? `<section class="block"><h2>Recommended actions</h2><ul class="actions">` +
      analysis.recommendations.map((r) => `<li>${esc(r)}</li>`).join('') +
      `</ul></section>`
    : '';

  // Anything the planner refused belongs in the document too — a shared report
  // that quietly answers half the question is worse than one that says so.
  const omitted = result.omitted?.length
    ? `<section class="block caveat"><h2>Not included</h2><ul>` +
      result.omitted.map((o) => `<li>${esc(o)}</li>`).join('') +
      `</ul></section>`
    : '';

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>${esc(title)}</title>
<style>
  :root {
    --ink: #0c1626; --muted: #55627a; --faint: #8a95a8;
    --line: #e6ecf4; --line-soft: #f0f4f9; --bg: #ffffff; --panel: #f8fafc;
    --brand: ${palette[0]}; --accent: ${palette[1]};
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; background: var(--bg); color: var(--ink);
    font: 15px/1.6 "Segoe UI", -apple-system, system-ui, sans-serif;
    -webkit-print-color-adjust: exact; print-color-adjust: exact;
  }
  .page { max-width: 940px; margin: 0 auto; padding: 40px 44px 64px; }

  header.mast { border-bottom: 3px solid var(--brand); padding-bottom: 18px; margin-bottom: 28px; }
  .brand { display:flex; align-items:center; gap:10px; margin-bottom:14px; }
  .brand-dot { width:26px; height:26px; border-radius:8px;
    background: linear-gradient(135deg, var(--brand), var(--accent)); }
  .brand-name { font-size:13px; font-weight:700; letter-spacing:.08em; text-transform:uppercase; color:var(--muted); }
  h1 { font-size: 30px; line-height:1.25; margin: 0 0 8px; letter-spacing:-.02em; }
  .meta { color: var(--faint); font-size: 13px; display:flex; flex-wrap:wrap; gap:6px 14px; }
  .meta strong { color: var(--muted); font-weight:600; }

  .block { margin-bottom: 30px; break-inside: avoid; }
  h2 { font-size: 12px; text-transform: uppercase; letter-spacing:.09em; color: var(--faint);
       margin: 0 0 12px; padding-bottom:7px; border-bottom:1px solid var(--line); }
  .lede { font-size: 16px; line-height:1.7; margin:0; color:var(--ink); white-space: pre-line; }

  ol.findings { list-style:none; counter-reset:f; padding:0; margin:0;
    display:grid; gap:12px; }
  ol.findings li { counter-increment:f; position:relative; padding:14px 16px 14px 46px;
    background:var(--panel); border-radius:10px; border-left:3px solid var(--brand); }
  ol.findings li::before { content: counter(f); position:absolute; left:16px; top:14px;
    width:20px; height:20px; border-radius:50%; background:var(--brand); color:#fff;
    font-size:11px; font-weight:700; display:grid; place-items:center; }
  ol.findings h3 { margin:0 0 3px; font-size:14px; }
  ol.findings p { margin:0; font-size:13.5px; color:var(--muted); }

  .kpis { display:grid; grid-template-columns:repeat(auto-fit,minmax(150px,1fr)); gap:12px; }
  .kpi, .cmp { border:1px solid var(--line); border-top:3px solid var(--brand);
    border-radius:10px; padding:13px 15px; background:#fff; }
  .kpi-label { display:block; font-size:10.5px; text-transform:uppercase; letter-spacing:.05em; color:var(--faint); }
  .kpi-value { display:block; font-size:25px; font-weight:700; margin-top:5px; letter-spacing:-.02em; }

  .cmp { border-top-color: var(--faint); }
  .cmp-good { border-top-color:#157f45; }
  .cmp-bad { border-top-color:#c02626; }
  .cmp-delta { display:block; margin-top:4px; font-size:12.5px; font-weight:600; color:var(--muted); }
  .cmp-abs { font-weight:400; color:var(--faint); }
  .cmp-base { display:block; margin-top:2px; font-size:11.5px; color:var(--faint); }

  figure.chart { margin:0; padding:16px; border:1px solid var(--line); border-radius:10px; break-inside:avoid; }
  figcaption { font-size:13px; font-weight:600; margin-bottom:4px; }
  .lbl { font-size:11px; fill:var(--muted); }
  .val { font-size:11px; fill:var(--faint); font-weight:600; }
  .axis { font-size:10px; fill:var(--faint); }
  .grid { stroke:var(--line); stroke-width:1; }
  .donut-wrap { display:flex; gap:24px; align-items:center; flex-wrap:wrap; }
  .donut-total { font-size:20px; font-weight:700; text-anchor:middle; fill:var(--ink); }
  .donut-cap { font-size:9px; text-anchor:middle; fill:var(--faint); text-transform:uppercase; letter-spacing:.08em; }
  ul.legend { list-style:none; padding:0; margin:0; flex:1; min-width:200px; }
  ul.legend li { display:flex; align-items:center; gap:8px; padding:3px 0; font-size:12.5px; }
  .swatch { width:10px; height:10px; border-radius:3px; flex:none; }
  .lg-label { flex:1; color:var(--ink); }
  .lg-val { color:var(--faint); font-variant-numeric:tabular-nums; }

  .note { font-size:12px; color:var(--faint); margin:0 0 10px; }
  table { width:100%; border-collapse:collapse; font-size:12px; }
  th { text-align:left; font-size:10px; text-transform:uppercase; letter-spacing:.05em;
       color:var(--faint); border-bottom:2px solid var(--line); padding:8px 9px; }
  td { padding:7px 9px; border-bottom:1px solid var(--line-soft); }
  th.num, td.num { text-align:right; font-variant-numeric:tabular-nums; }
  td.rk-pos { width:28px; color:var(--faint); font-weight:700; }
  tbody tr:nth-child(even) { background:var(--panel); }

  ul.actions, ul.insights { margin:0; padding-left:20px; }
  ul.actions li, ul.insights li { margin-bottom:6px; }
  .caveat { border:1px solid #f0d9a8; background:#fdf8ec; border-radius:10px; padding:14px 16px; }
  .caveat h2 { border:0; color:#8a6d1f; margin-bottom:6px; padding:0; }
  .caveat ul { margin:0; padding-left:18px; font-size:13px; color:#6b5518; }

  footer { margin-top:36px; padding-top:14px; border-top:1px solid var(--line);
    font-size:11px; color:var(--faint); display:flex; justify-content:space-between; gap:12px; }

  @media print {
    .page { max-width:none; padding:0; }
    @page { margin: 14mm; }
    body { font-size:11.5pt; }
    h1 { font-size:22pt; }
    figure.chart, .block, ol.findings li { break-inside: avoid; }
    thead { display: table-header-group; }
  }
  @media (max-width: 640px) { .page { padding:24px 18px 40px; } h1 { font-size:24px; } }
</style></head>
<body><div class="page">
  <header class="mast">
    <div class="brand"><span class="brand-dot"></span><span class="brand-name">${esc(brandName)}</span></div>
    <h1>${esc(title)}</h1>
    <div class="meta">
      <span><strong>${esc(sourceLabel)}</strong></span>
      <span>${esc(result.rowCount.toLocaleString())} rows</span>
      <span>${esc(printed)}</span>
    </div>
  </header>
  ${summary}
  ${findings}
  ${body}
  ${recommendations}
  ${omitted}
  <footer>
    <span>${esc(brandName)} · ${esc(sourceLabel)}</span>
    <span>Every figure computed from Dynamics 365 — not generated by AI.</span>
  </footer>
</div></body></html>`;
}
