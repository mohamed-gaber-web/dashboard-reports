import { environment } from '../../../environments/environment';
import { SearchField } from '../../core/http/odata-filter.util';
import { AnalystSource } from './models/analyst-source.model';
import { FieldMeta } from './models/field-meta.model';

/**
 * Inventory on hand — item × site × warehouse.
 *
 * ## Confirmed against the live tenant, not inferred
 *
 * Entity set `WarehousesOnHandV2` (entity type `WarehouseOnHandV2`) on Shatat
 * UAT. Every name below was read off `$metadata` and a real row, per CLAUDE.md's
 * standing rule: a guessed entity or column is an opaque 404/400, not a useful
 * error. Measured at the time of writing: 823 rows across all legal entities,
 * 787 of them with non-zero stock.
 *
 * ## Why cross-company with no company filter
 *
 * The other modules pin one legal entity because their datasets are large and
 * company-specific. On-hand is neither: the whole entity is under a thousand
 * rows and the stock is spread across 001–004, so pinning one company would hide
 * three quarters of the inventory. `dataAreaId` is a dimension instead, which
 * lets a report break down BY legal entity rather than silently pick one.
 *
 * ## No date field
 *
 * On-hand is a snapshot, not a ledger — there is no transaction date to window
 * on. `dateField` is therefore undefined, which is what stops a trend chart
 * being offered over a quantity that has no time axis. It is also the module
 * that proves {@link ModuleContextService} handles a module with no time axis:
 * no `dateRange` filter is advertised and no field claims `min`/`max`.
 *
 * ## Why this lives here
 *
 * It was written under `features/chat-reports/sources/` because that file was
 * being edited concurrently, with a note saying it belonged in the shared
 * registry. It now is: a module is a property of the APPLICATION, not of one
 * screen, and while it sat in the chat-reports feature the AI Analyst and the
 * Report Builder could not see Inventory at all.
 */

/** Product-dimension columns are part of the key but empty in this data. */
const PRODUCT_DIMENSIONS = [
  'ProductColorId',
  'ProductConfigurationId',
  'ProductSizeId',
  'ProductStyleId',
  'ProductVersionId',
];

/**
 * The entity's real key, in order.
 *
 * All nine parts, including the empty product dimensions: `$skip` only
 * partitions a set cleanly under a TOTAL order, and a partial key would let the
 * fold and the CSV export silently drop or duplicate rows across pages.
 */
export const INVENTORY_KEY = [
  'dataAreaId',
  'ItemNumber',
  ...PRODUCT_DIMENSIONS,
  'InventorySiteId',
  'InventoryWarehouseId',
];

/**
 * What the model is told about, and how the engine formats it.
 *
 * `AreWarehouseManagementProcessesUsed` is deliberately absent: it is a `NoYes`
 * enum, so a filter on it needs a type-qualified literal, and it carries no
 * analytical value worth that risk.
 */
export const INVENTORY_FIELDS: FieldMeta[] = [
  {
    key: 'dataAreaId',
    label: 'Legal entity',
    type: 'string',
    format: 'text',
    dimension: true,
  },
  {
    key: 'ItemNumber',
    label: 'Item',
    type: 'string',
    format: 'text',
    search: 'prefix',
    dimension: true,
  },
  { key: 'ProductName', label: 'Product', type: 'string', format: 'text', search: 'contains' },
  {
    key: 'InventorySiteId',
    label: 'Site',
    type: 'string',
    format: 'text',
    dimension: true,
  },
  {
    key: 'InventoryWarehouseId',
    label: 'Warehouse',
    type: 'string',
    format: 'text',
    dimension: true,
  },
  {
    key: 'OnHandQuantity',
    label: 'On hand',
    type: 'number',
    format: 'quantity',
    measure: true,
  },
  {
    key: 'AvailableOnHandQuantity',
    label: 'Available on hand',
    type: 'number',
    format: 'quantity',
    measure: true,
  },
  {
    key: 'ReservedOnHandQuantity',
    label: 'Reserved',
    type: 'number',
    format: 'quantity',
    measure: true,
  },
  {
    key: 'OrderedQuantity',
    label: 'Ordered',
    type: 'number',
    format: 'quantity',
    measure: true,
  },
  {
    key: 'OnOrderQuantity',
    label: 'On order',
    type: 'number',
    format: 'quantity',
    measure: true,
  },
  {
    key: 'TotalAvailableQuantity',
    label: 'Total available',
    type: 'number',
    format: 'quantity',
    measure: true,
  },
];

export const INVENTORY_SELECT = [
  ...INVENTORY_KEY.filter((k) => !PRODUCT_DIMENSIONS.includes(k)),
  'ProductName',
  'OnHandQuantity',
  'AvailableOnHandQuantity',
  'ReservedOnHandQuantity',
  'OrderedQuantity',
  'OnOrderQuantity',
  'TotalAvailableQuantity',
].join(',');

export const INVENTORY_SEARCH_FIELDS: SearchField[] = [
  { field: 'ItemNumber', mode: 'prefix' },
  { field: 'InventorySiteId', mode: 'prefix' },
  { field: 'InventoryWarehouseId', mode: 'prefix' },
  { field: 'ProductName', mode: 'contains' },
];

export const INVENTORY_SOURCE: AnalystSource = {
  id: 'inventory',
  label: 'Inventory',
  description: 'On-hand stock by item, site and warehouse, across all legal entities',
  fields: INVENTORY_FIELDS,
  suggestions: [
    'Summarise on-hand stock',
    'Which warehouses hold the most stock?',
    'Top 10 items by quantity on hand',
    'How much stock is reserved versus available?',
  ],
  entity: 'WarehousesOnHandV2',
  dataPath: environment.shatat.dataPath,
  authConfig: environment.shatat.auth,
  crossCompany: true,
  // Rows with no stock are item/warehouse combinations that merely exist. `ne 0`
  // rather than `gt 0` keeps NEGATIVE on-hand, which is a real condition worth
  // reporting rather than one worth hiding.
  baseFilter: 'OnHandQuantity ne 0',
  keyField: INVENTORY_KEY,
  select: INVENTORY_SELECT,
  searchFields: INVENTORY_SEARCH_FIELDS,
  // A snapshot has no date axis — see the file doc.
  dateField: undefined,
  currencyField: undefined,
};
