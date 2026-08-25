import { describe, expect, it } from 'vitest';
import { AnalystSource } from '../models/analyst-source.model';
import { FieldMeta } from '../models/field-meta.model';
import { ReportSpec } from '../models/report-spec.model';
import { planReport } from './report-plan';

/**
 * The planner is the seam where LLM output becomes app behaviour, so these
 * tests are mostly about what it REFUSES. Two behaviours matter and are easy to
 * get wrong: a clause that cannot mean anything is dropped WITH A REASON, and a
 * clause whose intent is clear but whose form is wrong is rewritten and the
 * rewrite is declared. Silence in either direction is the bug.
 */
const fields: FieldMeta[] = [
  { key: 'Site', label: 'Site', type: 'string', format: 'text', dimension: true },
  { key: 'ItemId', label: 'Item', type: 'string', format: 'text', dimension: true },
  { key: 'Name', label: 'Description', type: 'string', format: 'text' },
  { key: 'Amount', label: 'Amount', type: 'number', format: 'currency', measure: true },
  { key: 'Qty', label: 'Quantity', type: 'number', format: 'quantity', measure: true },
  { key: 'DeliveryDate', label: 'Delivery date', type: 'date', format: 'date' },
];

const source: AnalystSource = {
  id: 's',
  label: 'S',
  fields,
  suggestions: [],
  entity: 'E',
  dataPath: '/data',
  authConfig: {} as AnalystSource['authConfig'],
  crossCompany: false,
  baseFilter: '',
  keyField: ['Id'],
  select: '',
  searchFields: [],
  dateField: 'DeliveryDate',
};

function plan(sections: unknown[], spec: Partial<ReportSpec> = {}) {
  return planReport({ title: 'T', sections, ...spec } as ReportSpec, source);
}

describe('planReport — vocabulary', () => {
  it('drops a section type it does not know, and says so', () => {
    const { sections, omitted } = plan([{ type: 'heatmap', title: 'Nope' }]);
    expect(sections).toEqual([]);
    expect(omitted[0]).toContain('heatmap');
  });

  it('keeps the model’s section ORDER — that is the whole point of the list', () => {
    const { sections } = plan([
      { type: 'text', body: 'Because deliveries slipped.' },
      { type: 'metrics', items: [{ label: 'Lines', agg: 'count' }] },
      { type: 'insights', points: ['One site accounts for most of it.'] },
    ]);
    expect(sections.map((s) => s.type)).toEqual(['text', 'metrics', 'insights']);
  });
});

describe('planReport — metrics', () => {
  it('accepts a count with no field', () => {
    const { sections } = plan([{ type: 'metrics', items: [{ label: 'Lines', agg: 'count' }] }]);
    expect(sections[0]).toMatchObject({ type: 'metrics', items: [{ agg: 'count' }] });
  });

  it('refuses to sum a field that is not a measure', () => {
    // Summing a site code produces a confident, meaningless total.
    const { sections, omitted } = plan([
      { type: 'metrics', items: [{ label: 'Total site', agg: 'sum', field: 'Site' }] },
    ]);
    expect(sections).toEqual([]);
    expect(omitted[0]).toContain('not a measure');
  });

  it('refuses a measure the entity does not have', () => {
    const { omitted } = plan([
      { type: 'metrics', items: [{ label: 'Revenue', agg: 'sum', field: 'Ghost' }] },
    ]);
    expect(omitted[0]).toContain('Ghost');
  });

  it('inherits the field’s own format when the model gives none', () => {
    const { sections } = plan([
      { type: 'metrics', items: [{ label: 'Value', agg: 'sum', field: 'Amount' }] },
    ]);
    expect(sections[0]).toMatchObject({ items: [{ format: 'currency' }] });
  });
});

describe('planReport — charts', () => {
  it('drops a chart grouped by an unknown field', () => {
    const { sections, omitted } = plan([
      { type: 'chart', title: 'By ghost', chartType: 'bar', groupBy: 'Ghost', agg: 'count' },
    ]);
    expect(sections).toEqual([]);
    expect(omitted[0]).toContain('Ghost');
  });

  it('drops a chart grouped by a field that is not a dimension', () => {
    const { omitted } = plan([
      { type: 'chart', title: 'By description', chartType: 'bar', groupBy: 'Name', agg: 'count' },
    ]);
    expect(omitted[0]).toContain('not a grouping field');
  });

  it('rewrites a line over nominal categories as a bar, and declares the swap', () => {
    // A line asserts that the space between points means something. Over sites
    // it means nothing, so drawing it would be a claim the data cannot support.
    const { sections, omitted } = plan([
      { type: 'chart', title: 'By site', chartType: 'line', groupBy: 'Site', agg: 'count' },
    ]);
    expect(sections[0]).toMatchObject({ chartType: 'bar' });
    expect(omitted[0]).toContain('bar chart instead');
  });

  it('rewrites a donut over a date as a line', () => {
    const { sections, omitted } = plan([
      { type: 'chart', title: 'Over time', chartType: 'donut', groupBy: 'DeliveryDate', agg: 'count' },
    ]);
    expect(sections[0]).toMatchObject({ chartType: 'line' });
    expect(omitted[0]).toContain('line chart instead');
  });

  it('defaults a date grouping to a line, and a nominal one to a bar', () => {
    const { sections } = plan([
      { type: 'chart', title: 'A', groupBy: 'DeliveryDate', agg: 'count' },
      { type: 'chart', title: 'B', groupBy: 'Site', agg: 'count' },
    ]);
    expect(sections[0]).toMatchObject({ chartType: 'line', grain: 'auto' });
    expect(sections[1]).toMatchObject({ chartType: 'bar', grain: undefined });
  });

  it('drops a chart that totals a non-measure', () => {
    const { sections, omitted } = plan([
      { type: 'chart', title: 'X', chartType: 'bar', groupBy: 'Site', agg: 'sum', valueField: 'ItemId' },
    ]);
    expect(sections).toEqual([]);
    expect(omitted[0]).toContain('not a measure');
  });
});

describe('planReport — ranking', () => {
  it('caps topN so a "ranking" stays a ranking', () => {
    const { sections } = plan([
      { type: 'ranking', title: 'Top items', groupBy: 'ItemId', agg: 'sum', valueField: 'Qty', topN: 500 },
    ]);
    expect(sections[0]).toMatchObject({ topN: 20 });
  });

  it('defaults to ten rows with a bar', () => {
    const { sections } = plan([{ type: 'ranking', title: 'Top', groupBy: 'Site', agg: 'count' }]);
    expect(sections[0]).toMatchObject({ topN: 10, chart: true });
  });

  it('drops a ranking of something that cannot be grouped', () => {
    const { omitted } = plan([{ type: 'ranking', title: 'Top', groupBy: 'Amount', agg: 'count' }]);
    expect(omitted[0]).toContain('not a grouping field');
  });
});

describe('planReport — comparison', () => {
  /** The wire format: six flat strings. See `planPeriod` for why it is not nested. */
  const periods = {
    currentLabel: 'Q2',
    currentFrom: '2025-04-01',
    currentTo: '2025-06-30',
    previousLabel: 'Q1',
    previousFrom: '2025-01-01',
    previousTo: '2025-03-31',
  };

  it('reads the flat six-string form', () => {
    const { sections } = plan([
      { type: 'comparison', ...periods, metrics: [{ label: 'Lines', agg: 'count' }] },
    ]);
    expect(sections[0]).toMatchObject({
      current: { label: 'Q2', from: '2025-04-01', to: '2025-06-30' },
      previous: { label: 'Q1', from: '2025-01-01', to: '2025-03-31' },
    });
  });

  it('still reads the nested form, so an older spec keeps rendering', () => {
    const { sections } = plan([
      {
        type: 'comparison',
        current: { label: 'Q2', from: '2025-04-01', to: '2025-06-30' },
        previous: { label: 'Q1', from: '2025-01-01', to: '2025-03-31' },
        metrics: [{ label: 'Lines', agg: 'count' }],
      },
    ]);
    expect(sections[0]).toMatchObject({ current: { label: 'Q2', from: '2025-04-01' } });
  });

  it('falls back to the source’s own date field', () => {
    const { sections } = plan([
      { type: 'comparison', ...periods, metrics: [{ label: 'Lines', agg: 'count' }] },
    ]);
    expect(sections[0]).toMatchObject({ type: 'comparison', dateField: 'DeliveryDate' });
  });

  it('drops a comparison cut on something that is not a date', () => {
    const { sections, omitted } = plan([
      { type: 'comparison', dateField: 'Site', ...periods, metrics: [{ label: 'L', agg: 'count' }] },
    ]);
    expect(sections).toEqual([]);
    expect(omitted[0]).toContain('not a date field');
  });

  it('accepts a period written as a month or a quarter', () => {
    // Observed live: a model asked to compare August with July writes "2025-08"
    // roughly as often as "2025-08-01". Losing the section over that would cost
    // the user the entire answer, since a comparison is usually the only one.
    const { sections } = plan([
      {
        type: 'comparison',
        currentLabel: 'August',
        currentFrom: '2025-08',
        previousLabel: 'Q1',
        previousFrom: '2025-Q1',
        metrics: [{ label: 'Lines', agg: 'count' }],
      },
    ]);
    expect(sections[0]).toMatchObject({
      current: { from: '2025-08-01', to: '2025-08-31' },
      previous: { from: '2025-01-01', to: '2025-03-31' },
    });
  });

  it('will not invent a month around a single day', () => {
    // The opposite forgiveness would be a guess presented as a measurement.
    const { sections, omitted } = plan([
      {
        type: 'comparison',
        currentLabel: 'August',
        currentTo: '2025-08-31',
        previousLabel: periods.previousLabel,
        previousFrom: periods.previousFrom,
        previousTo: periods.previousTo,
        metrics: [{ label: 'Lines', agg: 'count' }],
      },
    ]);
    expect(sections).toEqual([]);
    expect(omitted[0]).toContain('YYYY-MM-DD');
  });

  it('drops a comparison whose periods are not real dates', () => {
    const { sections, omitted } = plan([
      {
        type: 'comparison',
        ...periods,
        currentFrom: 'last month',
        currentTo: 'today',
        metrics: [{ label: 'L', agg: 'count' }],
      },
    ]);
    expect(sections).toEqual([]);
    expect(omitted[0]).toContain('YYYY-MM-DD');
  });

  it('normalises a reversed range rather than matching nothing', () => {
    const { sections } = plan([
      {
        type: 'comparison',
        ...periods,
        currentFrom: '2025-06-30',
        currentTo: '2025-04-01',
        metrics: [{ label: 'L', agg: 'count' }],
      },
    ]);
    expect(sections[0]).toMatchObject({ current: { from: '2025-04-01', to: '2025-06-30' } });
  });

  it('refuses a distinct count over a period — the cube cannot answer it', () => {
    const { sections, omitted } = plan([
      {
        type: 'comparison',
        ...periods,
        metrics: [
          { label: 'Sites', agg: 'distinctCount', field: 'Site' },
          { label: 'Lines', agg: 'count' },
        ],
      },
    ]);
    expect(sections[0]).toMatchObject({ metrics: [{ label: 'Lines' }] });
    expect(omitted.some((o) => o.includes('distinct counts cannot be measured'))).toBe(true);
  });

  it('carries higherIsBetter only when it is a real boolean', () => {
    const { sections } = plan([
      {
        type: 'comparison',
        ...periods,
        metrics: [
          { label: 'A', agg: 'count', higherIsBetter: true },
          { label: 'B', agg: 'count', higherIsBetter: 'yes' },
        ],
      },
    ]);
    const section = sections[0] as { metrics: { higherIsBetter?: boolean }[] };
    expect(section.metrics[0].higherIsBetter).toBe(true);
    expect(section.metrics[1].higherIsBetter).toBeUndefined();
  });
});

describe('planReport — table, text and lists', () => {
  it('keeps the columns it knows and names the ones it does not', () => {
    const { sections, omitted } = plan([{ type: 'table', columns: ['Site', 'Ghost', 'Qty'] }]);
    expect(sections[0]).toMatchObject({ columns: ['Site', 'Qty'] });
    expect(omitted[0]).toContain('Ghost');
  });

  it('drops a table with no usable column at all', () => {
    expect(plan([{ type: 'table', columns: ['Ghost'] }]).sections).toEqual([]);
  });

  it('drops an empty paragraph and an empty list', () => {
    expect(plan([{ type: 'text', body: '   ' }, { type: 'insights', points: [] }]).sections).toEqual(
      [],
    );
  });

  it('accepts "items" as well as "points" on a list, but only strings', () => {
    const { sections } = plan([
      { type: 'recommendations', items: ['Chase the late site', { label: 'nope' }] },
    ]);
    expect(sections[0]).toMatchObject({
      type: 'recommendations',
      points: ['Chase the late site'],
    });
  });
});

describe('planReport — legacy specs still render', () => {
  it('normalises the old kpis/charts/table triple into sections, in that order', () => {
    const { sections } = planReport(
      {
        title: 'T',
        kpis: [{ label: 'Lines', agg: 'count' }],
        charts: [{ type: 'bar', title: 'By site', groupBy: 'Site', agg: 'count' }],
        table: { columns: ['Site'] },
      } as ReportSpec,
      source,
    );
    expect(sections.map((s) => s.type)).toEqual(['metrics', 'chart', 'table']);
  });

  it('prefers sections when a spec somehow carries both', () => {
    const { sections } = planReport(
      {
        title: 'T',
        sections: [{ type: 'text', body: 'Just this.' }],
        kpis: [{ label: 'Lines', agg: 'count' }],
      } as ReportSpec,
      source,
    );
    expect(sections.map((s) => s.type)).toEqual(['text']);
  });
});

describe('planReport — needsCube', () => {
  it('is false for prose and count-only metrics — $count is exact and free', () => {
    const { needsCube } = plan([
      { type: 'text', body: 'Here is the picture.' },
      { type: 'metrics', items: [{ label: 'Lines', agg: 'count' }] },
      { type: 'table', columns: ['Site'] },
    ]);
    expect(needsCube).toBe(false);
  });

  it('is true as soon as anything has to be totalled or grouped', () => {
    expect(plan([{ type: 'metrics', items: [{ label: 'Q', agg: 'sum', field: 'Qty' }] }]).needsCube).toBe(true);
    expect(plan([{ type: 'chart', title: 'C', groupBy: 'Site', agg: 'count' }]).needsCube).toBe(true);
    expect(plan([{ type: 'ranking', title: 'R', groupBy: 'Site', agg: 'count' }]).needsCube).toBe(true);
  });

  it('is true for a count comparison — the periods come from the folded day buckets', () => {
    const { needsCube } = plan([
      {
        type: 'comparison',
        currentLabel: 'Q2',
        currentFrom: '2025-04-01',
        currentTo: '2025-06-30',
        previousLabel: 'Q1',
        previousFrom: '2025-01-01',
        previousTo: '2025-03-31',
        metrics: [{ label: 'Lines', agg: 'count' }],
      },
    ]);
    expect(needsCube).toBe(true);
  });
});
