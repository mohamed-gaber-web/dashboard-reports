import { BadgeTone } from '../../../shared/models/badge.model';

/**
 * One backorder line from the D365 `GP_SalesHeaderAndLineData` entity —
 * an open order line with remaining physical inventory still to fulfil.
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

/** Fields requested from D365 — all proven to exist on the entity. */
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
