import { FieldMeta } from './models/field-meta.model';

/**
 * Field metadata for the Sales Order backorder dataset. Drives both the schema
 * the LLM sees and how the engine formats values.
 *
 * `measure` marks what can legitimately be summed; `dimension` marks what makes
 * a sensible group-by. Without these the planner would happily try to total a
 * customer account number.
 *
 * Scale note: the backorder-filtered set is ~296 rows — trivially foldable. The
 * same machinery handles it and the 11M-row Shatat entity; only the row count
 * differs, and `$count` tells us which is which for free.
 */
export const SALES_ORDER_FIELDS: FieldMeta[] = [
  { key: 'SalesId', label: 'Order', type: 'string', format: 'text', search: 'prefix', dimension: true },
  { key: 'ItemId', label: 'Item', type: 'string', format: 'text', search: 'prefix', dimension: true },
  { key: 'Name', label: 'Description', type: 'string', format: 'text', search: 'contains' },
  {
    key: 'CustAccount',
    label: 'Customer account',
    type: 'string',
    format: 'text',
    search: 'prefix',
    dimension: true,
  },
  {
    key: 'SalesTable_SalesName',
    label: 'Customer',
    type: 'string',
    format: 'text',
    search: 'contains',
    dimension: true,
  },
  {
    key: 'SalesTable_DocumentStatus',
    label: 'Document status',
    type: 'string',
    format: 'text',
    dimension: true,
  },
  { key: 'SalesTable_DeliveryDate', label: 'Delivery date', type: 'date', format: 'date' },
  { key: 'ShippingDateRequested', label: 'Requested ship date', type: 'date', format: 'date' },
  { key: 'QtyOrdered', label: 'Qty ordered', type: 'number', format: 'quantity', measure: true },
  {
    key: 'RemainInventPhysical',
    label: 'Units remaining',
    type: 'number',
    format: 'quantity',
    measure: true,
  },
  { key: 'LineAmount', label: 'Line amount', type: 'number', format: 'currency', measure: true },
  { key: 'CurrencyCode', label: 'Currency', type: 'string', format: 'text', dimension: true },
];

/** The date field the AI Analyst windows on for this source. */
export const SALES_ORDER_DATE_FIELD = 'SalesTable_DeliveryDate';
