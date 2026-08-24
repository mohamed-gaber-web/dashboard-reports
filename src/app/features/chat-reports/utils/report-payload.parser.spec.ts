import { describe, expect, it } from 'vitest';
import { extractJsonObject, parseReportPayload } from './report-payload.parser';
import { ChartComponentSpec, TableComponentSpec } from '../models/report-payload.model';

/**
 * These cover the failure modes the parser exists for — malformed, hostile, or
 * merely sloppy input that must never reach a template. The happy path is the
 * least interesting case here.
 */
describe('extractJsonObject', () => {
  it('reads a bare object', () => {
    expect(extractJsonObject('{"a":1}')).toEqual({ a: 1 });
  });

  it('strips a ```json fence', () => {
    expect(extractJsonObject('```json\n{"a":1}\n```')).toEqual({ a: 1 });
  });

  it('skips a conversational preamble', () => {
    expect(extractJsonObject('Sure! Here you go:\n{"a":1}')).toEqual({ a: 1 });
  });

  it('does not stop at a brace inside a string value', () => {
    expect(extractJsonObject('{"a":"}","b":2}')).toEqual({ a: '}', b: 2 });
  });

  it('does not stop at an escaped quote', () => {
    expect(extractJsonObject('{"a":"say \\"}\\" ok","b":2}')).toEqual({ a: 'say "}" ok', b: 2 });
  });

  it('handles nesting', () => {
    expect(extractJsonObject('{"a":{"b":{"c":1}}}')).toEqual({ a: { b: { c: 1 } } });
  });

  it('returns null for text with no object', () => {
    expect(extractJsonObject('no json here')).toBeNull();
  });

  it('returns null for a truncated object rather than throwing', () => {
    expect(extractJsonObject('{"a":1')).toBeNull();
  });
});

describe('parseReportPayload', () => {
  const minimal = { text_response: 'Here is your report.', components: [] };

  it('returns null for a non-object', () => {
    expect(parseReportPayload(null)).toBeNull();
    expect(parseReportPayload(42)).toBeNull();
    expect(parseReportPayload([1, 2])).toBeNull();
  });

  it('returns null when there is neither prose nor components', () => {
    expect(parseReportPayload({ text_response: '', components: [] })).toBeNull();
  });

  it('accepts a JSON string body', () => {
    expect(parseReportPayload(JSON.stringify(minimal))?.text_response).toBe('Here is your report.');
  });

  it('accepts prose wrapping JSON', () => {
    const body = 'Here:\n```json\n' + JSON.stringify(minimal) + '\n```';
    expect(parseReportPayload(body)?.text_response).toBe('Here is your report.');
  });

  it('defaults an unknown template_type rather than dropping the reply', () => {
    const result = parseReportPayload({ ...minimal, template_type: 'wat' });
    expect(result?.template_type).toBe('custom_report');
  });

  it('fills every required field so templates never guard for undefined', () => {
    const result = parseReportPayload(minimal);
    expect(result).toMatchObject({
      suggested_actions: [],
      template_type: 'custom_report',
      components: [],
      dropped: [],
    });
  });

  it('drops an unsupported component type', () => {
    const result = parseReportPayload({
      ...minimal,
      components: [{ type: 'iframe', src: 'https://evil.example' }],
    });
    expect(result?.components).toEqual([]);
  });

  describe('kpi_grid', () => {
    it('drops a tile missing its label or value', () => {
      const result = parseReportPayload({
        ...minimal,
        components: [
          {
            type: 'kpi_grid',
            items: [
              { label: 'Revenue', value: '$1' },
              { label: 'No value' },
              { value: 'no label' },
            ],
          },
        ],
      });
      expect(result?.components[0]).toMatchObject({
        type: 'kpi_grid',
        items: [{ label: 'Revenue', value: '$1' }],
      });
    });

    it('infers isPositive from the sign when the model omits it', () => {
      const result = parseReportPayload({
        ...minimal,
        components: [
          {
            type: 'kpi_grid',
            items: [
              { label: 'Up', value: '1', change: '+5%' },
              { label: 'Down', value: '1', change: '-5%' },
            ],
          },
        ],
      });
      const items = (result?.components[0] as { items: { isPositive?: boolean }[] }).items;
      expect(items[0].isPositive).toBe(true);
      expect(items[1].isPositive).toBe(false);
    });

    it('keeps an explicit isPositive that contradicts the sign', () => {
      // Falling costs are good. The model's judgement wins over the arithmetic.
      const result = parseReportPayload({
        ...minimal,
        components: [
          {
            type: 'kpi_grid',
            items: [{ label: 'Cost', value: '$1', change: '-12%', isPositive: true }],
          },
        ],
      });
      const items = (result?.components[0] as { items: { isPositive?: boolean }[] }).items;
      expect(items[0].isPositive).toBe(true);
    });

    it('drops the whole grid when no tile survives', () => {
      const result = parseReportPayload({
        ...minimal,
        components: [{ type: 'kpi_grid', items: [{ label: 'only' }] }],
      });
      expect(result?.components).toEqual([]);
    });
  });

  describe('chart', () => {
    const chart = (over: Record<string, unknown>) => {
      const result = parseReportPayload({
        ...minimal,
        components: [
          {
            type: 'chart',
            chart_type: 'bar',
            title: 'T',
            labels: ['a', 'b'],
            datasets: [{ label: 's', data: [1, 2] }],
            ...over,
          },
        ],
      });
      return result?.components[0] as ChartComponentSpec | undefined;
    };

    it('trims labels and data to a common length so values line up', () => {
      // The real failure this guards: a 5-label axis with 3 data points would
      // otherwise plot Mar's value against Jan.
      const result = chart({ labels: ['a', 'b', 'c', 'd'], datasets: [{ label: 's', data: [1, 2] }] });
      expect(result?.labels).toEqual(['a', 'b']);
      expect(result?.datasets[0].data).toEqual([1, 2]);
    });

    it('coerces a formatted string to a number', () => {
      expect(chart({ datasets: [{ label: 's', data: ['1,240', '$54,200'] }] })?.datasets[0].data)
        .toEqual([1240, 54200]);
    });

    it('falls back to bar for an unknown chart_type', () => {
      expect(chart({ chart_type: 'radar' })?.chart_type).toBe('bar');
    });

    it('keeps only the first series for a pie', () => {
      const result = chart({
        chart_type: 'pie',
        datasets: [
          { label: 'keep', data: [1, 2] },
          { label: 'drop', data: [3, 4] },
        ],
      });
      expect(result?.datasets).toHaveLength(1);
      expect(result?.datasets[0].label).toBe('keep');
    });

    it('drops a chart with no labels', () => {
      expect(chart({ labels: [] })).toBeUndefined();
    });

    it('drops a chart with no numeric series', () => {
      expect(chart({ datasets: [] })).toBeUndefined();
    });
  });

  describe('table', () => {
    const table = (over: Record<string, unknown>) => {
      const result = parseReportPayload({
        ...minimal,
        components: [
          { type: 'table', title: 'T', headers: ['A', 'B'], rows: [['1', '2']], ...over },
        ],
      });
      return result?.components[0] as TableComponentSpec | undefined;
    };

    it('pads a short row instead of dropping it', () => {
      expect(table({ rows: [['1']] })?.rows).toEqual([['1', '']]);
    });

    it('truncates a row longer than its headers', () => {
      expect(table({ rows: [['1', '2', '3']] })?.rows).toEqual([['1', '2']]);
    });

    it('drops a non-array row', () => {
      expect(table({ rows: [['1', '2'], 'nope'] })?.rows).toEqual([['1', '2']]);
    });

    it('drops a table with no headers', () => {
      expect(table({ headers: [] })).toBeUndefined();
    });

    it('caps the row count', () => {
      const rows = Array.from({ length: 500 }, (_, i) => [String(i), 'x']);
      expect(table({ rows })?.rows.length).toBe(200);
    });
  });
});
