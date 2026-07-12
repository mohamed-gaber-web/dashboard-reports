import { FieldMeta } from './models/field-meta.model';

/**
 * Field metadata for the Shatat `Sha_SerialTrans` dataset. Drives the schema the
 * LLM sees and how the report engine formats values — the sibling of
 * SALES_ORDER_FIELDS for the second data source. Record-id fields are typed as
 * strings so the engine treats them as dimensions, not sums.
 */
export const SHATAT_SERIAL_TRANS_FIELDS: FieldMeta[] = [
  { key: 'SerialTransRecId', label: 'Transaction', type: 'string', format: 'text' },
  { key: 'Sha_SerialTransType', label: 'Transaction type', type: 'string', format: 'text' },
  { key: 'ItemId', label: 'Item', type: 'string', format: 'text' },
  { key: 'ItemName', label: 'Item name', type: 'string', format: 'text' },
  { key: 'InventSerialId', label: 'Serial number', type: 'string', format: 'text' },
  { key: 'InventSiteId', label: 'Site', type: 'string', format: 'text' },
  { key: 'InventLocationId', label: 'Warehouse', type: 'string', format: 'text' },
  { key: 'UnitId', label: 'Unit', type: 'string', format: 'text' },
  { key: 'TransDate', label: 'Transaction date', type: 'date', format: 'date' },
  { key: 'RefTransId', label: 'Reference', type: 'string', format: 'text' },
  { key: 'Qty', label: 'Quantity', type: 'number', format: 'quantity' },
  { key: 'Qty_Kg', label: 'Quantity (Kg)', type: 'number', format: 'quantity' },
  { key: 'Qty_Price', label: 'Unit price', type: 'number', format: 'currency' },
  { key: 'Weight', label: 'Weight', type: 'number', format: 'quantity' },
  { key: 'Amount', label: 'Amount', type: 'number', format: 'currency' },
];
