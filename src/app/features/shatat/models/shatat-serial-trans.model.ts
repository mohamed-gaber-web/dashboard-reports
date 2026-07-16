/**
 * Shape of a `Sha_SerialTrans` record from the Shatat UAT D365 environment.
 * (Serial-number inventory transactions — livestock, tracked per animal.)
 * Only the fields we surface are typed; the entity has more.
 *
 * Scale, measured against the live sandbox: **10,975,316 rows** in company `001`.
 * Nothing may load this entity unpaged.
 */
export interface ShatatSerialTransRecord {
  dataAreaId: string;
  SerialTransRecId: number;
  /** An ENUM, not a string — see {@link SHA_SERIAL_TRANS_TYPE}. */
  Sha_SerialTransType: ShaSerialTransType;
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

/**
 * `Sha_SerialTransType` is a D365 **enum**, taken from `$metadata`.
 *
 * This matters: filtering it as a plain string — `Sha_SerialTransType eq 'Sales'`
 * — returns **HTTP 400**. It must be written as an enum literal:
 * `Sha_SerialTransType eq Microsoft.Dynamics.DataEntities.Sha_SerialTransType'Sales'`
 * and only `eq` / `ne` are supported. See `odata-filter.util.ts`.
 */
export const SHA_SERIAL_TRANS_TYPE = [
  'PurchaseOrder',
  'TransferSerial',
  'TransferWarehouse',
  'TransferSite',
  'Feeding',
  'Medical',
  'Other',
  'Rate',
  'FastingWeight',
  'PeriodicWeight',
  'Sales',
  'Death',
  'OpeningBalance',
] as const;

export type ShaSerialTransType = (typeof SHA_SERIAL_TRANS_TYPE)[number];

/** The OData enum type name, for building `$filter` literals. */
export const SHA_SERIAL_TRANS_TYPE_ENUM = 'Sha_SerialTransType';

/** `$select` for the detail table — the fields a human reads. */
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

/**
 * Fields worth searching, and how.
 *
 * `prefix` is deliberate. Measured on the 11M-row entity: a prefix match
 * (`eq '2020*'`) is an index seek at **~300 ms**; a contains match
 * (`eq '*2020*'`) is a full scan at **~13 s**. Serial numbers, item codes and
 * reference ids are all keys people type from the left, so prefix is both
 * faster and what users actually mean. `ItemName` is a description — a prefix
 * match on it would be useless, so it pays the scan.
 */
export const SHATAT_SEARCH_FIELDS = [
  { field: 'InventSerialId', mode: 'prefix' as const },
  { field: 'ItemId', mode: 'prefix' as const },
  { field: 'RefTransId', mode: 'prefix' as const },
  { field: 'ItemName', mode: 'contains' as const },
];
