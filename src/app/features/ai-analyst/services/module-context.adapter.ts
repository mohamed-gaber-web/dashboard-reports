import { D365_MAX_PAGE_SIZE } from '../../../core/models/odata.model';
import { MAX_ANALYZE_ROWS } from '../../../core/aggregation/aggregate-plan.model';
import { SEARCH_MIN_LENGTH } from '../../../core/http/odata-filter.util';
import { ANALYST_SOURCES } from '../analyst-sources';
import { AnalystSource } from '../models/analyst-source.model';
import { FieldMeta } from '../models/field-meta.model';
import {
  AiDataContext,
  AiFieldDefinition,
  AiFilterDefinition,
  ModuleAggregation,
  ModuleCapabilities,
  ModuleContext,
  ModuleDataAvailability,
  ModuleField,
  ModuleFieldRole,
  ModuleFieldType,
  ModuleFilter,
  ModuleFilterOperator,
} from '../models/module-context.model';

/**
 * Maps a module's query descriptor onto its analytical description, and that
 * onto the AI-facing payload.
 *
 * Pure functions — no Angular, no I/O, no state — for the same reason
 * `report-plan.ts` and `report-payload.parser.ts` are: this is a boundary, and a
 * boundary is worth testing without a TestBed.
 *
 * ## The two rules
 *
 * **1. Derive, never author.** Every value below is read off `AnalystSource` and
 * `FieldMeta`. There is no `if (moduleId === 'sales-order')` and there must
 * never be one: the registry is the single source of truth, so a module added to
 * `ANALYST_SOURCES` gets a correct context for free and a module whose schema
 * changes cannot leave a stale copy behind here.
 *
 * **2. Advertise only what the pipeline can do.** A capability named here is a
 * capability some existing code path actually implements. `min`/`max` appear on
 * the date field alone because `dateBoundsRaw` is wired for that field alone;
 * there is no numeric `min`/`max` because the `Cube` stores a sum and a count
 * and nothing else. Offering more would produce a plan the engine cannot
 * execute, which is the failure `report-plan.ts` exists to catch — better not to
 * offer it.
 *
 * ## What is deliberately withheld
 *
 * `entity`, `dataPath`, `authConfig`, `crossCompany`, `baseFilter`, `keyField`
 * and `select` describe HOW to fetch, not what the data means. None of them
 * helps a model design a report, `authConfig` must never leave the browser, and
 * `baseFilter`/`entity` would let model output describe a query surface it has
 * no business naming. `enumType` is withheld too: it is the D365 OData type name
 * (`PurchStatus` for `PurchaseOrderStatus`), needed only by
 * `SpecCompilerService` when it builds the literal — the model needs the
 * MEMBERS, which it gets. `suggestions` is UI copy for a starter-chip row.
 *
 * `module-context.adapter.spec.ts` asserts that none of them can reappear.
 */

/** Everything a measure can be reduced to. See {@link ModuleAggregation}. */
const MEASURE_AGGREGATIONS: readonly ModuleAggregation[] = [
  'sum',
  'avg',
  'count',
  'countDistinct',
];

/** What is left when a field cannot be totalled: you can still count it. */
const COUNTABLE_AGGREGATIONS: readonly ModuleAggregation[] = ['count', 'countDistinct'];

/** Exact and cheap via `$orderby` + `$top=1`, but wired for the date field only. */
const BOUND_AGGREGATIONS: readonly ModuleAggregation[] = ['min', 'max'];

/**
 * Operators per field type, mirroring what `SpecCompilerService.clause()` will
 * actually compile.
 *
 * Enums take `eq`/`ne` only — the compiler throws on anything else, because
 * D365 rejects an ordered comparison on an enum. `contains` is text-only for the
 * same reason. Ordered operators are omitted for `string`: the compiler would
 * emit `Field gt 'x'` happily, but lexicographic ordering of an item code is not
 * a question anyone means to ask, and advertising it invites a filter that
 * "works" and selects nonsense.
 */
const OPERATORS: Record<FieldMeta['type'], readonly ModuleFilterOperator[]> = {
  enum: ['eq', 'neq'],
  string: ['eq', 'neq', 'contains'],
  number: ['eq', 'neq', 'gt', 'gte', 'lt', 'lte'],
  date: ['eq', 'neq', 'gt', 'gte', 'lt', 'lte'],
};

/**
 * The analytical type of a field.
 *
 * `FieldType` says what OData needs to build a literal; `ValueFormat` says how
 * the engine renders it. Neither alone tells a model that `LineAmount` is money
 * and `QtyOrdered` is not, which changes whether summing them and putting both
 * on one axis makes sense — so the two are combined here.
 */
export function moduleFieldType(meta: FieldMeta): ModuleFieldType {
  if (meta.type === 'enum') return 'enum';
  if (meta.type === 'date') return 'date';
  if (meta.type === 'number') {
    if (meta.format === 'currency') return 'currency';
    if (meta.format === 'percent') return 'percent';
    return 'number';
  }
  return 'string';
}

/**
 * How a field may be used.
 *
 * Read off the explicit flags, never inferred from the type — `SerialTransRecId`
 * is numeric in D365 and summing it is meaningless, which is exactly why the
 * field files type it as a string and leave both flags off.
 *
 * No field in the registry sets both flags; if one ever did, `measure` wins,
 * because grouping a column by itself is the less useful of the two readings.
 */
export function moduleFieldRole(meta: FieldMeta): ModuleFieldRole {
  if (meta.measure) return 'measure';
  if (meta.dimension) return 'dimension';
  return 'attribute';
}

/** What can be computed over one field, given the module it belongs to. */
export function aggregationsFor(meta: FieldMeta, source: AnalystSource): ModuleAggregation[] {
  const base = meta.measure ? MEASURE_AGGREGATIONS : COUNTABLE_AGGREGATIONS;
  const bounded = meta.key === source.dateField ? BOUND_AGGREGATIONS : [];
  return [...base, ...bounded];
}

/**
 * One field, normalized.
 *
 * `searchable` is derived from the module's `searchFields`, NOT from
 * `FieldMeta.search`. The two are maintained separately and can drift, and only
 * `searchFields` is what `AnalystDataService.buildFilter` actually queries — so
 * a field marked `search: 'prefix'` that the module's search does not cover is
 * reported here as not searchable, which is the truth.
 */
export function toModuleField(meta: FieldMeta, source: AnalystSource): ModuleField {
  const searched = source.searchFields.find((s) => s.field === meta.key);

  return {
    name: meta.key,
    label: meta.label,
    type: moduleFieldType(meta),
    role: moduleFieldRole(meta),
    aggregations: aggregationsFor(meta, source),
    ...(meta.enumMembers?.length ? { enumValues: [...meta.enumMembers] } : {}),
    ...(searched ? { searchable: searched.mode } : {}),
    ...(meta.key === source.dateField ? { timeAxis: true as const } : {}),
    ...(meta.key === source.currencyField ? { currency: true as const } : {}),
  };
}

/**
 * Every way this module can be narrowed.
 *
 * Three kinds, each backed by a real code path: the date window
 * (`dateRange()`), the search box (`buildSearchFilter()`), and per-field
 * comparison (`SpecCompilerService.compile()`). A module with no date column
 * gets no `dateRange` entry — rendering one anyway builds a filter that matches
 * everything and a user who thinks it worked.
 *
 * A `field` entry is emitted for EVERY field, because that is the true extent of
 * the capability. Deciding which subset is worth spending prompt tokens on is a
 * prompt-construction question and belongs to whichever task builds the prompt.
 */
export function buildFilters(source: AnalystSource): ModuleFilter[] {
  const filters: ModuleFilter[] = [];
  const byKey = new Map(source.fields.map((f) => [f.key, f]));

  if (source.dateField) {
    const meta = byKey.get(source.dateField);
    filters.push({
      kind: 'dateRange',
      field: source.dateField,
      label: meta?.label ?? source.dateField,
      endBound: 'exclusive',
    });
  }

  if (source.searchFields.length) {
    filters.push({
      kind: 'search',
      label: 'Text search',
      minLength: SEARCH_MIN_LENGTH,
      fields: source.searchFields.map((s) => ({
        field: s.field,
        label: byKey.get(s.field)?.label ?? s.field,
        mode: s.mode,
      })),
    });
  }

  for (const meta of source.fields) {
    filters.push({
      kind: 'field',
      field: meta.key,
      label: meta.label,
      operators: OPERATORS[meta.type],
      ...(meta.enumMembers?.length ? { values: [...meta.enumMembers] } : {}),
    });
  }

  return filters;
}

/**
 * What the read pipeline can do over this module.
 *
 * Mostly a property of the architecture rather than of the module: D365 F&O
 * OData has no `$apply`, no `groupby` and no `SUM`, so `aggregate` means "the
 * in-browser fold can run", which needs something to group or total and a slice
 * under {@link MAX_ANALYZE_ROWS}.
 */
export function capabilitiesFor(source: AnalystSource): ModuleCapabilities {
  const groupable = source.fields.some((f) => f.dimension || f.measure);

  return {
    count: true,
    aggregate: groupable,
    dateBounds: !!source.dateField,
    search: source.searchFields.length > 0,
    paging: true,
    // A source is one entity. See `AnalystSource` — the analyst cannot join.
    join: false,
    maxAnalyzeRows: MAX_ANALYZE_ROWS,
    serverPageSize: D365_MAX_PAGE_SIZE,
  };
}

/** A module's query descriptor, normalized into its analytical description. */
export function toModuleContext(source: AnalystSource): ModuleContext {
  const fields = source.fields.map((meta) => toModuleField(meta, source));

  return {
    moduleId: source.id,
    moduleName: source.label,
    ...(source.description ? { description: source.description } : {}),
    fields,
    dimensions: fields.filter((f) => f.role === 'dimension').map((f) => f.name),
    measures: fields.filter((f) => f.role === 'measure').map((f) => f.name),
    filters: buildFilters(source),
    ...(source.dateField ? { timeAxis: source.dateField } : {}),
    ...(source.currencyField ? { currencyField: source.currencyField } : {}),
    capabilities: capabilitiesFor(source),
  };
}

/**
 * Resolve a module id to its context, or null.
 *
 * `sources` is a parameter with the shared registry as its default so tests can
 * drive it with fixtures — and so nothing here has to know that the registry is
 * a module-level constant.
 */
export function moduleContextFor(
  moduleId: string,
  sources: readonly AnalystSource[] = ANALYST_SOURCES,
): ModuleContext | null {
  const source = sources.find((s) => s.id === moduleId);
  return source ? toModuleContext(source) : null;
}

// ── The AI projection ───────────────────────────────────────────────────────

function toAiField(field: ModuleField): AiFieldDefinition {
  return {
    name: field.name,
    label: field.label,
    type: field.type,
    role: field.role,
    ...(field.aggregations.length ? { aggregations: field.aggregations } : {}),
    ...(field.enumValues?.length ? { values: field.enumValues } : {}),
  };
}

function toAiFilter(filter: ModuleFilter): AiFilterDefinition {
  switch (filter.kind) {
    case 'dateRange':
      return {
        kind: 'dateRange',
        field: filter.field,
        label: filter.label,
        endBound: filter.endBound,
      };
    case 'search':
      return {
        kind: 'search',
        label: filter.label,
        // Names only. Which fields are prefix-matched and which are scanned is a
        // cost property of the query, not something a report design turns on.
        fields: filter.fields.map((f) => f.field),
        minLength: filter.minLength,
      };
    case 'field':
      return {
        kind: 'field',
        field: filter.field,
        label: filter.label,
        operators: filter.operators,
        ...(filter.values?.length ? { values: filter.values } : {}),
      };
  }
}

/**
 * The context as the model will eventually see it.
 *
 * Drops the last of the app-side detail: a field's `searchable` mode and
 * `timeAxis`/`currency` markers, which the filter list and `capabilities`
 * already state once each. Everything that survives is safe to serialise —
 * there is no host, no entity, no credential and no Angular object in the
 * result, by construction rather than by review.
 *
 * `availability` is optional because metadata is knowable with no I/O at all,
 * while row counts are not. A caller that has not counted yet omits it, and the
 * absence of `data` says "nothing has been read" rather than implying zero rows.
 */
export function toAiDataContext(
  context: ModuleContext,
  availability?: ModuleDataAvailability,
): AiDataContext {
  return {
    module: {
      id: context.moduleId,
      name: context.moduleName,
      ...(context.description ? { description: context.description } : {}),
    },
    fields: context.fields.map(toAiField),
    filters: context.filters.map(toAiFilter),
    capabilities: context.capabilities,
    ...(availability ? { data: availability } : {}),
  };
}
