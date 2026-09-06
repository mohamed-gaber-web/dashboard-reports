import { describe, expect, it } from 'vitest';
import { ModuleContext } from '../../ai-analyst/models/module-context.model';
import { DataContext } from '../../ai-analyst/services/data-context.service';
import { buildLabContext, describeSlice } from './lab-context.builder';

/**
 * The context builder's tests.
 *
 * The whole grounding argument for this screen is "the model was told these
 * figures and nothing else", so the properties worth asserting are: the real
 * aggregates are present, the coverage state is stated UNAMBIGUOUSLY, a filter is
 * declared rather than implied, and no transport detail leaks into a prompt.
 */

const MODULE: ModuleContext = {
  moduleId: 'sales-order',
  moduleName: 'Sales Order',
  description: 'Open backorder lines with remaining physical inventory',
  fields: [
    {
      name: 'LineAmount',
      label: 'Line Amount',
      type: 'currency',
      role: 'measure',
      aggregations: ['sum', 'avg', 'count', 'countDistinct'],
    },
    {
      name: 'CustAccount',
      label: 'Customer',
      type: 'string',
      role: 'dimension',
      aggregations: ['count', 'countDistinct'],
      searchable: 'prefix',
    },
    {
      name: 'SalesId',
      label: 'Order',
      type: 'string',
      role: 'attribute',
      aggregations: ['count', 'countDistinct'],
    },
    {
      name: 'ShippingDateRequested',
      label: 'Requested Ship Date',
      type: 'date',
      role: 'dimension',
      aggregations: ['count', 'countDistinct', 'min', 'max'],
      timeAxis: true,
    },
  ],
  dimensions: ['CustAccount', 'ShippingDateRequested'],
  measures: ['LineAmount'],
  filters: [
    {
      kind: 'dateRange',
      field: 'ShippingDateRequested',
      label: 'Requested Ship Date',
      endBound: 'exclusive',
    },
  ],
  timeAxis: 'ShippingDateRequested',
  capabilities: {
    count: true,
    aggregate: true,
    dateBounds: true,
    search: true,
    paging: true,
    join: false,
    maxAnalyzeRows: 250_000,
    serverPageSize: 10_000,
  },
};

const EXACT: DataContext = {
  rowCount: 1284,
  schema: [{ name: 'LineAmount', label: 'Line Amount', type: 'number' }],
  summary: { rowCount: 1284, sum_LineAmount: 92_400.5, top_CustAccount: [{ value: 'C-100', count: 51 }] },
  sample: [{ SalesId: 'SO-1', LineAmount: 120 }],
  coverage: 'exact',
};

const PENDING: DataContext = { ...EXACT, coverage: 'pending', summary: { rowCount: 11_000_000 } };

describe('describeSlice', () => {
  it('is empty when nothing is narrowed', () => {
    expect(describeSlice({}, MODULE)).toBe('');
  });

  it('names the date field a range applies to', () => {
    expect(describeSlice({ from: '2025-01-01', to: '2025-03-31' }, MODULE)).toBe(
      'dates on `ShippingDateRequested` from 2025-01-01 to 2025-03-31',
    );
  });

  it('handles an open-ended range and a search term together', () => {
    expect(describeSlice({ from: '2025-01-01', search: 'ACME' }, MODULE)).toBe(
      'dates on `ShippingDateRequested` from 2025-01-01 onwards, text search “ACME”',
    );
  });
});

describe('buildLabContext', () => {
  it('carries the module, its fields by role, and the real aggregates', () => {
    const md = buildLabContext({ module: MODULE, data: EXACT, filter: {} });

    expect(md).toContain('## Module');
    expect(md).toContain('Sales Order');
    // Roles matter more than types: they are the difference between "numeric" and
    // "may legitimately be totalled".
    expect(md).toContain('**Measures**');
    expect(md).toContain('`LineAmount`');
    expect(md).toContain('**Dimensions**');
    expect(md).toContain('`CustAccount`');
    expect(md).toContain('**Attributes**');
    expect(md).toContain('92400.5');
  });

  it('states that totals are exact when the slice was folded', () => {
    const md = buildLabContext({ module: MODULE, data: EXACT, filter: {} });

    expect(md).toContain('Totals are **exact**');
    expect(md).toContain('1,284 rows');
  });

  it('states unambiguously that there are NO totals when the slice was not folded', () => {
    // The failure this prevents is the worst one available on this contract: the
    // model confidently totalling a column it was never given.
    const md = buildLabContext({ module: MODULE, data: PENDING, filter: {} });

    expect(md).toContain('Totals are **NOT AVAILABLE**');
    expect(md).toContain('no sums');
  });

  it('declares a filter, and says the figures cover only those rows', () => {
    const md = buildLabContext({
      module: MODULE,
      data: EXACT,
      filter: { from: '2025-01-01', to: '2025-03-31' },
    });

    expect(md).toContain('## Current Filters');
    expect(md).toContain('from 2025-01-01 to 2025-03-31');
    expect(md).toContain('ONLY those rows');
    expect(md).toContain('Never describe these figures as the whole module');
  });

  it('says so plainly when nothing is filtered', () => {
    const md = buildLabContext({ module: MODULE, data: EXACT, filter: {} });

    expect(md).toContain('None — the figures below cover the whole module');
  });

  it('includes the data’s own date range when it is known', () => {
    const md = buildLabContext({
      module: MODULE,
      data: EXACT,
      filter: {},
      dateRange: { field: 'ShippingDateRequested', min: '2023-01-04', max: '2025-08-30' },
    });

    expect(md).toContain('2023-01-04 → 2025-08-30');
  });

  it('forbids a currency label when the module has no currency column', () => {
    // Observed live: given an `Amount` column and no currency field, the model
    // labelled every total "KWD" — a code that appears nowhere in the data.
    const md = buildLabContext({ module: MODULE, data: EXACT, filter: {} });

    expect(md).toContain('NO currency column');
    expect(md).toContain('Do NOT attach a currency name, code or symbol');
  });

  it('names the currency column when the module has one', () => {
    const md = buildLabContext({
      module: { ...MODULE, currencyField: 'CurrencyCode' },
      data: EXACT,
      filter: {},
    });

    expect(md).toContain('`CurrencyCode`');
    expect(md).toContain('never substitute a different one');
  });

  it('marks the sample rows as illustrative and never as the dataset', () => {
    const md = buildLabContext({ module: MODULE, data: EXACT, filter: {} });

    expect(md).toContain('Illustrative only');
    expect(md).toContain('Never total them');
  });

  it('leaks no transport detail into the prompt', () => {
    // `ModuleContext` cannot carry these by construction (see
    // module-context.adapter.ts). This asserts the property end to end, so a
    // future change that widens the context is caught here rather than in a
    // prompt someone reads six months later.
    const md = buildLabContext({
      module: MODULE,
      data: EXACT,
      filter: {},
      dateRange: { field: 'ShippingDateRequested', min: '2023-01-04' },
    });

    for (const secret of ['dataAreaId', 'GP_SalesHeaderAndLineData', 'clientId', 'tenantId', 'dynamics.com', '$filter']) {
      expect(md).not.toContain(secret);
    }
  });
});
