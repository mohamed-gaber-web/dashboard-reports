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
