import { Cube, GroupTotal } from '../../../core/aggregation/aggregate-plan.model';
import { AnalystSource } from '../models/analyst-source.model';
import { FieldMeta } from '../models/field-meta.model';
import { ReportSpec } from '../models/report-spec.model';
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
});
