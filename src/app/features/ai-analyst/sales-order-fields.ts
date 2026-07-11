import { FieldMeta } from './models/field-meta.model';

/**
 * Field metadata for the Sales Order backorder dataset. Drives both the schema
 * the LLM sees and how the engine formats values. (When more modules gain AI
 * Analyst support, each provides its own field list.)
 */
export const SALES_ORDER_FIELDS: FieldMeta[] = [
  { key: 'SalesId', label: 'Order', type: 'string', format: 'text' },
  { key: 'ItemId', label: 'Item', type: 'string', format: 'text' },
  { key: 'Name', label: 'Description', type: 'string', format: 'text' },
  { key: 'CustAccount', label: 'Customer account', type: 'string', format: 'text' },
  { key: 'SalesTable_SalesName', label: 'Customer', type: 'string', format: 'text' },
  { key: 'SalesTable_DocumentStatus', label: 'Document status', type: 'string', format: 'text' },
  { key: 'SalesTable_DeliveryDate', label: 'Delivery date', type: 'date', format: 'date' },
  { key: 'ShippingDateRequested', label: 'Requested ship date', type: 'date', format: 'date' },
  { key: 'QtyOrdered', label: 'Qty ordered', type: 'number', format: 'quantity' },
  { key: 'RemainInventPhysical', label: 'Units remaining', type: 'number', format: 'quantity' },
  { key: 'LineAmount', label: 'Line amount', type: 'number', format: 'currency' },
  { key: 'CurrencyCode', label: 'Currency', type: 'string', format: 'text' },
];
