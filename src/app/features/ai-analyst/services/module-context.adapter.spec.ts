import { describe, expect, it } from 'vitest';
import { ANALYST_SOURCES } from '../analyst-sources';
import { AnalystSource } from '../models/analyst-source.model';
import { FieldMeta } from '../models/field-meta.model';
import { ModuleField } from '../models/module-context.model';
import { moduleContextFor, toAiDataContext, toModuleContext } from './module-context.adapter';

/**
 * The adapter is the boundary between a module's QUERY descriptor and anything
 * the AI layer may see, so these tests are mostly about two things:
 *
 * 1. that a role, a type or an aggregation is DERIVED from the registry rather
 *    than assumed — "numeric" must not become "summable", and a capability must
 *    not be advertised unless some code path implements it; and
 * 2. that nothing about HOW to fetch the data can cross the boundary.
 *
 * Registry-backed assertions are deliberately tenant-independent where the
 * descriptor branches on `environment` (Sales Order is composite on one tenant
 * and split on the other), so the suite does not fail on a config change that
 * is not a regression.
 */

function source(id: string): AnalystSource {
  const found = ANALYST_SOURCES.find((s) => s.id === id);
  if (!found) throw new Error(`No such module in the registry: ${id}`);
  return found;
}

function field(fields: readonly ModuleField[], name: string): ModuleField {
  const found = fields.find((f) => f.name === name);
  if (!found) throw new Error(`No such field in the context: ${name}`);
  return found;
}

/** Every string that appears anywhere in the payload, as a whole value. */
function leafStrings(value: unknown, out: string[] = []): string[] {
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) for (const entry of value) leafStrings(entry, out);
  else if (value && typeof value === 'object') {
    for (const entry of Object.values(value)) leafStrings(entry, out);
  }
  return out;
}

// ── Test 1 — Sales Orders ───────────────────────────────────────────────────

describe('module context · Sales Orders', () => {
  const context = moduleContextFor('sales-order')!;

  it('describes the module', () => {
    expect(context).not.toBeNull();
    expect(context.moduleId).toBe('sales-order');
    expect(context.moduleName).toBe('Sales Order');
    expect(context.description).toBeTruthy();
    expect(context.fields.length).toBeGreaterThan(0);
  });

  it('marks the units column a measure and gives it only aggregations we can compute', () => {
    const units = field(context.fields, 'RemainInventPhysical');
    expect(units.role).toBe('measure');
    expect(units.type).toBe('number');
    expect(units.aggregations).toEqual(['sum', 'avg', 'count', 'countDistinct']);
    // The Cube stores a sum and a count per group and nothing else, so a numeric
    // min/max is not on offer however natural it looks.
    expect(units.aggregations).not.toContain('min');
  });

  it('separates money from bare quantities', () => {
    expect(field(context.fields, 'LineAmount').type).toBe('currency');
    expect(field(context.fields, 'QtyOrdered').type).toBe('number');
  });

  it('reads roles off the flags, not off the type', () => {
    expect(field(context.fields, 'CustAccount').role).toBe('dimension');
    // A free-text description is neither groupable nor summable.
    expect(field(context.fields, 'Name').role).toBe('attribute');
    expect(field(context.fields, 'Name').aggregations).toEqual(['count', 'countDistinct']);
  });

  it('flags the currency column', () => {
    expect(field(context.fields, 'CurrencyCode').currency).toBe(true);
    expect(context.currencyField).toBe('CurrencyCode');
  });

  it('gives the time axis min/max, and nothing else', () => {
    expect(context.timeAxis).toBeTruthy();
    const axis = field(context.fields, context.timeAxis!);
    expect(axis.timeAxis).toBe(true);
    expect(axis.aggregations).toContain('min');
    expect(axis.aggregations).toContain('max');

    const others = context.fields.filter((f) => f.name !== context.timeAxis);
    expect(others.every((f) => !f.aggregations.includes('min'))).toBe(true);
  });

  it('offers a date window on the axis, a search, and one filter per field', () => {
    const dateRange = context.filters.find((f) => f.kind === 'dateRange');
    expect(dateRange).toBeDefined();
    expect(dateRange).toMatchObject({ field: context.timeAxis, endBound: 'exclusive' });

    expect(context.filters.some((f) => f.kind === 'search')).toBe(true);
    expect(context.filters.filter((f) => f.kind === 'field')).toHaveLength(context.fields.length);
  });

  it('reports what the pipeline can actually do', () => {
    expect(context.capabilities.count).toBe(true);
    expect(context.capabilities.aggregate).toBe(true);
    expect(context.capabilities.dateBounds).toBe(true);
    // A source is one entity — the query layer cannot join.
    expect(context.capabilities.join).toBe(false);
    expect(context.capabilities.maxAnalyzeRows).toBeGreaterThan(0);
  });
});

// ── Test 2 — Inventory ──────────────────────────────────────────────────────

describe('module context · Inventory', () => {
  const context = moduleContextFor('inventory')!;

  it('resolves from the shared registry', () => {
    expect(context).not.toBeNull();
    expect(context.moduleId).toBe('inventory');
    expect(context.moduleName).toBe('Inventory');
  });

  it('has no time axis, so offers no date window and no min/max anywhere', () => {
    // On-hand is a snapshot, not a ledger. This is the module that proves a
    // date filter is not assumed into existence.
    expect(context.timeAxis).toBeUndefined();
    expect(context.capabilities.dateBounds).toBe(false);
    expect(context.filters.some((f) => f.kind === 'dateRange')).toBe(false);
    expect(context.fields.every((f) => !f.aggregations.includes('min'))).toBe(true);
  });

  it('separates the quantity measures from the grouping columns', () => {
    expect(field(context.fields, 'OnHandQuantity').role).toBe('measure');
    expect(field(context.fields, 'InventoryWarehouseId').role).toBe('dimension');
    expect(field(context.fields, 'dataAreaId').role).toBe('dimension');
    expect(context.measures).toContain('OnHandQuantity');
    expect(context.dimensions).toContain('InventorySiteId');
  });

  it('reports searchability from what the query actually searches', () => {
    expect(field(context.fields, 'ItemNumber').searchable).toBe('prefix');
    expect(field(context.fields, 'ProductName').searchable).toBe('contains');
    expect(field(context.fields, 'OnHandQuantity').searchable).toBeUndefined();
  });

  it('has no currency column', () => {
    expect(context.currencyField).toBeUndefined();
  });
});

// ── Enums, and the strongest case for redaction ─────────────────────────────

describe('module context · enum fields', () => {
  const context = moduleContextFor('purchase-order')!;

  it('carries the members and restricts the operators', () => {
    const status = field(context.fields, 'PurchaseOrderStatus');
    expect(status.type).toBe('enum');
    expect(status.enumValues).toContain('Backorder');

    const filter = context.filters.find((f) => f.kind === 'field' && f.field === status.name);
    // D365 rejects an ordered comparison on an enum, so only equality is offered.
    expect(filter).toMatchObject({ operators: ['eq', 'neq'] });
  });

  it('does not invent a measure for a header entity that has none', () => {
    // PurchaseOrderHeadersV2 carries no amount or quantity column at all.
    expect(context.measures).toEqual([]);
    expect(context.fields.every((f) => f.role !== 'measure')).toBe(true);
  });
});

// ── Test 3 — Unknown module ─────────────────────────────────────────────────

describe('module context · unknown module', () => {
  it('returns null rather than throwing or guessing', () => {
    expect(moduleContextFor('returns')).toBeNull();
    expect(moduleContextFor('')).toBeNull();
    // A prototype key must not resolve to something.
    expect(moduleContextFor('constructor')).toBeNull();
  });
});

// ── Test 4 — Missing / minimal field metadata ───────────────────────────────

describe('module context · sparse metadata', () => {
  function stub(overrides: Partial<AnalystSource>): AnalystSource {
    return {
      id: 'stub',
      label: 'Stub',
      fields: [],
      suggestions: [],
      entity: 'StubEntity',
      dataPath: '/data',
      authConfig: {} as AnalystSource['authConfig'],
      crossCompany: false,
      baseFilter: '',
      keyField: ['Id'],
      select: '',
      searchFields: [],
      ...overrides,
    };
  }

  it('survives a module with no fields at all', () => {
    const context = toModuleContext(stub({}));
    expect(context.fields).toEqual([]);
    expect(context.dimensions).toEqual([]);
    expect(context.measures).toEqual([]);
    expect(context.filters).toEqual([]);
    // Nothing to group and nothing to total.
    expect(context.capabilities.aggregate).toBe(false);
    expect(context.capabilities.search).toBe(false);
  });

  it('handles a field carrying nothing but a key, a label and a type', () => {
    const bare: FieldMeta = { key: 'Ref', label: 'Reference', type: 'string' };
    const context = toModuleContext(stub({ fields: [bare] }));
    const only = context.fields[0];

    expect(only.type).toBe('string');
    // Neither flag set, so neither role is claimed.
    expect(only.role).toBe('attribute');
    expect(only.aggregations).toEqual(['count', 'countDistinct']);
    expect(only.enumValues).toBeUndefined();
    expect(only.searchable).toBeUndefined();
    expect(only.timeAxis).toBeUndefined();
  });

  it('does not claim an enum has members when it declares none', () => {
    const context = toModuleContext(
      stub({ fields: [{ key: 'S', label: 'S', type: 'enum', enumType: 'X' }] }),
    );
    expect(context.fields[0].enumValues).toBeUndefined();
    const filter = context.filters.find((f) => f.kind === 'field');
    expect(filter).toMatchObject({ operators: ['eq', 'neq'] });
    expect(filter && 'values' in filter ? filter.values : undefined).toBeUndefined();
  });

  it('names a date window after the column when the field itself is missing', () => {
    // A descriptor pointing `dateField` at a column absent from `fields` is a
    // broken registry entry. It must still produce a usable filter rather than
    // an entry labelled "undefined".
    const context = toModuleContext(stub({ dateField: 'GhostDate' }));
    expect(context.filters[0]).toMatchObject({
      kind: 'dateRange',
      field: 'GhostDate',
      label: 'GhostDate',
    });
  });

  it('reports a field as unsearchable when only the metadata says otherwise', () => {
    // `FieldMeta.search` and `searchFields` are maintained separately and can
    // drift. Only `searchFields` is what the query actually uses.
    const context = toModuleContext(
      stub({
        fields: [{ key: 'A', label: 'A', type: 'string', search: 'prefix' }],
        searchFields: [],
      }),
    );
    expect(context.fields[0].searchable).toBeUndefined();
    expect(context.capabilities.search).toBe(false);
  });
});

// ── Test 5 — Module switching ───────────────────────────────────────────────

describe('module context · switching', () => {
  it('produces the right context every time, in any order', () => {
    const order = ['sales-order', 'inventory', 'transaction', 'inventory', 'sales-order'];

    for (const id of order) {
      const context = moduleContextFor(id);
      expect(context?.moduleId).toBe(id);
    }
  });

  it('does not leak one module’s fields into another', () => {
    const sales = moduleContextFor('sales-order')!;
    const inventory = moduleContextFor('inventory')!;
    const transaction = moduleContextFor('transaction')!;

    expect(inventory.fields.some((f) => f.name === 'RemainInventPhysical')).toBe(false);
    expect(sales.fields.some((f) => f.name === 'OnHandQuantity')).toBe(false);
    expect(transaction.fields.some((f) => f.name === 'OnHandQuantity')).toBe(false);
  });

  it('is stable — describing the same module twice gives the same answer', () => {
    expect(moduleContextFor('transaction')).toEqual(moduleContextFor('transaction'));
  });

  it('covers every module in the registry', () => {
    for (const registered of ANALYST_SOURCES) {
      const context = moduleContextFor(registered.id);
      expect(context, `no context for ${registered.id}`).not.toBeNull();
      expect(context!.fields).toHaveLength(registered.fields.length);
    }
  });
});

// ── The redaction ───────────────────────────────────────────────────────────

describe('AI data context · what may not cross the boundary', () => {
  it('carries the module, its fields, its filters and its capabilities', () => {
    const context = moduleContextFor('inventory')!;
    const ai = toAiDataContext(context);

    expect(ai.module).toEqual({
      id: 'inventory',
      name: 'Inventory',
      description: context.description,
    });
    expect(ai.fields).toHaveLength(context.fields.length);
    expect(ai.filters).toHaveLength(context.filters.length);
    expect(ai.capabilities).toEqual(context.capabilities);
    // Nothing has been counted, so there is no data section — which says "not
    // read yet" rather than implying zero rows.
    expect(ai.data).toBeUndefined();
  });

  it('drops the UI-side detail the filters and capabilities already state', () => {
    const ai = toAiDataContext(moduleContextFor('inventory')!);
    for (const field of ai.fields) {
      expect(field).not.toHaveProperty('searchable');
      expect(field).not.toHaveProperty('timeAxis');
      expect(field).not.toHaveProperty('currency');
    }
  });

  it('never carries transport, credentials or D365 internals', () => {
    for (const registered of ANALYST_SOURCES) {
      const ai = toAiDataContext(moduleContextFor(registered.id)!);
      const values = leafStrings(ai);
      const serialised = JSON.stringify(ai);

      // Matched as whole VALUES, not substrings: a leak copies one of these
      // verbatim, whereas a substring check has false positives on legitimate
      // data — `Sha_SerialTransType` is a real column name and it contains the
      // entity name `Sha_SerialTrans`.
      expect(values, registered.id).not.toContain(registered.entity);
      expect(values, registered.id).not.toContain(registered.dataPath);
      expect(values, registered.id).not.toContain(registered.select);
      expect(values, registered.id).not.toContain(registered.authConfig.clientId);
      expect(values, registered.id).not.toContain(registered.authConfig.scope);
      expect(values, registered.id).not.toContain(registered.baseFilter);

      // The OData enum TYPE name is what SpecCompilerService needs to build a
      // literal. The model needs the members, which it gets, and nothing else.
      //
      // Skipped where the type and the column share a name — on
      // `Sha_SerialTransType` they are the same string, so the column name the
      // payload legitimately carries is indistinguishable from the type name,
      // and the assertion would fail on correct output. The two modules where
      // they genuinely differ (`PurchaseOrderStatus` -> `PurchStatus`,
      // `DocumentApprovalStatus` -> `VersioningDocumentState`) are the ones that
      // make this check mean anything, and they are still covered.
      for (const meta of registered.fields) {
        if (!meta.enumType || meta.enumType === meta.key) continue;
        expect(values, meta.key).not.toContain(meta.enumType);
      }
      // Starter-chip copy is UI, not analysis.
      for (const suggestion of registered.suggestions) {
        expect(values, registered.id).not.toContain(suggestion);
      }

      // A credential or a query expression cannot collide with a column name,
      // so those also get the stricter substring check — it catches a leak that
      // was concatenated into a longer string rather than copied whole.
      expect(serialised, registered.id).not.toContain(registered.authConfig.clientId);
      expect(serialised, registered.id).not.toContain(registered.authConfig.scope);
      if (registered.baseFilter) {
        expect(serialised, registered.id).not.toContain(registered.baseFilter);
      }
    }
  });

  it('attaches data AVAILABILITY when it is known, never rows', () => {
    const ai = toAiDataContext(moduleContextFor('sales-order')!, {
      rowCount: 296,
      coverage: 'exact',
      totalsAvailable: true,
      slice: { from: '2025-01-01' },
    });

    expect(ai.data).toMatchObject({ rowCount: 296, coverage: 'exact', totalsAvailable: true });
    expect(ai.data).not.toHaveProperty('rows');
    expect(ai.data).not.toHaveProperty('sample');
  });
});
