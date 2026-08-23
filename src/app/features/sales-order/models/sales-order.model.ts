import { BadgeTone } from '../../../shared/models/badge.model';

/**
 * One backorder line — an open order line with remaining physical inventory
 * still to fulfil.
 *
 * This shape is the report's contract, NOT any one entity's schema. Growpath
 * publishes it directly as the composite `GP_SalesHeaderAndLineData`; Shatat
 * does not publish that entity at all, so there the same shape is assembled by
 * joining `SalesLineBiEntities` to `SalesTableBiEntities` on
 * `(dataAreaId, SalesId)` — the `SalesTable_*` fields are the header half.
 * Every screen binds to this, so the source swap is invisible above the service.
 */
export interface SalesBackorderRecord {
  dataAreaId: string;
  SalesId: string; // Sales order number
  LineNum?: number; // Line number
  ItemId?: string; // Product number
  Name?: string; // Line/item description
  CustAccount: string; // Customer account
  SalesTable_SalesName?: string; // Customer name
  SalesTable_InvoiceAccount?: string;
  SalesType?: string;
  SalesTable_SalesStatus?: string;
  SalesTable_DocumentStatus?: string; // Release/document status
  SalesStatus?: string;
  SalesTable_DeliveryDate?: string; // Sales order delivery date (ISO)
  ShippingDateRequested?: string; // Requested ship date (ISO)
  QtyOrdered?: number; // Quantity ordered
  RemainInventPhysical: number; // Units remaining to ship
  LineAmount?: number; // Line net amount
  CurrencyCode: string;
}

/** Fields on the composite entity — all proven to exist on `GP_SalesHeaderAndLineData`. */
export const SALES_SELECT_FIELDS = [
  'dataAreaId',
  'SalesId',
  'LineNum',
  'ItemId',
  'Name',
  'CustAccount',
  'SalesTable_SalesName',
  'SalesTable_InvoiceAccount',
  'SalesType',
  'SalesTable_SalesStatus',
  'SalesTable_DocumentStatus',
  'SalesStatus',
  'SalesTable_DeliveryDate',
  'ShippingDateRequested',
  'QtyOrdered',
  'RemainInventPhysical',
  'LineAmount',
  'CurrencyCode',
].join(',');

/** The header half of a split source, before it is folded into a {@link SalesBackorderRecord}. */
export interface SalesHeaderRecord {
  dataAreaId: string;
  SalesId: string;
  SalesName?: string;
  InvoiceAccount?: string;
  SalesStatus?: string;
  DocumentStatus?: string;
  DeliveryDate?: string;
}

/**
 * `$select` for the LINE half of a split source (`SalesLineBiEntities`).
 *
 * Deliberately the raw SalesLine column names — they match
 * {@link SalesBackorderRecord} one-for-one, which is why this BI entity was
 * chosen over the friendlier `SalesOrderLines` (whose columns are all renamed,
 * e.g. `SalesOrderNumber`/`OrderedSalesQuantity`, and which drops
 * `RemainInventPhysical` entirely — the report's central measure).
 */
export const SALES_LINE_SELECT_FIELDS = [
  'dataAreaId',
  'SalesId',
  'LineNum',
  'ItemId',
  'Name',
  'CustAccount',
  'SalesType',
  'SalesStatus',
  'ShippingDateRequested',
  'QtyOrdered',
  'RemainInventPhysical',
  'LineAmount',
  'CurrencyCode',
].join(',');

/** `$select` for the HEADER half of a split source (`SalesTableBiEntities`). */
export const SALES_HEADER_SELECT_FIELDS = [
  'dataAreaId',
  'SalesId',
  'SalesName',
  'InvoiceAccount',
  'SalesStatus',
  'DocumentStatus',
  'DeliveryDate',
].join(',');

/** Join key — orders are only unique per legal entity, so the company is part of it. */
export function salesOrderKey(r: { dataAreaId: string; SalesId: string }): string {
  return `${r.dataAreaId}|${r.SalesId}`;
}

/** Map a D365 document status to a badge colour tone. */
export function documentStatusTone(status: string | undefined): BadgeTone {
  switch ((status ?? '').toLowerCase()) {
    case 'invoice':
    case 'invoiced':
      return 'success';
    case 'packingslip':
      return 'info';
    case 'confirmation':
    case 'confirmed':
      return 'warning';
    case 'none':
    case '':
      return 'neutral';
    default:
      return 'neutral';
  }
}
