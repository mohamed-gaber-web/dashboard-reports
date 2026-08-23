import { Analysis } from '../models/analysis.model';
import { ChartResult, ReportResult, reportColor } from '../models/report-spec.model';

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
 * A report can now carry its own palette (`design.palette` — a single-hue ramp
 * for "make it one colour"), and those colours are CSS variables and
 * `color-mix()` expressions so the app can re-theme them at runtime. Neither
 * survives in an exported file, and the exporter's index-based palette ignored
 * `datum.color` entirely — so a recoloured report printed in the ORIGINAL
 * colours, which is the sort of drift nobody notices until a client sees the PDF.
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

/** A horizontal bar chart as standalone SVG. */
function barSvg(chart: ChartResult, palette: string[], resolve: (v?: string) => string | undefined): string {
  const data = chart.data.slice(0, 12);
  if (!data.length) return '';
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
      const fill = resolve(d.color) ?? palette[i % palette.length];
      return (
        `<text x="0" y="${y + 13}" class="lbl">${esc(label)}</text>` +
        `<rect x="${labelW}" y="${y + 3}" width="${w}" height="14" rx="3" fill="${fill}"/>` +
        `<text x="${labelW + w + 6}" y="${y + 13}" class="val">${esc(d.value.toLocaleString())}</text>`
      );
    })
    .join('');

  return `<svg viewBox="0 0 ${labelW + barW + 70} ${height}" width="100%" height="${height}" role="img">${rows}</svg>`;
}

/** A donut chart as standalone SVG, with a legend. */
function donutSvg(chart: ChartResult, palette: string[], resolve: (v?: string) => string | undefined): string {
  const data = chart.data.slice(0, 8);
  const total = data.reduce((sum, d) => sum + d.value, 0);
  if (!total) return '';

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
        `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${resolve(d.color) ?? palette[i % palette.length]}" ` +
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
        `<li><span class="swatch" style="background:${resolve(d.color) ?? palette[i % palette.length]}"></span>` +
        `<span class="lg-label">${esc(label)}</span>` +
        `<span class="lg-val">${esc(d.value.toLocaleString())} · ${pct}%</span></li>`
      );
    })
    .join('');

  return (
    `<div class="donut-wrap">` +
    `<svg viewBox="0 0 180 180" width="180" height="180" role="img">${arcs}` +
    `<text x="${cx}" y="${cy - 2}" class="donut-total">${esc(total.toLocaleString())}</text>` +
    `<text x="${cx}" y="${cy + 14}" class="donut-cap">total</text></svg>` +
    `<ul class="legend">${legend}</ul></div>`
  );
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
 * Order is deliberate and matches how the document is read: what it means
 * (summary, findings), then the evidence (KPIs, charts), then the detail (table),
 * then what to do about it (recommendations).
 */
export function buildDocument(input: DocumentInput): string {
  const { result, analysis, sourceLabel, brandName } = input;
  const palette = resolvePalette();
  const { resolve, done: releaseProbe } = colorResolver();
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
        .map(
          (f) =>
            `<li><h3>${esc(f.title)}</h3><p>${esc(f.detail)}</p></li>`,
        )
        .join('') +
      `</ol></section>`
    : '';

  const kpis = result.kpis.length
    ? `<section class="block"><h2>At a glance</h2><div class="kpis">` +
      result.kpis
        .map(
          (k, i) =>
            `<div class="kpi" style="border-top-color:${resolve(reportColor(result.design.palette, i)) ?? palette[i % palette.length]}">` +
            `<span class="kpi-label">${esc(k.label)}</span>` +
            `<span class="kpi-value">${esc(k.value)}</span></div>`,
        )
        .join('') +
      `</div></section>`
    : '';

  const charts = result.charts.length
    ? `<section class="block"><h2>Breakdown</h2>` +
      result.charts
        .map((c) => {
          const body =
            c.type === 'donut' ? donutSvg(c, palette, resolve) : barSvg(c, palette, resolve);
          if (!body) return '';
          return `<figure class="chart"><figcaption>${esc(c.title)}</figcaption>${body}</figure>`;
        })
        .join('') +
      `</section>`
    : '';

  releaseProbe();

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
    // Say what this table is. It is a page of the answer, not the answer.
    const note =
      t.total > t.displayRows.length
        ? `<p class="note">Showing the first ${t.displayRows.length.toLocaleString()} of ` +
          `${t.total.toLocaleString()} matching rows. Export to CSV for the complete set.</p>`
        : `<p class="note">All ${t.total.toLocaleString()} matching rows.</p>`;
    table =
      `<section class="block"><h2>Detail</h2>${note}` +
      `<table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></section>`;
  }

  const recommendations = analysis?.recommendations?.length
    ? `<section class="block"><h2>Recommended actions</h2><ul class="actions">` +
      analysis.recommendations.map((r) => `<li>${esc(r)}</li>`).join('') +
      `</ul></section>`
    : '';

  // Anything the compiler refused belongs in the document too — a shared report
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
  .lede { font-size: 16px; line-height:1.7; margin:0; color:var(--ink); }

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
  .kpi { border:1px solid var(--line); border-top:3px solid var(--brand);
    border-radius:10px; padding:13px 15px; background:#fff; }
  .kpi-label { display:block; font-size:10.5px; text-transform:uppercase; letter-spacing:.05em; color:var(--faint); }
  .kpi-value { display:block; font-size:25px; font-weight:700; margin-top:5px; letter-spacing:-.02em; }

  figure.chart { margin:0 0 20px; padding:16px; border:1px solid var(--line); border-radius:10px; break-inside:avoid; }
  figcaption { font-size:13px; font-weight:600; margin-bottom:12px; }
  .lbl { font-size:11px; fill:var(--muted); }
  .val { font-size:11px; fill:var(--faint); font-weight:600; }
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
  tbody tr:nth-child(even) { background:var(--panel); }

  ul.actions { margin:0; padding-left:20px; }
  ul.actions li { margin-bottom:6px; }
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
  ${kpis}
  ${charts}
  ${table}
  ${recommendations}
  ${omitted}
  <footer>
    <span>${esc(brandName)} · ${esc(sourceLabel)}</span>
    <span>Every figure computed from Dynamics 365 — not generated by AI.</span>
  </footer>
</div></body></html>`;
}
