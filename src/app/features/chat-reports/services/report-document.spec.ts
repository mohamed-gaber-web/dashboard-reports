import { describe, expect, it } from 'vitest';
import { ReportPayload } from '../models/report-payload.model';
import {
  ReportDocumentInput,
  buildReportDocument,
  provenanceLine,
  reportDocumentTitle,
} from './report-document';

/**
 * The exported document is the copy that gets forwarded to someone who never
 * saw the screen. Two properties therefore matter more than layout: the
 * provenance caveat survives, and model-authored text cannot inject markup.
 */
const payload: ReportPayload = {
  text_response: 'Stock is concentrated in two warehouses.',
  suggested_actions: ['Break down by site'],
  template_type: 'kpi_overview',
  components: [
    {
      type: 'kpi_grid',
      items: [
        { label: 'On hand', value: '12,480' },
        { label: 'Reserved', value: '1,204', change: '-8.2%', isPositive: true },
      ],
    },
    {
      type: 'chart',
      chart_type: 'bar',
      title: 'On hand by warehouse',
      labels: ['100-A', '200-B'],
      datasets: [{ label: 'On hand', data: [8000, 4480] }],
    },
    {
      type: 'table',
      title: 'Top items',
      headers: ['Item', 'On hand'],
      rows: [['10-1001', '422']],
    },
  ],
  dropped: [],
};

const base: ReportDocumentInput = {
  payload,
  question: 'Which warehouses hold the most stock?',
  sourceLabel: 'Inventory',
  groundedRows: 787,
  brandName: 'Shatat',
};

describe('buildReportDocument', () => {
  it('is a complete standalone document', () => {
    const html = buildReportDocument(base);
    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html).toContain('</html>');
    // Self-contained: nothing external can be requested when it is opened from
    // a blob: URL or a detached print window.
    expect(html).not.toMatch(/<link[^>]+href/i);
    expect(html).not.toMatch(/<script/i);
  });

  it('states the provenance caveat twice — masthead and footer', () => {
    const html = buildReportDocument(base);
    const line = provenanceLine(787);
    expect(line).toContain('written by AI');
    expect(line).toContain('787');
    expect(line).toContain('not recomputed');
    // Once where it is read first, once where it is read last.
    expect(html.split('Figures written by AI').length - 1).toBe(2);
  });

  it('says so when the answer was not grounded at all', () => {
    const html = buildReportDocument({ ...base, groundedRows: null });
    expect(html).toContain('no dataset was attached');
  });

  it('titles the document with the question that produced it', () => {
    expect(reportDocumentTitle(base)).toBe('Which warehouses hold the most stock?');
    // A chip-driven turn can arrive with no preceding question text.
    expect(reportDocumentTitle({ ...base, question: '  ' })).toBe('Inventory report');
  });

  it('renders every component kind in the order the model chose', () => {
    const html = buildReportDocument(base);
    expect(html.indexOf('At a glance')).toBeLessThan(html.indexOf('On hand by warehouse'));
    expect(html.indexOf('On hand by warehouse')).toBeLessThan(html.indexOf('Top items'));
    expect(html).toContain('12,480');
    expect(html).toContain('10-1001');
  });

  it('draws charts as inline SVG, never as component markup', () => {
    const html = buildReportDocument(base);
    expect(html).toContain('<svg');
    expect(html).toContain('<rect');
    expect(html).not.toContain('app-chart-widget');
    // A var() would resolve to nothing in a detached document.
    expect(html).not.toContain('var(--color-chart');
  });

  it('colours a KPI change by whether it is GOOD, not whether it is positive', () => {
    // "-8.2%" with isPositive:true is falling reserved stock — an improvement.
    expect(buildReportDocument(base)).toContain('kpi-change kpi-good');
  });

  it('draws a doughnut with a hole and a pie without one', () => {
    const slice = (chart_type: 'pie' | 'doughnut'): ReportPayload => ({
      ...payload,
      components: [
        {
          type: 'chart',
          chart_type,
          title: 'Share',
          labels: ['A', 'B'],
          datasets: [{ label: 'Share', data: [60, 40] }],
        },
      ],
    });
    // Match the ELEMENT, not the bare class name — the inlined stylesheet
    // declares `.donut-total` in both documents, so the loose string is true
    // either way and the test would never fail.
    const centreLabel = 'class="donut-total"';
    expect(buildReportDocument({ ...base, payload: slice('doughnut') })).toContain(centreLabel);
    expect(buildReportDocument({ ...base, payload: slice('pie') })).not.toContain(centreLabel);
  });

  it('omits a chart with no data rather than printing an empty frame', () => {
    const html = buildReportDocument({
      ...base,
      payload: {
        ...payload,
        components: [
          { type: 'chart', chart_type: 'bar', title: 'Nothing here', labels: [], datasets: [] },
        ],
      },
    });
    expect(html).not.toContain('Nothing here');
  });

  it('carries dropped notices into the document', () => {
    const html = buildReportDocument({
      ...base,
      payload: { ...payload, dropped: ['A chart series was trimmed to match its labels.'] },
    });
    expect(html).toContain('Not included');
    expect(html).toContain('trimmed to match');
  });

  it('escapes model-authored text everywhere it appears', () => {
    const html = buildReportDocument({
      ...base,
      question: '<script>q</script>',
      brandName: '<img src=x>',
      sourceLabel: '<b>src</b>',
      payload: {
        ...payload,
        text_response: '<script>t</script>',
        dropped: ['<i>d</i>'],
        components: [
          { type: 'kpi_grid', items: [{ label: '<u>l</u>', value: '<em>v</em>' }] },
          {
            type: 'chart',
            chart_type: 'pie',
            title: '<b>c</b>',
            labels: ['<span>s</span>'],
            datasets: [{ label: 'x', data: [1] }],
          },
          { type: 'table', title: '<b>t</b>', headers: ['<i>h</i>'], rows: [['<u>r</u>']] },
        ],
      },
    });
    for (const injected of [
      '<script>q',
      '<script>t',
      '<img src=x>',
      '<b>src</b>',
      '<u>l</u>',
      '<em>v</em>',
      '<b>c</b>',
      '<span>s</span>',
      '<i>h</i>',
      '<u>r</u>',
      '<i>d</i>',
    ]) {
      expect(html).not.toContain(injected);
    }
    expect(html).toContain('&lt;script&gt;');
  });

  it('plots every series of a multi-series chart, with a legend', () => {
    const html = buildReportDocument({
      ...base,
      payload: {
        ...payload,
        components: [
          {
            type: 'chart',
            chart_type: 'line',
            title: 'Two series',
            labels: ['Jan', 'Feb'],
            datasets: [
              { label: 'On hand', data: [1, 2] },
              { label: 'Reserved', data: [3, 4] },
            ],
          },
        ],
      },
    });
    expect((html.match(/<polyline/g) ?? []).length).toBe(2);
    expect(html).toContain('Reserved');
    expect(html).toContain('legend-row');
  });
});
