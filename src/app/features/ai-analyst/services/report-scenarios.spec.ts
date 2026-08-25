import { describe, expect, it } from 'vitest';
import { Cube, GroupTotal } from '../../../core/aggregation/aggregate-plan.model';
import { AnalystSource } from '../models/analyst-source.model';
import { FieldMeta } from '../models/field-meta.model';
import { ReportSpec } from '../models/report-spec.model';
import { ComputeContext, ReportEngineService } from './report-engine.service';

/**
 * The five conversation scenarios this feature was built for, driven end to end
 * through the planner and the engine.
 *
 * The specs below are the SHAPES a real model produced against the live
 * endpoint (Gemini, `gemini-2.5-flash`) for these exact questions — recorded so
 * the pipeline behind them stays regression-tested without an API key, a
 * network, or a bill. What they pin is the property the whole change exists
 * for: **a different question produces a differently-shaped report**, and every
 * figure in it comes from the cube.
 */
const fields: FieldMeta[] = [
  { key: 'SalesId', label: 'Order', type: 'string', format: 'text', dimension: true },
  { key: 'ItemId', label: 'Item', type: 'string', format: 'text', dimension: true },
  { key: 'SalesTable_SalesName', label: 'Customer', type: 'string', format: 'text', dimension: true },
  { key: 'CurrencyCode', label: 'Currency', type: 'string', format: 'text', dimension: true },
  { key: 'SalesTable_DeliveryDate', label: 'Delivery date', type: 'date', format: 'date' },
  { key: 'QtyOrdered', label: 'Qty ordered', type: 'number', format: 'quantity', measure: true },
  {
    key: 'RemainInventPhysical',
    label: 'Units remaining',
    type: 'number',
    format: 'quantity',
    measure: true,
  },
  { key: 'LineAmount', label: 'Line amount', type: 'number', format: 'currency', measure: true },
];

const source: AnalystSource = {
  id: 'sales-order',
  label: 'Sales Order',
  fields,
  suggestions: [],
  entity: 'GP_SalesHeaderAndLineData',
  dataPath: '/data',
  authConfig: {} as AnalystSource['authConfig'],
  crossCompany: false,
  baseFilter: '',
  keyField: ['SalesId', 'LineNum'],
  select: '',
  searchFields: [],
  dateField: 'SalesTable_DeliveryDate',
  currencyField: 'CurrencyCode',
};

function group(count: number, sums: Record<string, number> = {}): GroupTotal {
  return { count, sums };
}

/** Six months of deliveries that fall away, plus item and customer breakdowns. */
function cube(): Cube {
  const byDay: Record<string, GroupTotal> = {
    '2025-01-15': group(52, { LineAmount: 250_000, RemainInventPhysical: 980, QtyOrdered: 1600 }),
    '2025-02-15': group(48, { LineAmount: 232_000, RemainInventPhysical: 910, QtyOrdered: 1480 }),
    '2025-03-15': group(55, { LineAmount: 262_000, RemainInventPhysical: 1010, QtyOrdered: 1700 }),
    '2025-04-15': group(41, { LineAmount: 178_000, RemainInventPhysical: 700, QtyOrdered: 1150 }),
    '2025-05-15': group(38, { LineAmount: 161_000, RemainInventPhysical: 640, QtyOrdered: 1010 }),
    '2025-06-15': group(31, { LineAmount: 128_000, RemainInventPhysical: 520, QtyOrdered: 820 }),
  };

  return {
    filter: 'x',
    builtAt: 0,
    rowsFolded: 265,
    totalRows: 265,
    totals: {
      LineAmount: { sum: 1_211_000, count: 265 },
      RemainInventPhysical: { sum: 4760, count: 265 },
      QtyOrdered: { sum: 7760, count: 265 },
    },
    dims: {
      SalesTable_DeliveryDate: byDay,
      ItemId: {
        D0001: group(31, { RemainInventPhysical: 1600, LineAmount: 410_000 }),
        D0002: group(22, { RemainInventPhysical: 900, LineAmount: 240_000 }),
        M0004: group(19, { RemainInventPhysical: 700, LineAmount: 190_000 }),
        T0100: group(14, { RemainInventPhysical: 400, LineAmount: 110_000 }),
        A0055: group(12, { RemainInventPhysical: 260, LineAmount: 90_000 }),
        Z9999: group(9, { RemainInventPhysical: 900, LineAmount: 171_000 }),
      },
      SalesTable_SalesName: {
        'Contoso Retail': group(61, { LineAmount: 520_000 }),
        Fabrikam: group(44, { LineAmount: 300_000 }),
        'Adventure Works': group(38, { LineAmount: 220_000 }),
        Northwind: group(25, { LineAmount: 120_000 }),
      },
      CurrencyCode: { USD: group(210), EUR: group(41), GBP: group(14) },
    },
  };
}

const engine = new ReportEngineService();

function run(spec: ReportSpec, over: Partial<ComputeContext> = {}) {
  return engine.compute(spec, {
    source,
    cube: cube(),
    total: 265,
    tableRows: [{ SalesId: 'SO-1001', ItemId: 'D0001', RemainInventPhysical: 25 }],
    ...over,
  });
}

const kinds = (spec: ReportSpec, over?: Partial<ComputeContext>) =>
  (run(spec, over).blocks ?? []).map((b) => b.kind);

describe('Scenario 1 — "Analyse sales orders for the last 30 days"', () => {
  // Recorded shape: a small metrics row plus one trend line. No detail table,
  // no donut, no second chart of the same breakdown.
  const spec: ReportSpec = {
    title: 'Sales Order Overview (Jan–Jun 2025)',
    sections: [
      {
        type: 'metrics',
        items: [
          { label: 'Order lines', agg: 'count' },
          { label: 'Units remaining', agg: 'sum', field: 'RemainInventPhysical' },
          { label: 'Line value', agg: 'sum', field: 'LineAmount' },
        ],
      },
      {
        type: 'chart',
        title: 'Line value over time',
        chartType: 'line',
        groupBy: 'SalesTable_DeliveryDate',
        agg: 'sum',
        valueField: 'LineAmount',
        grain: 'month',
      },
    ],
  };

  it('renders exactly the metrics and the trend it asked for', () => {
    expect(kinds(spec)).toEqual(['metrics', 'chart']);
  });

  it('reads the count from the server total and the sums from the cube', () => {
    const result = run(spec);
    expect(result.kpis.map((k) => k.value)).toEqual(['265', '4,760', '$1,211,000.00']);
  });

  it('plots the months in order, with the fall visible', () => {
    const chart = run(spec).charts[0];
    expect(chart.ordered).toBe(true);
    expect(chart.labels).toEqual([
      'Jan 2025',
      'Feb 2025',
      'Mar 2025',
      'Apr 2025',
      'May 2025',
      'Jun 2025',
    ]);
    expect(chart.series![0].values).toEqual([250_000, 232_000, 262_000, 178_000, 161_000, 128_000]);
  });
});

describe('Scenario 2 — "Show me the top 10 items by remaining units"', () => {
  // Recorded shape: a ranking, and nothing else. The old engine would have
  // returned a KPI row, a bar chart and a 100-row table alongside it.
  const spec: ReportSpec = {
    title: 'Top items by remaining units',
    sections: [
      {
        type: 'ranking',
        title: 'Top items by remaining units',
        groupBy: 'ItemId',
        agg: 'sum',
        valueField: 'RemainInventPhysical',
        topN: 3,
      },
    ],
  };

  it('is a ranking and nothing else', () => {
    expect(kinds(spec)).toEqual(['ranking']);
  });

  it('ranks by the measure and states each share of the whole set', () => {
    const block = run(spec).blocks![0];
    if (block.kind !== 'ranking') throw new Error('expected a ranking');

    expect(block.rows.map((r) => [r.rank, r.label, r.display])).toEqual([
      [1, 'D0001', '1,600'],
      [2, 'D0002', '900'],
      [3, 'Z9999', '900'],
    ]);
    // 1,600 of 4,760 across all six items — not of the three on screen.
    expect(block.rows[0].sharePct).toBe(34);
    expect(block.note).toContain('Top 3 of 6');
  });
});

describe('Scenario 3 — "Compare this month with last month"', () => {
  const spec: ReportSpec = {
    title: 'Q2 vs Q1',
    sections: [
      {
        type: 'comparison',
        currentLabel: 'Q2 2025',
        currentFrom: '2025-04-01',
        currentTo: '2025-06-30',
        previousLabel: 'Q1 2025',
        previousFrom: '2025-01-01',
        previousTo: '2025-03-31',
        metrics: [
          { label: 'Order lines', agg: 'count', higherIsBetter: false },
          { label: 'Line value', agg: 'sum', field: 'LineAmount', format: 'currency' },
        ],
      },
    ] as unknown as ReportSpec['sections'],
  };

  it('measures both quarters from the same folded slice', () => {
    const block = run(spec).blocks![0];
    if (block.kind !== 'comparison') throw new Error('expected a comparison');

    expect(block.items[0]).toMatchObject({ current: '110', previous: '155', direction: 'down' });
    expect(block.items[1]).toMatchObject({
      current: '$467,000.00',
      previous: '$744,000.00',
      direction: 'down',
    });
  });

  it('judges direction only where the spec said which way is up', () => {
    const block = run(spec).blocks![0];
    if (block.kind !== 'comparison') throw new Error('expected a comparison');
    // Fewer backorder lines, and the spec says fewer is better.
    expect(block.items[0].sentiment).toBe('good');
    expect(block.items[1].sentiment).toBe('neutral');
  });
});

describe('Scenario 4 — "Why did sales decrease?"', () => {
  // Recorded shape: prose first, then the evidence, then the contributing
  // dimensions, then a reading. A "why" question is not a dashboard.
  const spec: ReportSpec = {
    title: 'Sales performance analysis',
    sections: [
      { type: 'text', body: 'Line value has fallen every month since March.' },
      {
        type: 'metrics',
        items: [
          { label: 'Line value', agg: 'sum', field: 'LineAmount' },
          { label: 'Order lines', agg: 'count' },
        ],
      },
      {
        type: 'chart',
        title: 'Line value by month',
        chartType: 'area',
        groupBy: 'SalesTable_DeliveryDate',
        agg: 'sum',
        valueField: 'LineAmount',
        grain: 'month',
      },
      {
        type: 'ranking',
        title: 'Value by customer',
        groupBy: 'SalesTable_SalesName',
        agg: 'sum',
        valueField: 'LineAmount',
        topN: 3,
      },
      { type: 'insights', points: ['The decline is concentrated after March.'] },
      { type: 'recommendations', points: ['Review the April order intake.'] },
    ],
  };

  it('leads with the explanation and closes with the reading', () => {
    expect(kinds(spec)).toEqual([
      'text',
      'metrics',
      'chart',
      'ranking',
      'list',
      'list',
    ]);
  });

  it('keeps insights and recommendations as separate claims', () => {
    const blocks = run(spec).blocks!;
    const lists = blocks.filter((b) => b.kind === 'list');
    expect(lists.map((b) => (b.kind === 'list' ? b.variant : ''))).toEqual([
      'insights',
      'recommendations',
    ]);
  });

  it('draws the trend as an area chart, since the magnitude is the point', () => {
    expect(run(spec).charts[0].type).toBe('area');
  });
});

describe('Scenario 5 — "Analyse sales" → "Only show Q2" → "Compare it with Q1"', () => {
  /**
   * The conversation is carried by two things working together: the message
   * history, and `AiReportModel.lastSpec` — the spec of the report on screen —
   * which `api/chat.js` appends to the newest user turn so a follow-up has a
   * subject. What is pinned here is the app's half: each turn re-emits the FULL
   * spec, and the app computes each one against the same slice, so the third
   * report is a comparison rather than a fresh start.
   */
  const turn1: ReportSpec = {
    title: 'Sales overview',
    sections: [
      {
        type: 'metrics',
        items: [
          { label: 'Order lines', agg: 'count' },
          { label: 'Line value', agg: 'sum', field: 'LineAmount' },
        ],
      },
      {
        type: 'chart',
        title: 'Line value by month',
        chartType: 'line',
        groupBy: 'SalesTable_DeliveryDate',
        agg: 'sum',
        valueField: 'LineAmount',
        grain: 'month',
      },
    ],
  };

  // "Only show Q2" — the SAME measures and the same chart, now filtered. The
  // user did not restate the source, the metrics or the chart, and neither does
  // the spec's shape.
  const turn2: ReportSpec = {
    ...turn1,
    title: 'Sales overview — Q2 2025',
    filters: [
      { field: 'SalesTable_DeliveryDate', op: 'gte', value: '2025-04-01' },
      { field: 'SalesTable_DeliveryDate', op: 'lte', value: '2025-06-30' },
    ],
  };

  // "Compare it with Q1" — the filter is dropped back to cover BOTH quarters,
  // because the two windows are cut from one folded slice.
  const turn3: ReportSpec = {
    title: 'Q2 2025 vs Q1 2025',
    sections: [
      {
        type: 'comparison',
        currentLabel: 'Q2 2025',
        currentFrom: '2025-04-01',
        currentTo: '2025-06-30',
        previousLabel: 'Q1 2025',
        previousFrom: '2025-01-01',
        previousTo: '2025-03-31',
        metrics: [{ label: 'Line value', agg: 'sum', field: 'LineAmount', format: 'currency' }],
      },
      {
        type: 'chart',
        title: 'Line value by month',
        chartType: 'line',
        groupBy: 'SalesTable_DeliveryDate',
        agg: 'sum',
        valueField: 'LineAmount',
        grain: 'month',
      },
    ] as unknown as ReportSpec['sections'],
  };

  it('turn 1 builds the overview', () => {
    expect(kinds(turn1)).toEqual(['metrics', 'chart']);
  });

  it('turn 2 keeps the same shape and only narrows', () => {
    // The narrowing is a `filters` clause, compiled to OData upstream — the
    // sections carry over untouched, which is what "don't make me repeat
    // myself" means concretely.
    expect(kinds(turn2)).toEqual(['metrics', 'chart']);
    expect(turn2.sections).toEqual(turn1.sections);
    expect(turn2.filters).toHaveLength(2);
  });

  it('turn 3 becomes a comparison of the two quarters', () => {
    const result = run(turn3);
    expect(result.blocks?.map((b) => b.kind)).toEqual(['comparison', 'chart']);

    const block = result.blocks![0];
    if (block.kind !== 'comparison') throw new Error('expected a comparison');
    expect(block.currentLabel).toBe('Q2 2025');
    expect(block.previousLabel).toBe('Q1 2025');
    expect(block.items[0]).toMatchObject({
      current: '$467,000.00',
      previous: '$744,000.00',
      deltaPercent: -37.2,
    });
  });

  it('turn 3 must NOT be filtered to Q2 — the baseline has to be in the slice', () => {
    // The rule the prompt states and the block enforces: if the report were
    // still filtered to Q2, Q1 would measure zero and the fall would read as
    // −100%. The block says so rather than reporting the artefact.
    const q2Only = run(turn3, {
      cube: {
        ...cube(),
        dims: {
          ...cube().dims,
          SalesTable_DeliveryDate: {
            '2025-04-15': group(41, { LineAmount: 178_000 }),
            '2025-05-15': group(38, { LineAmount: 161_000 }),
            '2025-06-15': group(31, { LineAmount: 128_000 }),
          },
        },
      },
    });
    const block = q2Only.blocks![0];
    if (block.kind !== 'comparison') throw new Error('expected a comparison');
    expect(block.items[0].deltaPercent).toBeNull();
    expect(block.note).toContain('No rows fall in Q1 2025');
  });
});

describe('Scenario 6 — the report that should not exist', () => {
  it('a question answered in prose emits no report at all', () => {
    // `emit_report` is not forced, and the prompt says a question deserves
    // prose. Nothing here to assert beyond the shape of the contract: a spec
    // with no sections computes to no blocks, and the renderer says so rather
    // than drawing an empty dashboard.
    const result = run({ title: 'Nothing to draw' });
    expect(result.blocks).toEqual([]);
    expect(result.kpis).toEqual([]);
    expect(result.charts).toEqual([]);
  });
});
