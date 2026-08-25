import { describe, expect, it } from 'vitest';
import { Analysis } from '../models/analysis.model';
import { DEFAULT_DESIGN, ReportResult } from '../models/report-spec.model';
import { DocumentInput, buildDocument, documentTitle } from './document-builder';

const result: ReportResult = {
  title: 'Serial transactions',
  description: 'Open movements',
  design: DEFAULT_DESIGN,
  rowCount: 11204,
  kpis: [
    { label: 'Transactions', value: '11,204' },
    { label: 'Items', value: '1,847' },
  ],
  charts: [
    {
      type: 'bar',
      title: 'By site',
      data: [
        { label: 'Site A', value: 500 },
        { label: 'Site B', value: 250 },
      ],
    },
    {
      type: 'donut',
      title: 'By status',
      data: [
        { label: 'Open', value: 60 },
        { label: 'Closed', value: 40 },
      ],
    },
  ],
  table: {
    columns: [
      { key: 'id', header: 'ID' },
      { key: 'qty', header: 'Qty' },
    ],
    displayRows: [{ id: 'S-1', qty: 5 }],
    total: 11204,
    displayLimit: 100,
  } as unknown as ReportResult['table'],
};

const analysis: Analysis = {
  headline: 'Movement concentrated in three sites',
  summary: 'Most transactions originate from a small number of sites.',
  findings: [
    { title: 'Site A dominates', detail: 'It accounts for the largest share of movement.' },
  ],
  recommendations: ['Review Site A staffing'],
};

const base: DocumentInput = {
  result,
  analysis,
  sourceLabel: 'Shatat · Serial Transactions',
  brandName: 'Shatat',
};

describe('buildDocument', () => {
  it('is a complete standalone document', () => {
    const html = buildDocument(base);
    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html).toContain('</html>');
    // Self-contained: no external stylesheet, script or image can be requested.
    expect(html).not.toMatch(/<link[^>]+href/i);
    expect(html).not.toMatch(/<script/i);
  });

  it('leads with the analysis, then the evidence', () => {
    const html = buildDocument(base);
    expect(html.indexOf('Summary')).toBeLessThan(html.indexOf('At a glance'));
    expect(html.indexOf('Key findings')).toBeLessThan(html.indexOf('Detail'));
    expect(html).toContain('Movement concentrated in three sites');
    expect(html).toContain('Site A dominates');
    expect(html).toContain('Review Site A staffing');
  });

  it('titles the document with the analysis headline when there is one', () => {
    expect(documentTitle(base)).toBe('Movement concentrated in three sites');
    expect(documentTitle({ ...base, analysis: null })).toBe('Serial transactions');
  });

  it('renders charts as inline SVG, not as component markup', () => {
    const html = buildDocument(base);
    expect(html).toContain('<svg');
    expect(html).toContain('<rect'); // bar
    expect(html).toContain('<circle'); // donut
    expect(html).not.toContain('app-bar-chart');
  });

  it('resolves palette colours to literals, never CSS variables', () => {
    // A var() reference would resolve to nothing in a detached document.
    const svg = buildDocument(base);
    const fills = svg.match(/fill="([^"]+)"/g) ?? [];
    expect(fills.length).toBeGreaterThan(0);
    expect(fills.some((f) => f.includes('var('))).toBe(false);
  });

  it('says how much of the table it is showing', () => {
    const html = buildDocument(base);
    expect(html).toContain('Showing the first 1 of 11,204 matching rows');
  });

  it('states when the table is complete', () => {
    const small = {
      ...base,
      result: { ...result, table: { ...result.table!, total: 1 } },
    };
    expect(buildDocument(small)).toContain('All 1 matching rows');
  });

  it('carries omitted clauses into the document', () => {
    const html = buildDocument({
      ...base,
      result: { ...result, omitted: ['Unknown field "Foo"'] },
    });
    expect(html).toContain('Not included');
    expect(html).toContain('Unknown field &quot;Foo&quot;');
  });

  it('escapes hostile content from every source', () => {
    const html = buildDocument({
      ...base,
      brandName: '<script>a</script>',
      sourceLabel: '<img src=x>',
      analysis: {
        headline: '<script>b</script>',
        summary: '<b>c</b>',
        findings: [{ title: '<i>d</i>', detail: '<u>e</u>' }],
        recommendations: ['<em>f</em>'],
      },
    });
    // The only tags present are ones the builder wrote itself.
    expect(html).not.toContain('<script>a');
    expect(html).not.toContain('<script>b');
    expect(html).not.toContain('<img src=x>');
    expect(html).not.toContain('<b>c</b>');
    expect(html).not.toContain('<i>d</i>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('works with an analysis and no computed report', () => {
    const html = buildDocument({
      ...base,
      result: { title: 'Analysis', design: DEFAULT_DESIGN, rowCount: 0, kpis: [], charts: [] },
    });
    expect(html).toContain('Movement concentrated in three sites');
    expect(html).not.toContain('At a glance');
  });

  it('works with a report and no analysis', () => {
    const html = buildDocument({ ...base, analysis: null });
    expect(html).toContain('At a glance');
    expect(html).not.toContain('Key findings');
    expect(html).toContain('Serial transactions');
  });

  it('omits a chart that has no data rather than drawing an empty frame', () => {
    const html = buildDocument({
      ...base,
      result: { ...result, charts: [{ type: 'bar', title: 'Empty', data: [] }] },
    });
    expect(html).not.toContain('Empty');
  });
});

/**
 * The document has to be the report the user just read — same sections, same
 * order. A builder that rendered a fixed KPI/chart/table sequence while the
 * screen showed a ranking and two paragraphs would put the divergence in the
 * one artefact that gets forwarded to other people.
 */
describe('buildDocument — dynamic sections', () => {
  function withBlocks(blocks: ReportResult['blocks']): DocumentInput {
    return { ...base, analysis: null, result: { ...result, blocks, kpis: [], charts: [], table: undefined } };
  }

  it('renders blocks in the order the model chose', () => {
    const html = buildDocument(
      withBlocks([
        { kind: 'text', title: 'What happened', body: 'Deliveries slipped at two sites.' },
        { kind: 'list', variant: 'insights', items: ['Site A is over half the shortfall.'] },
      ]),
    );
    expect(html.indexOf('What happened')).toBeLessThan(html.indexOf('What this shows'));
    expect(html).toContain('Deliveries slipped at two sites.');
    expect(html).toContain('Site A is over half the shortfall.');
  });

  it('renders only what the report contained', () => {
    const html = buildDocument(withBlocks([{ kind: 'text', body: 'Just a sentence.' }]));
    expect(html).not.toContain('At a glance');
    expect(html).not.toContain('Detail');
  });

  it('prints a ranking with its positions, figures and shares', () => {
    const html = buildDocument(
      withBlocks([
        {
          kind: 'ranking',
          title: 'Top sites',
          measureLabel: 'Amount',
          chart: true,
          rows: [
            { rank: 1, label: 'Site A', value: 100, display: '100', sharePct: 62, widthPct: 100 },
            { rank: 2, label: 'Site B', value: 60, display: '60', sharePct: 38, widthPct: 60 },
          ],
        },
      ]),
    );
    expect(html).toContain('Top sites');
    expect(html).toContain('Site A');
    expect(html).toContain('62%');
  });

  it('prints a comparison with both periods and the change', () => {
    const html = buildDocument(
      withBlocks([
        {
          kind: 'comparison',
          currentLabel: 'Q2 2025',
          previousLabel: 'Q1 2025',
          items: [
            {
              label: 'Lines',
              current: '25',
              previous: '20',
              delta: '+5',
              deltaPercent: 25,
              direction: 'up',
              sentiment: 'bad',
            },
          ],
        },
      ]),
    );
    expect(html).toContain('Q2 2025 vs Q1 2025');
    expect(html).toContain('+25%');
    expect(html).toContain('Q1 2025: 20');
    // Sentiment is a class, never a raw colour the model chose.
    expect(html).toContain('cmp-bad');
  });

  it('draws a line chart as SVG geometry, not a bar', () => {
    const html = buildDocument(
      withBlocks([
        {
          kind: 'chart',
          chart: {
            type: 'line',
            title: 'Lines per month',
            ordered: true,
            data: [
              { label: 'Jan 2025', value: 2 },
              { label: 'Feb 2025', value: 4 },
            ],
            labels: ['Jan 2025', 'Feb 2025'],
            series: [{ label: 'Lines per month', values: [2, 4] }],
          },
        },
      ]),
    );
    expect(html).toContain('<polyline');
    expect(html).toContain('Jan 2025');
  });

  it('escapes model prose in every new section', () => {
    const html = buildDocument(
      withBlocks([
        { kind: 'text', title: '<i>t</i>', body: '<script>x</script>' },
        { kind: 'list', variant: 'recommendations', items: ['<img src=y>'] },
        {
          kind: 'ranking',
          title: 'R',
          measureLabel: '<b>m</b>',
          chart: false,
          rows: [{ rank: 1, label: '<u>l</u>', value: 1, display: '1', sharePct: 100, widthPct: 100 }],
        },
      ]),
    );
    expect(html).not.toContain('<script>x');
    expect(html).not.toContain('<img src=y>');
    expect(html).not.toContain('<u>l</u>');
    expect(html).not.toContain('<b>m</b>');
  });
});
