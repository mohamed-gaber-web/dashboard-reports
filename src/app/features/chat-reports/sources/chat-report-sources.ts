import { ANALYST_SOURCES } from '../../ai-analyst/analyst-sources';
import { AnalystSource } from '../../ai-analyst/models/analyst-source.model';
import { SourceOption } from '../../../shared/models/source-option.model';
import { INVENTORY_SOURCE } from './inventory-source';

/**
 * The datasets Chat Reports can be pointed at.
 *
 * ## Two ways a module's aggregates are built
 *
 * Chat Reports needs REAL totals over the whole dataset — its contract has the
 * MODEL state the figures, so the summary is the only thing standing between the
 * user and a confident fabrication. There are two honest ways to get one here,
 * and which applies is a property of the module:
 *
 * - **`joined`** — a feature service already assembles the dataset, including
 *   columns that live on a second entity. Sales Order is this: `SalesOrderService`
 *   joins `SalesLineBiEntities` to `SalesTableBiEntities`, which is the only
 *   reason a report can group by CUSTOMER NAME at all. The AI Analyst withholds
 *   those `SalesTable_*` fields because it issues single-entity queries and
 *   cannot join; Chat Reports never queries, it only summarises, so it keeps them.
 *
 * - **`analyst`** — a single entity, counted and folded through the shared
 *   `AnalystDataService` pipeline. That is what makes an 11M-row module safe:
 *   `$count` is exact and free, and the fold is refused above
 *   `MAX_ANALYZE_ROWS` rather than quietly summarising the first 5,000 rows.
 *
 * Picking the joined path for Sales Order is not legacy — it is strictly more
 * capable there, and switching it to the generic path would silently drop the
 * customer dimension from a screen whose own starter prompt asks for it.
 */
export interface ChatReportSource extends SourceOption {
  /**
   * The single-entity descriptor to count and fold. Absent for a module whose
   * aggregates come from a feature service instead.
   */
  analyst?: AnalystSource;

  /**
   * Prompts offered on the empty screen. Per module, because "Top 5 customers
   * by units remaining" is a dead end on an inventory snapshot — a starter that
   * cannot be answered is worse than no starter.
   */
  starters: string[];

  /** How the slice form is configured for this module. */
  filters: ChatReportFilterSpec;
}

/**
 * What the slice form offers for one module.
 *
 * Both fields are optional because both are per-module facts, not preferences:
 * a module with no date column cannot be windowed, and rendering the control
 * anyway produces a filter that matches everything and a user who thinks it
 * didn't work.
 */
export interface ChatReportFilterSpec {
  /**
   * Label for the date range, naming the column being windowed — "Date range"
   * alone hides which of several dates is being filtered. Absent = no date filter.
   */
  dateLabel?: string;
  /** Placeholder for the search box, naming what is searchable. Absent = no search box. */
  searchPlaceholder?: string;
}

/**
 * What the user has narrowed a module down to.
 *
 * Structurally the AI Analyst's `AnalystFilter`, with one deliberate difference:
 * **`to` is INCLUSIVE here.** The shared `dateRange` helper emits a half-open
 * `lt to`, so picking "to 31 March" there silently excludes the whole of 31
 * March. On a screen whose contract has the MODEL state the figures, a filter
 * that quietly drops its own end date is a wrong total with no visible cause,
 * so this layer converts the bound before it reaches OData (`sliceFilter`) and
 * applies the same rule to the in-memory path. The shared helper is left alone
 * — changing it would silently move two other screens.
 */
export interface ChatReportFilter {
  search?: string;
  from?: string;
  to?: string;
}

/** True when the user has actually narrowed anything. */
export function hasSliceFilter(filter: ChatReportFilter): boolean {
  return !!(filter.from || filter.to || filter.search?.trim());
}

/** A stable cache key for one module + one slice. */
export function sliceKey(sourceId: string, filter: ChatReportFilter): string {
  return [sourceId, filter.from ?? '', filter.to ?? '', filter.search?.trim() ?? ''].join('|');
}

/**
 * The slice in one human sentence, for the UI **and for the model**.
 *
 * The backend prompt calls the summary "real aggregates over the whole
 * dataset". Once a filter exists that sentence is false, and this contract has
 * the model state figures — so it is told exactly what the numbers cover and
 * asked to say so. Returns null when nothing is narrowed, which is the prompt's
 * signal that the original wording still holds.
 */
export function describeSlice(source: ChatReportSource, filter: ChatReportFilter): string | null {
  if (!hasSliceFilter(filter)) return null;

  const parts: string[] = [];
  const date = source.filters.dateLabel;

  if (date && filter.from && filter.to) parts.push(`${date} from ${filter.from} to ${filter.to}`);
  else if (date && filter.from) parts.push(`${date} on or after ${filter.from}`);
  else if (date && filter.to) parts.push(`${date} on or before ${filter.to}`);

  const search = filter.search?.trim();
  if (search) parts.push(`matching the search term “${search}”`);

  return parts.length ? `Only rows where ${parts.join(', and ')}.` : null;
}

/**
 * The slice form for a module read through the shared count-and-fold pipeline.
 *
 * Derived from the source's own descriptor rather than repeated per module: the
 * date column and the searchable columns are already declared there, and a
 * second hand-written copy is how a picker ends up offering a date filter for a
 * column the query does not window on.
 */
function filtersFor(source: AnalystSource): ChatReportFilterSpec {
  const dateLabel = source.dateField
    ? (source.fields.find((f) => f.key === source.dateField)?.label ?? 'Date range')
    : undefined;

  const searchable = source.searchFields
    .map((s) => source.fields.find((f) => f.key === s.field)?.label ?? s.field)
    .slice(0, 3);

  return {
    dateLabel,
    searchPlaceholder: searchable.length ? `${searchable.join(', ')}…` : undefined,
  };
}

/** Pull one module out of the shared registry by id, loudly if it has moved. */
function analyst(id: string): AnalystSource {
  const source = ANALYST_SOURCES.find((s) => s.id === id);
  if (!source) {
    // A renamed id would otherwise show up as an empty picker entry that fails
    // only once a user selects it.
    throw new Error(`Chat Reports references unknown analyst source “${id}”.`);
  }
  return source;
}

/** A module whose aggregates come from the shared count-and-fold pipeline. */
function fromAnalyst(id: string, over: Partial<ChatReportSource> = {}): ChatReportSource {
  const source = analyst(id);
  return {
    id: source.id,
    label: source.label,
    description: source.description,
    starters: source.suggestions,
    analyst: source,
    filters: filtersFor(source),
    ...over,
  };
}

export const CHAT_REPORT_SOURCES: ChatReportSource[] = [
  {
    id: 'sales-order',
    label: 'Sales Order',
    description: 'Open backorder lines, with customer and product detail',
    // No `analyst`: the joined path. See the doc above — it is what makes
    // "by customer" answerable here.
    starters: [
      'Summarise the open backorders',
      'Top 5 customers by units remaining',
      'Break down backorder lines by currency',
      'Which products have the most stock waiting to ship?',
    ],
    // Written out rather than derived: this module has no `analyst` descriptor
    // to derive from. The date is the HEADER's delivery date, which the joined
    // dataset carries on both tenant shapes (`SalesOrderService.merge` folds it
    // in on the split source), and it is the date users mean by "when is this
    // due" — the line's own requested ship date is frequently unset.
    filters: {
      dateLabel: 'Delivery date',
      searchPlaceholder: 'Order, item, customer…',
    },
  },
  // Not via `fromAnalyst`: Inventory is defined in this feature rather than in
  // the shared registry, for the reason given in `inventory-source.ts`.
  {
    id: INVENTORY_SOURCE.id,
    label: INVENTORY_SOURCE.label,
    description: INVENTORY_SOURCE.description,
    starters: INVENTORY_SOURCE.suggestions,
    analyst: INVENTORY_SOURCE,
    filters: filtersFor(INVENTORY_SOURCE),
  },
  fromAnalyst('transaction', { label: 'Transactions' }),
  fromAnalyst('purchase-order'),
  // The general ledger, when it is configured. `fromAnalyst` throws on an
  // unknown id by design, so this asks the shared registry whether the module
  // exists rather than repeating the environment flag that decides it.
  ...(ANALYST_SOURCES.some((s) => s.id === 'trial-balance') ? [fromAnalyst('trial-balance')] : []),
];

export const DEFAULT_CHAT_REPORT_SOURCE = CHAT_REPORT_SOURCES[0];

export function findChatReportSource(id: string): ChatReportSource {
  return CHAT_REPORT_SOURCES.find((s) => s.id === id) ?? DEFAULT_CHAT_REPORT_SOURCE;
}
