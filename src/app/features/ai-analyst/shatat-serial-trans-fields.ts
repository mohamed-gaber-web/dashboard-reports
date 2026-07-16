import { FieldMeta } from './models/field-meta.model';
import {
  SHA_SERIAL_TRANS_TYPE,
  SHA_SERIAL_TRANS_TYPE_ENUM,
} from '../shatat/models/shatat-serial-trans.model';

/**
 * Field metadata for the Shatat `Sha_SerialTrans` dataset (~11M rows). Drives the
 * schema the LLM sees, how the report engine formats values, and — via `enumType`,
 * `search`, `measure` and `dimension` — what the planner is allowed to compile
 * into a `$filter`.
 *
 * `SerialTransRecId` is a record id: numeric in D365, but typed `string` here so
 * the engine treats it as a dimension and never tries to sum it.
 *
 * `Sha_SerialTransType` is an **enum**. Typing it `'string'` (as this file used to)
 * makes every filter on it a 400 — D365 requires a qualified enum literal.
 */
export const SHATAT_SERIAL_TRANS_FIELDS: FieldMeta[] = [
  { key: 'SerialTransRecId', label: 'Transaction', type: 'string', format: 'text' },
  {
    key: 'Sha_SerialTransType',
    label: 'Transaction type',
    type: 'enum',
    format: 'text',
    enumType: SHA_SERIAL_TRANS_TYPE_ENUM,
    enumMembers: SHA_SERIAL_TRANS_TYPE,
    dimension: true,
  },
  { key: 'ItemId', label: 'Item', type: 'string', format: 'text', search: 'prefix', dimension: true },
  { key: 'ItemName', label: 'Item name', type: 'string', format: 'text', search: 'contains', dimension: true },
  { key: 'InventSerialId', label: 'Serial number', type: 'string', format: 'text', search: 'prefix' },
  { key: 'InventSiteId', label: 'Site', type: 'string', format: 'text', dimension: true },
  { key: 'InventLocationId', label: 'Warehouse', type: 'string', format: 'text', dimension: true },
  { key: 'UnitId', label: 'Unit', type: 'string', format: 'text', dimension: true },
  { key: 'TransDate', label: 'Transaction date', type: 'date', format: 'date' },
  { key: 'RefTransId', label: 'Reference', type: 'string', format: 'text', search: 'prefix' },
  { key: 'Qty', label: 'Quantity', type: 'number', format: 'quantity', measure: true },
  { key: 'Qty_Kg', label: 'Quantity (Kg)', type: 'number', format: 'quantity', measure: true },
  { key: 'Qty_Price', label: 'Unit price', type: 'number', format: 'currency', measure: true },
  { key: 'Weight', label: 'Weight', type: 'number', format: 'quantity', measure: true },
  { key: 'Amount', label: 'Amount', type: 'number', format: 'currency', measure: true },
];

/** The date field the AI Analyst filters and windows on. */
export const SHATAT_DATE_FIELD = 'TransDate';
