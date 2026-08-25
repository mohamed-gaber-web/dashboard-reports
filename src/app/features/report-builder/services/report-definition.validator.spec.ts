import { describe, expect, it } from 'vitest';
import { AnalystSource } from '../../ai-analyst/models/analyst-source.model';
import { FieldMeta } from '../../ai-analyst/models/field-meta.model';
import { validateDefinition } from './report-definition.validator';

/**
 * The validator is the trust boundary: everything above it is text a language
 * model wrote, everything below it is treated as app behaviour. These tests are
 * therefore about what happens to BAD input, not good — a definition that is
 * already correct has nothing interesting to prove.
 */

const FIELDS: FieldMeta[] = [
  { key: 'CustAccount', label: 'Customer', type: 'string', dimension: true, search: 'prefix' },
  { key: 'ItemId', label: 'Item', type: 'string', dimension: true },
  { key: 'CurrencyCode', label: 'Currency', type: 'string', dimension: true },
  { key: 'RemainInventPhysical', label: 'Units remaining', type: 'number', measure: true, format: 'quantity' },
  { key: 'LineAmount', label: 'Line amount', type: 'number', measure: true, format: 'currency' },
  { key: 'ShippingDateRequested', label: 'Requested ship date', type: 'date', format: 'date' },
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
  dateField: 'ShippingDateRequested',
  currencyField: 'CurrencyCode',
} satisfies AnalystSource;

const base = (sections: unknown[]) => ({ title: 'Test report', sections });

describe('validateDefinition', () => {
  it('refuses anything that is not an object', () => {
    for (const raw of [null, undefined, 'a report', 42, []]) {
      expect(validateDefinition(raw, SOURCE).definition).toBeNull();
    }
  });

  it('refuses a definition with no title — there would be nothing to render', () => {
    const result = validateDefinition({ sections: [] }, SOURCE);
    expect(result.definition).toBeNull();
    expect(result.issues[0]).toMatch(/title/i);
  });

  it('keeps a valid definition and fills the density/layout defaults', () => {
    const result = validateDefinition(
      base([{ type: 'metrics', items: [{ label: 'Lines', agg: 'count' }] }]),
      SOURCE,
    );
    expect(result.definition?.density).toBe('standard');
    expect(result.definition?.layout).toBe('analytical');
    expect(result.issues).toEqual([]);
  });

  describe('metrics', () => {
    it('drops a sum of a field the module does not have, and says which', () => {
      const result = validateDefinition(
        base([{ type: 'metrics', items: [{ label: 'Revenue', agg: 'sum', field: 'Revenue' }] }]),
        SOURCE,
      );
      expect(result.definition?.sections).toEqual([]);
      expect(result.issues.join(' ')).toContain('“Revenue”');
    });

    it('refuses to sum a dimension — a total of customer codes is meaningless', () => {
      const result = validateDefinition(
        base([{ type: 'metrics', items: [{ label: 'Customers', agg: 'sum', field: 'CustAccount' }] }]),
        SOURCE,
      );
      expect(result.definition?.sections).toEqual([]);
      expect(result.issues.join(' ')).toMatch(/not a measure/i);
    });

    it('inherits the measure’s own format when none is given', () => {
      const result = validateDefinition(
        base([
          { type: 'metrics', items: [{ label: 'Value', agg: 'sum', field: 'LineAmount' }] },
        ]),
        SOURCE,
      );
      const section = result.definition?.sections[0];
      expect(section?.type === 'metrics' && section.items[0].format).toBe('currency');
    });

    it('needs no totals when every metric is a count', () => {
      const result = validateDefinition(
        base([{ type: 'metrics', items: [{ label: 'Lines', agg: 'count' }] }]),
        SOURCE,
      );
      expect(result.needsTotals).toBe(false);
    });

    it('needs totals as soon as one metric is a sum', () => {
      const result = validateDefinition(
        base([
          {
            type: 'metrics',
            items: [
              { label: 'Lines', agg: 'count' },
              { label: 'Units', agg: 'sum', field: 'RemainInventPhysical' },
            ],
          },
        ]),
        SOURCE,
      );
      expect(result.needsTotals).toBe(true);
    });
  });

  describe('charts', () => {
    it('rewrites a line chart over a nominal dimension into a bar, and declares it', () => {
      const result = validateDefinition(
        base([{ type: 'chart', title: 'By customer', chartType: 'line', groupBy: 'CustAccount', agg: 'count' }]),
        SOURCE,
      );
      const section = result.definition?.sections[0];
      expect(section?.type === 'chart' && section.chartType).toBe('bar');
      expect(result.issues.join(' ')).toMatch(/drawn as a bar chart instead/i);
    });

    it('rewrites a pie over a date field into a line — months are a sequence, not parts of a whole', () => {
      const result = validateDefinition(
        base([{ type: 'chart', title: 'Over time', chartType: 'pie', groupBy: 'ShippingDateRequested', agg: 'count' }]),
        SOURCE,
      );
      const section = result.definition?.sections[0];
      expect(section?.type === 'chart' && section.chartType).toBe('line');
      expect(result.issues.join(' ')).toMatch(/line chart instead/i);
    });

    it('defaults a date group-by to a line and a nominal one to a bar', () => {
      const time = validateDefinition(
        base([{ type: 'chart', title: 'T', groupBy: 'ShippingDateRequested', agg: 'count' }]),
        SOURCE,
      ).definition?.sections[0];
      const nominal = validateDefinition(
        base([{ type: 'chart', title: 'N', groupBy: 'ItemId', agg: 'count' }]),
        SOURCE,
      ).definition?.sections[0];

      expect(time?.type === 'chart' && time.chartType).toBe('line');
      expect(nominal?.type === 'chart' && nominal.chartType).toBe('bar');
    });

    it('drops a chart grouped by a field that is not a dimension', () => {
      const result = validateDefinition(
        base([{ type: 'chart', title: 'Bad', groupBy: 'LineAmount', agg: 'count' }]),
        SOURCE,
      );
      expect(result.definition?.sections).toEqual([]);
      expect(result.issues.join(' ')).toMatch(/not a grouping field/i);
    });
  });

  describe('ranking', () => {
    it('clamps topN to something that is still a ranking', () => {
      const result = validateDefinition(
        base([{ type: 'ranking', title: 'Top', groupBy: 'ItemId', agg: 'count', topN: 500 }]),
        SOURCE,
      );
      const section = result.definition?.sections[0];
      expect(section?.type === 'ranking' && section.topN).toBe(25);
    });

    it('defaults showBars on — a rank without a scale is just a list', () => {
      const result = validateDefinition(
        base([{ type: 'ranking', title: 'Top', groupBy: 'ItemId', agg: 'count' }]),
        SOURCE,
      );
      const section = result.definition?.sections[0];
      expect(section?.type === 'ranking' && section.showBars).toBe(true);
    });
  });

  describe('comparison', () => {
    const metrics = [{ label: 'Lines', agg: 'count' }];

    it('reads the six flat period fields the tool schema asks for', () => {
      const result = validateDefinition(
        base([
          {
            type: 'comparison',
            currentLabel: 'August',
            currentFrom: '2025-08-01',
            currentTo: '2025-08-31',
            previousLabel: 'July',
            previousFrom: '2025-07-01',
            previousTo: '2025-07-31',
            metrics,
          },
        ]),
        SOURCE,
      );
      const section = result.definition?.sections[0];
      expect(section?.type === 'comparison' && section.current).toEqual({
        label: 'August',
        from: '2025-08-01',
        to: '2025-08-31',
      });
    });

    it('still reads the older nested form', () => {
      const result = validateDefinition(
        base([
          {
            type: 'comparison',
            current: { label: 'Q2', from: '2025-04-01', to: '2025-06-30' },
            previous: { label: 'Q1', from: '2025-01-01', to: '2025-03-31' },
            metrics,
          },
        ]),
        SOURCE,
      );
      const section = result.definition?.sections[0];
      expect(section?.type === 'comparison' && section.previous.from).toBe('2025-01-01');
    });

    it('expands a month shorthand into the whole month', () => {
      const result = validateDefinition(
        base([
          {
            type: 'comparison',
            currentFrom: '2025-08',
            previousFrom: '2025-07',
            metrics,
          },
        ]),
        SOURCE,
      );
      const section = result.definition?.sections[0];
      expect(section?.type === 'comparison' && section.current).toMatchObject({
        from: '2025-08-01',
        to: '2025-08-31',
      });
    });

    it('drops the section when a bound is missing — a half comparison is not one', () => {
      const result = validateDefinition(
        base([{ type: 'comparison', currentFrom: '2025-08-01', metrics }]),
        SOURCE,
      );
      expect(result.definition?.sections).toEqual([]);
      expect(result.issues.join(' ')).toMatch(/both periods need/i);
    });

    it('refuses a distinct count over a period — the cube cannot answer it', () => {
      const result = validateDefinition(
        base([
          {
            type: 'comparison',
            currentFrom: '2025-08-01',
            currentTo: '2025-08-31',
            previousFrom: '2025-07-01',
            previousTo: '2025-07-31',
            metrics: [{ label: 'Customers', agg: 'distinctCount', field: 'CustAccount' }],
          },
        ]),
        SOURCE,
      );
      expect(result.definition?.sections).toEqual([]);
      expect(result.issues.join(' ')).toMatch(/distinct counts cannot be measured over a period/i);
    });
  });

  describe('timeline', () => {
    it('drops a timeline over a field that is not a date', () => {
      const result = validateDefinition(
        base([{ type: 'timeline', title: 'When', dateField: 'ItemId', agg: 'count' }]),
        SOURCE,
      );
      expect(result.definition?.sections).toEqual([]);
      expect(result.issues.join(' ')).toMatch(/not a date field/i);
    });

    it('falls back to the module’s own date field', () => {
      const result = validateDefinition(
        base([{ type: 'timeline', title: 'When', agg: 'count' }]),
        SOURCE,
      );
      const section = result.definition?.sections[0];
      expect(section?.type === 'timeline' && section.dateField).toBe('ShippingDateRequested');
    });
  });

  describe('insights and recommendations', () => {
    it('defaults an unlabelled claim to an observation', () => {
      const result = validateDefinition(
        base([{ type: 'insights', points: [{ text: 'Three customers hold half the units' }] }]),
        SOURCE,
      );
      const section = result.definition?.sections[0];
      expect(section?.type === 'insights' && section.points[0].kind).toBe('observation');
    });

    it('keeps an explicit interpretation as an interpretation', () => {
      const result = validateDefinition(
        base([
          { type: 'insights', points: [{ text: 'Likely a fulfilment bottleneck', kind: 'interpretation' }] },
        ]),
        SOURCE,
      );
      const section = result.definition?.sections[0];
      expect(section?.type === 'insights' && section.points[0].kind).toBe('interpretation');
    });

    it('accepts bare strings, because a model will occasionally send them', () => {
      const result = validateDefinition(
        base([{ type: 'insights', points: ['One item dominates'] }]),
        SOURCE,
      );
      const section = result.definition?.sections[0];
      expect(section?.type === 'insights' && section.points).toEqual([
        { text: 'One item dominates', kind: 'observation' },
      ]);
    });

    it('carries a recommendation’s priority and rationale through', () => {
      const result = validateDefinition(
        base([
          {
            type: 'recommendations',
            points: [{ text: 'Chase the top three', priority: 'high', rationale: 'They are 54% of units' }],
          },
        ]),
        SOURCE,
      );
      const section = result.definition?.sections[0];
      expect(section?.type === 'recommendations' && section.points[0]).toEqual({
        text: 'Chase the top three',
        priority: 'high',
        rationale: 'They are 54% of units',
      });
    });

    it('normalises top-level insights into a trailing section', () => {
      const result = validateDefinition(
        { title: 'T', sections: [], insights: [{ text: 'Something', kind: 'observation' }] },
        SOURCE,
      );
      expect(result.definition?.sections).toEqual([
        { type: 'insights', points: [{ text: 'Something', kind: 'observation' }] },
      ]);
    });

    it('does not duplicate top-level insights when a section already carries them', () => {
      const result = validateDefinition(
        {
          title: 'T',
          sections: [{ type: 'insights', points: ['In the section'] }],
          insights: [{ text: 'At the top', kind: 'observation' }],
        },
        SOURCE,
      );
      expect(result.definition?.sections).toHaveLength(1);
    });
  });

  describe('tables and unknown kinds', () => {
    it('keeps the columns that exist and names the ones that do not', () => {
      const result = validateDefinition(
        base([{ type: 'table', columns: ['ItemId', 'Nonsense', 'LineAmount'] }]),
        SOURCE,
      );
      const section = result.definition?.sections[0];
      expect(section?.type === 'table' && section.columns).toEqual(['ItemId', 'LineAmount']);
      expect(result.issues.join(' ')).toContain('“Nonsense”');
    });

    it('drops a section kind it has never heard of', () => {
      const result = validateDefinition(base([{ type: 'sankey', title: 'Flow' }]), SOURCE);
      expect(result.definition?.sections).toEqual([]);
      expect(result.issues.join(' ')).toMatch(/unsupported section type/i);
    });

    it('shape-checks filters and drops malformed clauses', () => {
      const result = validateDefinition(
        {
          title: 'T',
          sections: [{ type: 'metrics', items: [{ label: 'Lines', agg: 'count' }] }],
          filters: [
            { field: 'ItemId', op: 'eq', value: 'A100' },
            { field: 'ItemId', op: 'like', value: 'A' },
            { field: 'ItemId', op: 'eq' },
          ],
        },
        SOURCE,
      );
      expect(result.definition?.filters).toEqual([{ field: 'ItemId', op: 'eq', value: 'A100' }]);
    });
  });
});
