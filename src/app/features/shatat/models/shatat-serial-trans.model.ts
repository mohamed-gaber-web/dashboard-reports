/**
 * Shape of a `Sha_SerialTrans` record from the Shatat UAT D365 environment.
 * (Serial-number inventory transactions.) Only the fields we surface are typed;
 * the entity has more. Field names come straight from the OData entity.
 */
export interface ShatatSerialTransRecord {
  dataAreaId: string;
  SerialTransRecId: number;
  Sha_SerialTransType: string;
  ItemId: string;
  ItemName: string;
  InventSerialId: string;
  InventSiteId: string;
  InventLocationId: string;
  UnitId: string;
  TransDate: string;
  RefTransId: string;
  Qty: number;
  Qty_Kg: number;
  Qty_Price: number;
  Weight: number;
  Amount: number;
}

/** `$select` string keeping the payload to the fields the report engine uses. */
export const SHATAT_SERIAL_TRANS_SELECT = [
  'dataAreaId',
  'SerialTransRecId',
  'Sha_SerialTransType',
  'ItemId',
  'ItemName',
  'InventSerialId',
  'InventSiteId',
  'InventLocationId',
  'UnitId',
  'TransDate',
  'RefTransId',
  'Qty',
  'Qty_Kg',
  'Qty_Price',
  'Weight',
  'Amount',
].join(',');
