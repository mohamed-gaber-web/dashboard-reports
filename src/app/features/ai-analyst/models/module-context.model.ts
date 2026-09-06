/**
 * The normalized description of a reportable module, and the AI-facing
 * projection of it.
 *
 * ## Why this exists when `AnalystSource` already describes a module
 *
 * {@link AnalystSource} is a **query descriptor**: it says which OData entity to
 * hit, on which host, with which Azure AD app registration, under which base
 * `$filter`, ordered by which key. Roughly half of it is transport, and none of
 * that half means anything to a model reasoning about a report — a `dataPath` is
 * not analysis, and an `authConfig` must never leave the browser at all.
 *
 * {@link ModuleContext} is the other half, normalized: what this module holds,
 * what each field IS, which fields can be grouped, which can be totalled, how it
 * can be narrowed, and what the read pipeline can actually compute over it. It
 * is derived from `AnalystSource` — never authored separately — so a module
 * added to `ANALYST_SOURCES` gains a context with no edit here.
 *
 * {@link AiDataContext} is the wire shape: `ModuleContext` with the remaining
 * app-side detail dropped. That reduction is the trust boundary — see
 * `module-context.adapter.ts`.
 *
 * ## Relationship to `DataContext`
 *
 * They are two different halves and they compose rather than compete.
 * `DataContextService` produces the FIGURES for a slice (row count, sums,
 * top-N groups, sample rows). This produces the CAPABILITY: what may be asked
 * of the module at all. A future prompt carries both; neither subsumes the
 * other, and duplicating either into the other would give two answers to
 * "what can this module do".
 *
 * Data shapes only — no logic (NG-ARCH-02). The mapping lives in
 * `services/module-context.adapter.ts`.
 */

/**
 * What a field IS, for analytical purposes.
 *
 * Wider than `FieldType` (which only distinguishes what OData needs to build a
 * literal) and narrower than the union a generic BI tool would carry: every arm
 * here is one this app can actually produce from `FieldMeta`. There is
 * deliberately no `boolean`, `object` or `datetime` — no module declares one,
 * and an arm nothing emits is capability the app does not have.
 */
export type ModuleFieldType = 'string' | 'number' | 'currency' | 'percent' | 'date' | 'enum';

/**
 * How a field may be used in a report.
 *
 * - `dimension` — a sensible group-by (low-to-mid cardinality).
 * - `measure`   — can legitimately be totalled.
 * - `attribute` — neither: readable and often searchable, but too
 *   high-cardinality to group by and meaningless to sum. A record id and a free
 *   text description are both attributes, and calling either a dimension is how
 *   a chart ends up with ten thousand bars.
 *
 * Derived from the `dimension` / `measure` flags on `FieldMeta`, never guessed
 * from the type — "numeric" does not mean "summable".
 */
export type ModuleFieldRole = 'dimension' | 'measure' | 'attribute';

/**
 * An aggregation the app can actually compute for a field.
 *
 * Bounded by the pipeline, not by what BI tools usually offer:
 * - `count` / `countDistinct` come from the Worker fold's group keys and counts.
 * - `sum` comes from the fold's per-group sums; `avg` is `sum / count`.
 * - `min` / `max` come from `$orderby` + `$top=1`, which
 *   `AnalystDataService.dateBoundsRaw` wires up for the module's date field
 *   only — so they are advertised there and nowhere else.
 *
 * The `Cube` stores a sum and a count per group and nothing else, which is why
 * there is no `median`, `stddev` or numeric `min`/`max`.
 */
export type ModuleAggregation = 'sum' | 'avg' | 'min' | 'max' | 'count' | 'countDistinct';

/** Comparison operators `SpecCompilerService` will compile for a field. */
export type ModuleFilterOperator = 'eq' | 'neq' | 'gt' | 'gte' | 'lt' | 'lte' | 'contains';

/** How a search box matches one field. Mirrors `SearchMode`. */
export type ModuleSearchMode = 'prefix' | 'contains' | 'exact';

/** One field of a module, normalized. */
export interface ModuleField {
  /** The D365 column name. What a filter or a group-by must reference. */
  name: string;
  label: string;
  type: ModuleFieldType;
  role: ModuleFieldRole;
  /** Empty for nothing aggregatable. Never invented — see {@link ModuleAggregation}. */
  aggregations: readonly ModuleAggregation[];
  /** `type: 'enum'` only. The legal members, so a filter cannot invent one. */
  enumValues?: readonly string[];
  /** Set when the module's search box covers this field, and how it matches. */
  searchable?: ModuleSearchMode;
  /** True on the single field the module can be date-windowed on. */
  timeAxis?: boolean;
  /** True on the field carrying a currency code, when the module has one. */
  currency?: boolean;
}

/**
 * A way the module can be narrowed.
 *
 * Every arm corresponds to a code path that exists today:
 * `dateRange` → `dateRange()`, `search` → `buildSearchFilter()`,
 * `field` → `SpecCompilerService.compile()`. Nothing here is aspirational.
 */
export type ModuleFilter =
  | {
      kind: 'dateRange';
      field: string;
      label: string;
      /**
       * The shared `dateRange` helper emits `ge from and lt to`, so the upper
       * bound is EXCLUSIVE. Stated rather than assumed: Chat Reports converts an
       * inclusive `to` before it reaches OData precisely because getting this
       * wrong silently drops the last day of a window.
       */
      endBound: 'exclusive';
    }
  | {
      kind: 'search';
      label: string;
      /** Minimum term length below which the search is skipped entirely. */
      minLength: number;
      fields: readonly { field: string; label: string; mode: ModuleSearchMode }[];
    }
  | {
      kind: 'field';
      field: string;
      label: string;
      operators: readonly ModuleFilterOperator[];
      /** `type: 'enum'` only. */
      values?: readonly string[];
    };

/**
 * What the read pipeline can do over this module.
 *
 * This is the honest answer to "can you total this?", and it is a property of
 * the ARCHITECTURE rather than of the module: D365 F&O OData has no `$apply`,
 * no `groupby` and no `SUM`, so a total means reading every matching row through
 * the Worker fold, which is gated at {@link maxAnalyzeRows}.
 */
export interface ModuleCapabilities {
  /** Always true — `$count` is exact and transfers zero rows at any size. */
  count: boolean;
  /** Group-by and sums, via the in-browser fold. Requires a slice under the gate. */
  aggregate: boolean;
  /** Exact earliest/latest, via `$orderby` + `$top=1`. False with no date field. */
  dateBounds: boolean;
  search: boolean;
  /** Bounded pages via `$top`/`$skip`. */
  paging: boolean;
  /**
   * Always false. A source is ONE entity and the query layer cannot join, so a
   * question spanning two entities has to be answered by a feature service that
   * joins first (as `SalesOrderService` does) — never by the query pipeline.
   */
  join: boolean;
  /** Rows above which the fold is refused and the module answers counts-only. */
  maxAnalyzeRows: number;
  /** D365's hard server-side page cap. */
  serverPageSize: number;
}

/** A module, normalized. Derived from `AnalystSource`; never authored by hand. */
export interface ModuleContext {
  moduleId: string;
  moduleName: string;
  description?: string;

  fields: readonly ModuleField[];

  /** Field names, for convenience — the same fields carry `role` themselves. */
  dimensions: readonly string[];
  measures: readonly string[];

  filters: readonly ModuleFilter[];

  /** The field a date window applies to, when the module has one. */
  timeAxis?: string;
  /** The field carrying a currency code, when the module has one. */
  currencyField?: string;

  capabilities: ModuleCapabilities;
}

// ── The AI-facing projection ────────────────────────────────────────────────

/** One field, as the model is told about it. */
export interface AiFieldDefinition {
  name: string;
  label: string;
  type: ModuleFieldType;
  role: ModuleFieldRole;
  /** Omitted when empty rather than sent as `[]`. */
  aggregations?: readonly ModuleAggregation[];
  /** `type: 'enum'` only — the members a filter may name. */
  values?: readonly string[];
}

/** One way the model may narrow the module. */
export type AiFilterDefinition =
  | { kind: 'dateRange'; field: string; label: string; endBound: 'exclusive' }
  | { kind: 'search'; label: string; fields: readonly string[]; minLength: number }
  | {
      kind: 'field';
      field: string;
      label: string;
      operators: readonly ModuleFilterOperator[];
      values?: readonly string[];
    };

/**
 * What is known about the DATA behind the module right now — deliberately not
 * the data itself.
 *
 * This is the seam Task 9 of the brief asks for: the model has to be able to
 * tell "this module has a `LineAmount` column" (metadata) from "the current
 * slice has 296 rows and has been totalled" (availability), because the second
 * decides which questions are answerable. Rows never travel through here; when a
 * question eventually needs figures, `DataContextService` supplies aggregates
 * over a slice, and the raw dataset stays in the browser.
 */
export interface ModuleDataAvailability {
  /** Exact `$count` for the current slice. */
  rowCount: number;
  /**
   * `exact`       — the slice was folded, so sums and group-bys are real.
   * `counts-only` — over the fold gate, or not yet folded. Counts and date
   *                 bounds are still exact; there are NO sums.
   */
  coverage: 'exact' | 'counts-only';
  /** Whether a sum, average or group-by can be answered for this slice at all. */
  totalsAvailable: boolean;
  /** What the user has narrowed to, when anything. */
  slice?: { from?: string; to?: string; search?: string };
  /** Earliest and latest value of the module's date field, when it has one. */
  dateRange?: { field: string; min?: string; max?: string };
}

/**
 * The AI-facing context for one module.
 *
 * Everything here is safe to serialise into a prompt: no entity name, no host,
 * no `dataPath`, no `authConfig`, no base `$filter`, no OData enum type name, no
 * Angular object and no UI copy. See `module-context.adapter.ts` for the
 * redaction and why each omission is deliberate.
 */
export interface AiDataContext {
  module: {
    id: string;
    name: string;
    description?: string;
  };
  fields: readonly AiFieldDefinition[];
  filters: readonly AiFilterDefinition[];
  capabilities: ModuleCapabilities;
  /** Absent until something has actually counted the slice. */
  data?: ModuleDataAvailability;
}
