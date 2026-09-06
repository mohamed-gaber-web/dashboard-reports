import { environment } from '../../../environments/environment';
import { SearchField } from '../../core/http/odata-filter.util';
import { AnalystSource } from './models/analyst-source.model';
import {
  SALES_LINE_SELECT_FIELDS,
  SALES_SELECT_FIELDS,
} from '../sales-order/models/sales-order.model';
import {
  SHATAT_SEARCH_FIELDS,
  SHATAT_SERIAL_TRANS_SELECT,
} from '../shatat/models/shatat-serial-trans.model';
import { INVENTORY_SOURCE } from './inventory-fields';
import { SALES_ORDER_DATE_FIELD, SALES_ORDER_FIELDS } from './sales-order-fields';
import { SHATAT_DATE_FIELD, SHATAT_SERIAL_TRANS_FIELDS } from './shatat-serial-trans-fields';
import {
  PURCHASE_ORDER_DATE_FIELD,
  PURCHASE_ORDER_FIELDS,
  PURCHASE_ORDER_SEARCH_FIELDS,
  PURCHASE_ORDER_SELECT,
} from './purchase-order-fields';
import {
  TRIAL_BALANCE_DATE_FIELD,
  TRIAL_BALANCE_FIELDS,
  TRIAL_BALANCE_SEARCH_FIELDS,
  TRIAL_BALANCE_SELECT,
} from './trial-balance-fields';

/**
 * The modules an AI screen can be pointed at.
 *
 * This list lived inline in `AiReportModel`. It moved here when the AI Report
 * Builder became a second consumer: a module is a property of the APPLICATION —
 * which entity, which company, which fields, which base filter — not of one
 * page's ViewModel, and two screens holding two copies is exactly how one of
 * them silently keeps querying a company the other stopped using.
 *
 * **Adding a module is one entry here plus a fields file.** Both AI screens pick
 * it up with no UI edit.
 */

/** D365 rejects a bare string on an enum — the literal has to be type-qualified. */
const BACKORDER = "Microsoft.Dynamics.DataEntities.SalesStatus'Backorder'";

/**
 * The Sales Order module's query descriptor, derived from `environment.salesOrder`.
 *
 * A source is either **composite** (Growpath's `GP_SalesHeaderAndLineData`, which
 * carries the header columns as `SalesTable_*`) or **split** (Shatat, where those
 * columns live on a separate entity). An AI screen issues single-entity queries
 * and cannot join, so on a split source it sees the LINE half only — and the
 * `SalesTable_*` fields are withheld from the schema rather than advertised and
 * then 400'd by D365. `SalesOrderService` still joins them for the report
 * screens; this narrowing applies to the AI screens alone.
 */
const SALES_ORDER_SOURCE = (() => {
  const cfg = environment.salesOrder;
  const company = `dataAreaId eq '${cfg.company}'`;
  const composite = !cfg.headerEntity;

  if (composite) {
    return {
      entity: cfg.lineEntity,
      fields: SALES_ORDER_FIELDS,
      select: SALES_SELECT_FIELDS,
      dateField: SALES_ORDER_DATE_FIELD,
      baseFilter:
        `${company} and RemainInventPhysical gt 0 ` +
        `and SalesTable_SalesStatus eq ${BACKORDER} and SalesStatus eq ${BACKORDER}`,
      searchFields: [
        { field: 'SalesId', mode: 'prefix' },
        { field: 'ItemId', mode: 'prefix' },
        { field: 'CustAccount', mode: 'prefix' },
        { field: 'SalesTable_SalesName', mode: 'contains' },
      ] as SearchField[],
    };
  }

  return {
    entity: cfg.lineEntity,
    fields: SALES_ORDER_FIELDS.filter((f) => !f.key.startsWith('SalesTable_')),
    select: SALES_LINE_SELECT_FIELDS,
    // The composite's delivery date is a header column; the line's own requested
    // ship date is the nearest equivalent the split source can window on.
    dateField: 'ShippingDateRequested',
    baseFilter: `${company} and RemainInventPhysical gt 0 and SalesStatus eq ${BACKORDER}`,
    searchFields: [
      { field: 'SalesId', mode: 'prefix' },
      { field: 'ItemId', mode: 'prefix' },
      { field: 'CustAccount', mode: 'prefix' },
      { field: 'Name', mode: 'contains' },
    ] as SearchField[],
  };
})();

/**
 * The general-ledger module, or nothing.
 *
 * Gated on `environment.trialBalance.enabled` because the entity name has not
 * been confirmed against the tenant yet, and an unconfirmed entity is an opaque
 * 400 the first time a user selects it — see `trial-balance-fields.ts` for the
 * two commands that confirm it. Spread into the list below, so turning it on is
 * a config change and turning it off leaves no empty picker entry behind.
 */
const TRIAL_BALANCE_SOURCE: AnalystSource[] = environment.trialBalance.enabled
  ? [
      {
        id: 'trial-balance',
        label: 'Trial Balance',
        description: 'General ledger entries by main account, posting type and period',
        fields: TRIAL_BALANCE_FIELDS,
        // Written for the Executive style, which is what this module exists for:
        // each one asks for something the fold can actually total by account.
        suggestions: [
          'Build the executive financial report',
          'Total amounts by main account',
          'Show the movement by month',
          'Which accounts carry the largest balances?',
        ],
        entity: environment.trialBalance.entity,
        dataPath: environment.trialBalance.source.dataPath,
        authConfig: environment.trialBalance.source.auth,
        crossCompany: environment.trialBalance.source.crossCompany,
        baseFilter: `dataAreaId eq '${environment.trialBalance.company}'`,
        // A journal entry's own key. Paging with `$skip` is only correct under a
        // total order, so this must be unique — confirm it with the probe along
        // with the columns.
        keyField: ['RecId'],
        select: TRIAL_BALANCE_SELECT,
        searchFields: TRIAL_BALANCE_SEARCH_FIELDS,
        dateField: TRIAL_BALANCE_DATE_FIELD,
        currencyField: 'TransactionCurrencyCode',
      },
    ]
  : [];

/** Every module both AI screens can analyse, in picker order. */
export const ANALYST_SOURCES: readonly AnalystSource[] = [
  {
    id: 'sales-order',
    label: 'Sales Order',
    description: 'Open backorder lines with remaining physical inventory',
    fields: SALES_ORDER_SOURCE.fields,
    suggestions: [
      'Summarise the open backorders',
      'Show units remaining by customer',
      'Break down lines by currency as a donut',
      'Which items have the most backorder quantity?',
    ],
    entity: SALES_ORDER_SOURCE.entity,
    dataPath: environment.salesOrder.source.dataPath,
    authConfig: environment.salesOrder.source.auth,
    crossCompany: environment.salesOrder.source.crossCompany,
    baseFilter: SALES_ORDER_SOURCE.baseFilter,
    keyField: ['SalesId', 'LineNum'],
    select: SALES_ORDER_SOURCE.select,
    searchFields: SALES_ORDER_SOURCE.searchFields,
    dateField: SALES_ORDER_SOURCE.dateField,
    currencyField: 'CurrencyCode',
  },
  // Inventory on hand. Declared in its own file like every other module — see
  // `inventory-fields.ts`, including why it used to live under chat-reports.
  INVENTORY_SOURCE,
  {
    id: 'transaction',
    label: 'Transaction',
    description: 'Serial number transactions by site, warehouse and item',
    fields: SHATAT_SERIAL_TRANS_FIELDS,
    suggestions: [
      'Total quantity and amount by transaction type',
      'Show amount by item as a bar chart',
      'Which sites have the most transactions?',
      'Break down transactions by warehouse',
    ],
    entity: 'Sha_SerialTrans',
    dataPath: environment.shatat.dataPath,
    authConfig: environment.shatat.auth,
    crossCompany: true,
    baseFilter: `dataAreaId eq '${environment.shatat.company}'`,
    keyField: ['SerialTransRecId'],
    select: SHATAT_SERIAL_TRANS_SELECT,
    searchFields: SHATAT_SEARCH_FIELDS,
    dateField: SHATAT_DATE_FIELD,
    // Shatat has no currency column. The old engine hardcoded `CurrencyCode`
    // and so scanned the whole dataset to find nothing.
    currencyField: undefined,
  },
  ...TRIAL_BALANCE_SOURCE,
  {
    id: 'purchase-order',
    label: 'Purchase Order',
    description: 'Purchase order headers by vendor, status, site and terms',
    fields: PURCHASE_ORDER_FIELDS,
    // A header entity has no amounts, so every suggestion here counts orders
    // rather than totalling them — see purchase-order-fields.ts.
    suggestions: [
      'How many purchase orders per vendor?',
      'Break down orders by status as a donut',
      'Which receiving sites have the most orders?',
      'Count orders by currency and approval status',
    ],
    entity: 'PurchaseOrderHeadersV2',
    dataPath: environment.shatat.dataPath,
    authConfig: environment.shatat.auth,
    crossCompany: true,
    baseFilter: `dataAreaId eq '${environment.shatat.company}'`,
    keyField: ['PurchaseOrderNumber'],
    select: PURCHASE_ORDER_SELECT,
    searchFields: PURCHASE_ORDER_SEARCH_FIELDS,
    dateField: PURCHASE_ORDER_DATE_FIELD,
    currencyField: 'CurrencyCode',
  },
];
