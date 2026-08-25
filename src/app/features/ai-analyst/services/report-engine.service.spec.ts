import { Cube, GroupTotal } from '../../../core/aggregation/aggregate-plan.model';
import { AnalystSource } from '../models/analyst-source.model';
import { FieldMeta } from '../models/field-meta.model';
import { DEFAULT_DESIGN, ReportSpec, reportColor } from '../models/report-spec.model';
import { ComputeContext, ReportEngineService, TABLE_DISPLAY_LIMIT } from './report-engine.service';

/**
 * The engine's contract: every figure comes from the cube or the server count,
 * never from the LLM. These tests fix that mapping — a `count` KPI reads the exact
 * server total, a `sum`/`avg` reads the folded cube, and a chart's "Other" bucket
 * is exact because the cube holds every key.
 */
describe('ReportEngineService', () => {
  const engine = new ReportEngineService();

  const fields: FieldMeta[] = [
    { key: 'Site', label: 'Site', type: 'string', format: 'text', dimension: true },
    { key: 'CurrencyCode', label: 'Currency', type: 'string', format: 'text', dimension: true },
    { key: 'Amount', label: 'Amount', type: 'number', format: 'currency', measure: true },
    { key: 'Qty', label: 'Quantity', type: 'number', format: 'quantity', measure: true },
    { key: 'Delivery', label: 'Delivery date', type: 'date', format: 'date' },
  ];

  function source(currencyField?: string): AnalystSource {
    return {
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
      dateField: 'Delivery',
      currencyField,
    };
  }

  function group(count: number, sums: Record<string, number> = {}): GroupTotal {
    return { count, sums };
  }

  function cube(partial: Partial<Cube> = {}): Cube {
    return {
      filter: 'x',
      builtAt: 0,
      rowsFolded: 0,
      totalRows: 0,
      totals: {},
      dims: {},
      ...partial,
    };
  }

  function ctx(over: Partial<ComputeContext>): ComputeContext {
    return { source: source(), cube: cube(), total: 0, tableRows: [], ...over };
  }

  describe('KPIs', () => {
    it('count reads the exact server total, not any folded row count', () => {
      const spec: ReportSpec = {
        title: 'T',
        kpis: [{ label: 'Rows', agg: 'count', format: 'integer' }],
        charts: [],
      };
      const result = engine.compute(spec, ctx({ total: 11_000_000, cube: cube({ rowsFolded: 5 }) }));
      expect(result.kpis[0].value).toBe('11,000,000');
      expect(result.rowCount).toBe(11_000_000);
    });

    it('sum reads the cube total', () => {
      const spec: ReportSpec = {
        title: 'T',
        kpis: [{ label: 'Total qty', agg: 'sum', field: 'Qty', format: 'quantity' }],
        charts: [],
      };
      const c = cube({ totals: { Qty: { sum: 1234.5, count: 3 } } });
      expect(engine.compute(spec, ctx({ cube: c })).kpis[0].value).toBe('1,234.5');
    });

    it('avg divides the cube sum by its count', () => {
      const spec: ReportSpec = {
        title: 'T',
        kpis: [{ label: 'Avg qty', agg: 'avg', field: 'Qty', format: 'quantity' }],
        charts: [],
      };
      const c = cube({ totals: { Qty: { sum: 30, count: 4 } } });
      expect(engine.compute(spec, ctx({ cube: c })).kpis[0].value).toBe('7.5');
    });

    it('avg of an empty measure is zero, not NaN', () => {
      const spec: ReportSpec = {
        title: 'T',
        kpis: [{ label: 'Avg', agg: 'avg', field: 'Qty', format: 'quantity' }],
        charts: [],
      };
      const c = cube({ totals: { Qty: { sum: 0, count: 0 } } });
      expect(engine.compute(spec, ctx({ cube: c })).kpis[0].value).toBe('0');
    });

    it('distinctCount counts every key the cube holds for the dimension', () => {
      const spec: ReportSpec = {
        title: 'T',
        kpis: [{ label: 'Sites', agg: 'distinctCount', field: 'Site', format: 'integer' }],
        charts: [],
      };
      const c = cube({ dims: { Site: { A: group(1), B: group(1), C: group(1) } } });
      expect(engine.compute(spec, ctx({ cube: c })).kpis[0].value).toBe('3');
    });

    it('formats a currency KPI with the cube-dominant currency', () => {
      const spec: ReportSpec = {
        title: 'T',
        kpis: [{ label: 'Revenue', agg: 'sum', field: 'Amount', format: 'currency' }],
        charts: [],
      };
      const c = cube({
        totals: { Amount: { sum: 1240, count: 2 } },
        // USD dominates by row count, so it wins over EUR.
        dims: { CurrencyCode: { USD: group(10), EUR: group(1) } },
      });
      const result = engine.compute(spec, {
        ...ctx({ cube: c }),
        source: source('CurrencyCode'),
      });
      expect(result.kpis[0].value).toBe('$1,240.00');
    });

    it('a source without a currency field formats currency as a plain number', () => {
      const spec: ReportSpec = {
        title: 'T',
        kpis: [{ label: 'Revenue', agg: 'sum', field: 'Amount', format: 'currency' }],
        charts: [],
      };
      const c = cube({ totals: { Amount: { sum: 1240, count: 2 } } });
      // Default source() has no currencyField (the Shatat case).
      expect(engine.compute(spec, ctx({ cube: c })).kpis[0].value).toBe('1,240');
    });
  });

  describe('charts', () => {
    it('returns empty data for a dimension the cube never folded', () => {
      const spec: ReportSpec = {
        title: 'T',
        kpis: [],
        charts: [{ type: 'bar', title: 'By site', groupBy: 'Site', agg: 'count' }],
      };
      expect(engine.compute(spec, ctx({})).charts[0].data).toEqual([]);
    });

    it('builds an exact "Other" bucket for a sum chart', () => {
      const spec: ReportSpec = {
        title: 'T',
        kpis: [],
        charts: [
          { type: 'bar', title: 'By site', groupBy: 'Site', agg: 'sum', valueField: 'Amount', topN: 2 },
        ],
      };
      const c = cube({
        dims: {
          Site: {
            A: group(1, { Amount: 100 }),
            B: group(1, { Amount: 40 }),
            C: group(1, { Amount: 10 }),
          },
        },
      });
      // topN 2 → one head (A) + Other = B + C = 50.
      expect(engine.compute(spec, ctx({ cube: c })).charts[0].data).toEqual([
        { label: 'A', value: 100 },
        { label: 'Other', value: 50 },
      ]);
    });

    it('computes a per-group mean for an avg chart', () => {
      const spec: ReportSpec = {
        title: 'T',
        kpis: [],
        charts: [
          { type: 'bar', title: 'Avg by site', groupBy: 'Site', agg: 'avg', valueField: 'Amount' },
        ],
      };
      const c = cube({
        dims: {
          Site: {
            A: group(2, { Amount: 100 }), // mean 50
            B: group(4, { Amount: 40 }), // mean 10
          },
        },
      });
      expect(engine.compute(spec, ctx({ cube: c })).charts[0].data).toEqual([
        { label: 'A', value: 50 },
        { label: 'B', value: 10 },
      ]);
    });
  });

  describe('design', () => {
    const bar = (): ReportSpec['charts'] => [
      { type: 'bar', title: 'By site', groupBy: 'Site', agg: 'count' },
    ];
    const sites = () => cube({ dims: { Site: { A: group(3), B: group(1) } } });

    it('fills in the defaults when the spec has no design block', () => {
      const result = engine.compute({ title: 'T', kpis: [], charts: [] }, ctx({}));
      expect(result.design).toEqual(DEFAULT_DESIGN);
    });

    it('carries a design the model asked for', () => {
      const spec: ReportSpec = {
        title: 'T',
        kpis: [],
        charts: [],
        design: { density: 'compact', chartLayout: 'stacked' },
      };
      const result = engine.compute(spec, ctx({}));
      expect(result.design.density).toBe('compact');
      expect(result.design.chartLayout).toBe('stacked');
      // Unspecified members still resolve, so the renderer never sees undefined.
      expect(result.design.palette).toBe('categorical');
    });

    it('falls back to the default for a value outside the vocabulary', () => {
      // A spec is model output: an invented enum member must not reach a
      // template as an unknown class name.
      const spec = {
        title: 'T',
        kpis: [],
        charts: [],
        design: { density: 'airy', palette: 'neon' },
      } as unknown as ReportSpec;
      expect(engine.compute(spec, ctx({})).design).toEqual(DEFAULT_DESIGN);
    });

    it('leaves chart colours unset under the categorical palette', () => {
      const spec: ReportSpec = { title: 'T', kpis: [], charts: bar() };
      const data = engine.compute(spec, ctx({ cube: sites() })).charts[0].data;
      expect(data.every((d) => d.color === undefined)).toBe(true);
    });

    it('paints a single-hue ramp onto the data when one is asked for', () => {
      const spec: ReportSpec = {
        title: 'T',
        kpis: [],
        charts: bar(),
        design: { palette: 'brand' },
      };
      const data = engine.compute(spec, ctx({ cube: sites() })).charts[0].data;
      expect(data[0].color).toBe(reportColor('brand', 0));
      expect(data[1].color).toBe(reportColor('brand', 1));
      // Different steps of one hue — the ramp is ordered, not categorical.
      expect(data[0].color).not.toBe(data[1].color);
    });
  });

  describe('table', () => {
    it('caps displayRows at the render limit while keeping the true total', () => {
      const spec: ReportSpec = {
        title: 'T',
        kpis: [],
        charts: [],
        table: { columns: ['Site', 'Amount'] },
      };
      const rows = Array.from({ length: TABLE_DISPLAY_LIMIT + 25 }, (_, i) => ({
        Site: `S${i}`,
        Amount: i,
      }));
      const result = engine.compute(spec, ctx({ total: 500, tableRows: rows }));
      expect(result.table!.displayRows).toHaveLength(TABLE_DISPLAY_LIMIT);
      expect(result.table!.total).toBe(500);
      expect(result.table!.displayLimit).toBe(TABLE_DISPLAY_LIMIT);
      expect(result.table!.columns.map((c) => c.header)).toEqual(['Site', 'Amount']);
    });

    it('omits the table when the spec has none', () => {
      const spec: ReportSpec = { title: 'T', kpis: [], charts: [] };
      expect(engine.compute(spec, ctx({})).table).toBeUndefined();
    });
  });

  it('passes omitted clauses through so the UI can show what was refused', () => {
    const spec: ReportSpec = { title: 'T', kpis: [], charts: [] };
    const result = engine.compute(spec, ctx({ omitted: ['Unknown field “Ghost”.'] }));
    expect(result.omitted).toEqual(['Unknown field “Ghost”.']);
  });

  // ── Sections: the report's shape is the model's to choose ─────────────────
  //
  // The engine used to emit a fixed KPI/chart/table triple whatever was asked.
  // These pin the property that replaced it: `blocks` is exactly what the spec
  // asked for, in the order it asked, and nothing else appears.

  describe('sections', () => {
    it('emits one block per section, in the model’s order', () => {
      const spec: ReportSpec = {
        title: 'Why deliveries slipped',
        sections: [
          { type: 'text', body: 'Two sites account for most of the shortfall.' },
          { type: 'metrics', items: [{ label: 'Lines', agg: 'count' }] },
          { type: 'insights', points: ['Site A alone is over half.'] },
        ],
      };
      const result = engine.compute(spec, ctx({ total: 42 }));
      expect(result.blocks?.map((b) => b.kind)).toEqual(['text', 'metrics', 'list']);
    });

    it('produces NO metrics or table unless a section asked for them', () => {
      // The old engine always emitted both. A ranking question should come back
      // as a ranking and nothing else.
      const spec: ReportSpec = {
        title: 'Top sites',
        sections: [{ type: 'ranking', title: 'Top sites', groupBy: 'Site', agg: 'count' }],
      };
      const result = engine.compute(spec, ctx({ cube: cube({ dims: { Site: { A: group(3) } } }) }));
      expect(result.blocks?.map((b) => b.kind)).toEqual(['ranking']);
      expect(result.kpis).toEqual([]);
      expect(result.table).toBeUndefined();
    });

    it('flattens metrics and charts into the projections the exports read', () => {
      const spec: ReportSpec = {
        title: 'T',
        sections: [
          { type: 'metrics', items: [{ label: 'Lines', agg: 'count' }] },
          { type: 'chart', title: 'By site', chartType: 'bar', groupBy: 'Site', agg: 'count' },
          { type: 'table', columns: ['Site'] },
        ],
      };
      const result = engine.compute(
        spec,
        ctx({ total: 7, cube: cube({ dims: { Site: { A: group(3) } } }), tableRows: [{ Site: 'A' }] }),
      );
      expect(result.kpis).toEqual([{ label: 'Lines', value: '7' }]);
      expect(result.charts).toHaveLength(1);
      expect(result.table?.total).toBe(7);
    });
  });

  describe('ranking', () => {
    const bySite = () =>
      cube({
        dims: {
          Site: {
            A: group(1, { Amount: 100 }),
            B: group(1, { Amount: 60 }),
            C: group(1, { Amount: 40 }),
          },
        },
      });

    it('ranks, positions and computes each row’s share of the WHOLE set', () => {
      const spec: ReportSpec = {
        title: 'T',
        sections: [
          {
            type: 'ranking',
            title: 'Top sites',
            groupBy: 'Site',
            agg: 'sum',
            valueField: 'Amount',
            topN: 2,
          },
        ],
      };
      const block = engine.compute(spec, ctx({ cube: bySite() })).blocks![0];
      expect(block.kind).toBe('ranking');
      if (block.kind !== 'ranking') return;

      expect(block.rows.map((r) => [r.rank, r.label, r.sharePct])).toEqual([
        [1, 'A', 50],
        [2, 'B', 30],
      ]);
      // 100/200 and 60/200 — the denominator is every group, not the two shown,
      // or "50% of total" would be a different and wrong claim.
      expect(block.rows[0].widthPct).toBe(100);
      expect(block.note).toContain('Top 2 of 3');
      expect(block.measureLabel).toBe('Amount');
    });

    it('ranks by row count when no measure is given', () => {
      const spec: ReportSpec = {
        title: 'T',
        sections: [{ type: 'ranking', title: 'Busiest', groupBy: 'Site', agg: 'count' }],
      };
      const c = cube({ dims: { Site: { A: group(2), B: group(8) } } });
      const block = engine.compute(spec, ctx({ cube: c })).blocks![0];
      if (block.kind !== 'ranking') throw new Error('expected a ranking');
      expect(block.rows.map((r) => r.label)).toEqual(['B', 'A']);
      expect(block.measureLabel).toBe('Rows');
    });
  });

  describe('time series', () => {
    const overTime = () =>
      cube({
        dims: {
          Delivery: {
            '2025-01-10': group(2, { Qty: 20 }),
            '2025-03-10': group(4, { Qty: 40 }),
          },
        },
      });

    const trend = (over: Record<string, unknown> = {}): ReportSpec =>
      ({
        title: 'T',
        sections: [
          {
            type: 'chart',
            title: 'Lines per month',
            chartType: 'line',
            groupBy: 'Delivery',
            agg: 'count',
            grain: 'month',
            ...over,
          },
        ],
      }) as unknown as ReportSpec;

    it('rolls the cube’s day buckets up to the requested grain, gaps and all', () => {
      const chart = engine.compute(trend(), ctx({ cube: overTime() })).charts[0];
      expect(chart.ordered).toBe(true);
      expect(chart.data.map((d) => [d.label, d.value])).toEqual([
        ['Jan 2025', 2],
        ['Feb 2025', 0],
        ['Mar 2025', 4],
      ]);
    });

    it('carries the series form the line and column components need', () => {
      const chart = engine.compute(trend(), ctx({ cube: overTime() })).charts[0];
      expect(chart.labels).toEqual(['Jan 2025', 'Feb 2025', 'Mar 2025']);
      expect(chart.series).toEqual([{ label: 'Lines per month', values: [2, 0, 4] }]);
    });

    it('sums a measure across the bucket', () => {
      const spec = trend({ agg: 'sum', valueField: 'Qty' } as never);
      const chart = engine.compute(spec, ctx({ cube: overTime() })).charts[0];
      expect(chart.data.map((d) => d.value)).toEqual([20, 0, 40]);
    });

    it('colours a series once, not once per point', () => {
      // A line is one thing measured over an axis. Stepping its points through a
      // ramp would encode position twice and say nothing.
      const spec = { ...trend(), design: { palette: 'brand' as const } };
      const chart = engine.compute(spec, ctx({ cube: overTime() })).charts[0];
      expect(chart.series![0].color).toBe(reportColor('brand', 0));
      expect(chart.data.every((d) => d.color === undefined)).toBe(true);
    });
  });

  describe('comparison', () => {
    const days = () =>
      cube({
        dims: {
          Delivery: {
            '2025-01-15': group(10, { Amount: 1000 }),
            '2025-02-15': group(10, { Amount: 1000 }),
            '2025-05-15': group(25, { Amount: 3000 }),
          },
        },
      });

    const spec = (metrics: unknown[]): ReportSpec =>
      ({
        title: 'T',
        sections: [
          {
            type: 'comparison',
            currentLabel: 'Q2',
            currentFrom: '2025-04-01',
            currentTo: '2025-06-30',
            previousLabel: 'Q1',
            previousFrom: '2025-01-01',
            previousTo: '2025-03-31',
            metrics,
          },
        ],
      }) as unknown as ReportSpec;

    it('measures both windows from the folded day buckets', () => {
      const block = engine.compute(spec([{ label: 'Lines', agg: 'count' }]), ctx({ cube: days() }))
        .blocks![0];
      if (block.kind !== 'comparison') throw new Error('expected a comparison');

      expect(block.items[0]).toMatchObject({
        current: '25',
        previous: '20',
        delta: '+5',
        deltaPercent: 25,
        direction: 'up',
      });
      expect(block.currentLabel).toBe('Q2');
      expect(block.previousLabel).toBe('Q1');
    });

    it('leaves the change uncoloured unless the spec said which way is up', () => {
      const neutral = engine.compute(spec([{ label: 'Lines', agg: 'count' }]), ctx({ cube: days() }))
        .blocks![0];
      if (neutral.kind !== 'comparison') throw new Error('expected a comparison');
      expect(neutral.items[0].sentiment).toBe('neutral');

      const judged = engine.compute(
        spec([{ label: 'Lines', agg: 'count', higherIsBetter: false }]),
        ctx({ cube: days() }),
      ).blocks![0];
      if (judged.kind !== 'comparison') throw new Error('expected a comparison');
      // More backorder lines, and the spec says more is worse.
      expect(judged.items[0].sentiment).toBe('bad');
    });

    it('reports no percentage against an empty baseline, and says why', () => {
      const empty = cube({ dims: { Delivery: { '2025-05-15': group(5) } } });
      const block = engine.compute(spec([{ label: 'Lines', agg: 'count' }]), ctx({ cube: empty }))
        .blocks![0];
      if (block.kind !== 'comparison') throw new Error('expected a comparison');

      // A ratio against zero is undefined — not infinite, and not +100%.
      expect(block.items[0].deltaPercent).toBeNull();
      expect(block.note).toContain('No rows fall in Q1');
    });

    it('refuses the whole block, with a reason, when the slice was never totalled', () => {
      const result = engine.compute(spec([{ label: 'Lines', agg: 'count' }]), ctx({}));
      expect(result.blocks).toEqual([]);
      expect(result.omitted?.[0]).toContain('totalled');
    });
  });
});
