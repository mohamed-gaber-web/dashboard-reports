import { describe, expect, it } from 'vitest';
import { Cube, GroupTotal } from '../../../core/aggregation/aggregate-plan.model';
import { AnalystSource } from '../../ai-analyst/models/analyst-source.model';
import { FieldMeta } from '../../ai-analyst/models/field-meta.model';
import { ReportBlock } from '../models/report-definition.model';
import { ComposeContext, ReportComposerService } from './report-composer.service';

/**
 * The composer is where a definition becomes figures, so these tests are about
 * ARITHMETIC and HONESTY — that a share is of the whole, that a ratio against
 * zero is refused rather than rendered as 100%, and that a rise is only painted
 * good when the definition said which way is up.
 */

const FIELDS: FieldMeta[] = [
  { key: 'CustAccount', label: 'Customer', type: 'string', dimension: true },
  { key: 'ItemId', label: 'Item', type: 'string', dimension: true },
  { key: 'Units', label: 'Units remaining', type: 'number', measure: true, format: 'quantity' },
  { key: 'ShipDate', label: 'Ship date', type: 'date', format: 'date' },
];

const SOURCE = {
  id: 'test',
  label: 'Test',
  fields: FIELDS,
  suggestions: [],
  entity: 'TestEntity',
  dataPath: '/data',
  authConfig: {} as AnalystSource['authConfig'],
  crossCompany: true,
  baseFilter: "dataAreaId eq 'usmf'",
  keyField: ['Id'],
  select: 'Id',
  searchFields: [],
  dateField: 'ShipDate',
  currencyField: undefined,
} satisfies AnalystSource;

const group = (count: number, units: number): GroupTotal => ({ count, sums: { Units: units } });

/** Four items, so a top-2 ranking has a real tail to take a share of. */
const CUBE: Cube = {
  filter: 'x',
  builtAt: 0,
  rowsFolded: 100,
  totalRows: 100,
  totals: { Units: { sum: 1000, count: 100 } },
  dims: {
    ItemId: {
      'A-100': group(40, 500),
      'B-200': group(30, 300),
      'C-300': group(20, 150),
      'D-400': group(10, 50),
    },
    CustAccount: { ACME: group(60, 700), GLOBEX: group(40, 300) },
    ShipDate: {
      '2025-01-15': group(10, 100),
      '2025-02-15': group(20, 300),
      '2025-03-15': group(15, 150),
    },
  },
};

function context(overrides: Partial<ComposeContext> = {}): ComposeContext {
  return { source: SOURCE, cube: CUBE, total: 100, tableRows: [], ...overrides };
}

function compose(sections: unknown[], ctx = context()) {
  return new ReportComposerService().compose({ title: 'T', sections }, ctx);
}

function block<K extends ReportBlock['kind']>(
  blocks: ReportBlock[],
  kind: K,
): Extract<ReportBlock, { kind: K }> {
  const found = blocks.find((b) => b.kind === kind);
  if (!found) throw new Error(`no ${kind} block was composed`);
  return found as Extract<ReportBlock, { kind: K }>;
}

describe('ReportComposerService', () => {
  describe('metrics', () => {
    it('reads a count from the exact server total, not from the cube', () => {
      // The point: `$count` covers the whole slice for free, so a count is right
      // even when nothing was folded.
      const report = compose(
        [{ type: 'metrics', items: [{ label: 'Lines', agg: 'count' }] }],
        context({ total: 11_000_000 }),
      );
      expect(block(report.blocks, 'metrics').items[0].value).toBe('11,000,000');
    });

    it('sums and averages from the folded totals', () => {
      const report = compose([
        {
          type: 'metrics',
          items: [
            { label: 'Units', agg: 'sum', field: 'Units' },
            { label: 'Avg units', agg: 'avg', field: 'Units' },
          ],
        },
      ]);
      const items = block(report.blocks, 'metrics').items;
      expect(items[0].value).toBe('1,000');
      expect(items[1].value).toBe('10');
    });

    it('counts distinct values off the cube’s complete key set', () => {
      const report = compose([
        { type: 'metrics', items: [{ label: 'Items', agg: 'distinctCount', field: 'ItemId' }] },
      ]);
      expect(block(report.blocks, 'metrics').items[0].value).toBe('4');
    });
  });

  describe('ranking', () => {
    it('takes each share of the WHOLE set, not of the visible rows', () => {
      const report = compose([
        { type: 'ranking', title: 'Top items', groupBy: 'ItemId', agg: 'sum', valueField: 'Units', topN: 2 },
      ]);
      const rows = block(report.blocks, 'ranking').rows;

      expect(rows).toHaveLength(2);
      // 500 of 1000 across all four items — not 500 of the 800 shown.
      expect(rows[0]).toMatchObject({ rank: 1, label: 'A-100', sharePct: 50 });
      expect(rows[1].sharePct).toBe(30);
    });

    it('says how many groups were left out', () => {
      const report = compose([
        { type: 'ranking', title: 'Top items', groupBy: 'ItemId', agg: 'count', topN: 2 },
      ]);
      expect(block(report.blocks, 'ranking').note).toContain('Top 2 of 4');
    });

    it('scales the bars against the leader, never below a visible minimum', () => {
      const report = compose([
        { type: 'ranking', title: 'Top items', groupBy: 'ItemId', agg: 'sum', valueField: 'Units' },
      ]);
      const rows = block(report.blocks, 'ranking').rows;
      expect(rows[0].widthPct).toBe(100);
      expect(rows[3].widthPct).toBe(10);
      expect(Math.min(...rows.map((r) => r.widthPct))).toBeGreaterThanOrEqual(2);
    });
  });

  describe('charts', () => {
    it('folds the tail of a category chart into an exact "Other"', () => {
      // topN counts the SLOTS, and the last one is the tail — so three slots is
      // the top two plus everything else, totalled exactly rather than estimated.
      const report = compose([
        { type: 'chart', title: 'By item', chartType: 'bar', groupBy: 'ItemId', agg: 'sum', valueField: 'Units', topN: 3 },
      ]);
      const data = block(report.blocks, 'chart').chart.data;

      expect(data.map((d) => d.label)).toEqual(['A-100', 'B-200', 'Other']);
      expect(data.at(-1)?.value).toBe(200);
      // Nothing is lost in the fold: the visible values still total the slice.
      expect(data.reduce((sum, d) => sum + d.value, 0)).toBe(1000);
    });

    it('gap-fills a trend so an empty period is a zero, not a skipped point', () => {
      const cube: Cube = {
        ...CUBE,
        dims: { ...CUBE.dims, ShipDate: { '2025-01-15': group(5, 50), '2025-04-15': group(5, 70) } },
      };
      const report = compose(
        [{ type: 'chart', title: 'Over time', chartType: 'line', groupBy: 'ShipDate', agg: 'count', grain: 'month' }],
        context({ cube }),
      );
      const chart = block(report.blocks, 'chart').chart;

      expect(chart.ordered).toBe(true);
      // Jan, Feb, Mar, Apr — February and March exist and are zero.
      expect(chart.data.map((d) => d.value)).toEqual([5, 0, 0, 5]);
      // The multi-series components need the labels/series form.
      expect(chart.labels).toHaveLength(4);
      expect(chart.series?.[0].values).toEqual([5, 0, 0, 5]);
    });

    it('leaves a chart empty rather than inventing groups for a field with none', () => {
      const report = compose(
        [{ type: 'chart', title: 'By customer', groupBy: 'CustAccount', agg: 'count' }],
        context({ cube: { ...CUBE, dims: {} } }),
      );
      expect(block(report.blocks, 'chart').chart.data).toEqual([]);
    });
  });

  describe('comparison', () => {
    const compare = (goodDirection?: 'up' | 'down') =>
      compose([
        {
          type: 'comparison',
          dateField: 'ShipDate',
          currentLabel: 'February',
          currentFrom: '2025-02-01',
          currentTo: '2025-02-28',
          previousLabel: 'January',
          previousFrom: '2025-01-01',
          previousTo: '2025-01-31',
          metrics: [{ label: 'Units', agg: 'sum', field: 'Units', goodDirection }],
        },
      ]);

    it('cuts both windows out of the same folded day buckets', () => {
      const item = block(compare().blocks, 'comparison').items[0];
      expect(item.current).toBe('300');
      expect(item.previous).toBe('100');
      expect(item.delta).toBe('+200');
      expect(item.deltaPercent).toBe(200);
      expect(item.direction).toBe('up');
    });

    it('stays neutral when the definition did not say which way is up', () => {
      // More backorder units is not obviously good news, and painting every rise
      // green is how a dashboard starts lying.
      expect(block(compare().blocks, 'comparison').items[0].sentiment).toBe('neutral');
    });

    it('colours the change only once a direction has been declared', () => {
      expect(block(compare('up').blocks, 'comparison').items[0].sentiment).toBe('good');
      expect(block(compare('down').blocks, 'comparison').items[0].sentiment).toBe('bad');
    });

    it('refuses a ratio against an empty baseline and says why', () => {
      const report = compose([
        {
          type: 'comparison',
          dateField: 'ShipDate',
          currentLabel: 'February',
          currentFrom: '2025-02-01',
          currentTo: '2025-02-28',
          previousLabel: 'December',
          previousFrom: '2024-12-01',
          previousTo: '2024-12-31',
          metrics: [{ label: 'Units', agg: 'sum', field: 'Units' }],
        },
      ]);
      const comparison = block(report.blocks, 'comparison');

      // Undefined, not infinite, and certainly not 100%.
      expect(comparison.items[0].deltaPercent).toBeNull();
      expect(comparison.note).toContain('measured against nothing');
    });

    it('drops the section and explains when the slice was never totalled', () => {
      const report = compose(
        [
          {
            type: 'comparison',
            dateField: 'ShipDate',
            currentFrom: '2025-02-01',
            currentTo: '2025-02-28',
            previousFrom: '2025-01-01',
            previousTo: '2025-01-31',
            metrics: [{ label: 'Lines', agg: 'count' }],
          },
        ],
        context({ cube: { ...CUBE, dims: {} } }),
      );
      expect(report.blocks).toEqual([]);
      expect(report.issues.join(' ')).toMatch(/totalled/i);
    });
  });

  describe('timeline', () => {
    it('lists periods newest first with the step change at each one', () => {
      const report = compose([
        { type: 'timeline', title: 'By month', dateField: 'ShipDate', agg: 'sum', valueField: 'Units', grain: 'month' },
      ]);
      const points = block(report.blocks, 'timeline').points;

      expect(points.map((p) => p.value)).toEqual([150, 300, 100]);
      // The oldest visible period has nothing before it to move from.
      expect(points.at(-1)?.changePercent).toBeNull();
      expect(points[1].changePercent).toBe(200);
      expect(points[0].changePercent).toBe(-50);
      expect(points[0].direction).toBe('down');
    });
  });

  describe('prose sections', () => {
    it('carries text, insights and recommendations through untouched', () => {
      const report = compose([
        { type: 'text', body: 'A sentence.' },
        { type: 'insights', points: [{ text: 'A reading', kind: 'interpretation' }] },
        { type: 'recommendations', points: [{ text: 'Do the thing', priority: 'high' }] },
      ]);

      expect(block(report.blocks, 'text').body).toBe('A sentence.');
      expect(block(report.blocks, 'insights').points[0].kind).toBe('interpretation');
      expect(block(report.blocks, 'recommendations').points[0].priority).toBe('high');
    });
  });

  describe('unusable input', () => {
    it('returns an empty report rather than throwing', () => {
      const report = new ReportComposerService().compose('not a report', context());
      expect(report.blocks).toEqual([]);
      expect(report.issues.length).toBeGreaterThan(0);
    });

    it('surfaces issues raised before composition alongside its own', () => {
      const report = compose(
        [{ type: 'metrics', items: [{ label: 'X', agg: 'sum', field: 'Nope' }] }],
        context({ issues: ['A filter was rejected.'] }),
      );

      // The caller's issue comes first, then the unknown field, then the fact
      // that dropping it left the report with nothing — all three are shown,
      // because a report that quietly answers none of the question is worse than
      // one that says so.
      expect(report.issues[0]).toBe('A filter was rejected.');
      expect(report.issues[1]).toContain('“Nope”');
      expect(report.issues.at(-1)).toMatch(/no section of this report could be built/i);
    });
  });
});
