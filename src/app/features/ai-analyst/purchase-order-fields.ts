import { SearchField } from '../../core/http/odata-filter.util';
import { FieldMeta } from './models/field-meta.model';

/**
 * Field metadata for the D365 `PurchaseOrderHeadersV2` dataset.
 *
 * **This is a HEADER entity — one row per purchase order, and it carries no
 * amount or quantity column at all.** So it has no `measure: true` field, and
 * every question about it is answered by `count` / `distinctCount` over the
 * dimensions below ("how many orders by vendor", "orders by status"). That is a
 * real limit of the entity, not an omission here: advertising a measure the
 * entity does not have would only get the planner a 400 from D365. Order *value*
 * lives on the lines (`PurchaseOrderLines`), which this source does not join.
 *
 * The two enums were confirmed against the live tenant rather than guessed — the
 * OData type names do not match their property names, and a wrong one is an
 * opaque 400 rather than a useful error:
 *   `PurchaseOrderStatus`    -> `PurchStatus`
 *   `DocumentApprovalStatus` -> `VersioningDocumentState`
 */
export const PURCH_STATUS_ENUM = 'PurchStatus';
export const PURCH_STATUS = ['None', 'Backorder', 'Received', 'Invoiced', 'Canceled'] as const;

export const DOC_APPROVAL_STATE_ENUM = 'VersioningDocumentState';
export const DOC_APPROVAL_STATE = [
  'Draft',
  'InReview',
  'Rejected',
  'Approved',
  'Confirmed',
  'Finalized',
] as const;

export const PURCHASE_ORDER_FIELDS: FieldMeta[] = [
  { key: 'PurchaseOrderNumber', label: 'Purchase order', type: 'string', format: 'text', search: 'prefix', dimension: true },
  { key: 'OrderVendorAccountNumber', label: 'Vendor account', type: 'string', format: 'text', search: 'prefix', dimension: true },
  { key: 'InvoiceVendorAccountNumber', label: 'Invoice vendor', type: 'string', format: 'text', search: 'prefix', dimension: true },
  { key: 'PurchaseOrderName', label: 'Order name', type: 'string', format: 'text', search: 'contains', dimension: true },
  {
    key: 'PurchaseOrderStatus',
    label: 'Order status',
    type: 'enum',
    format: 'text',
    enumType: PURCH_STATUS_ENUM,
    enumMembers: PURCH_STATUS,
    dimension: true,
  },
  {
    key: 'DocumentApprovalStatus',
    label: 'Approval status',
    type: 'enum',
    format: 'text',
    enumType: DOC_APPROVAL_STATE_ENUM,
    enumMembers: DOC_APPROVAL_STATE,
    dimension: true,
  },
  { key: 'CurrencyCode', label: 'Currency', type: 'string', format: 'text', dimension: true },
  { key: 'DefaultReceivingSiteId', label: 'Receiving site', type: 'string', format: 'text', dimension: true },
  { key: 'DefaultReceivingWarehouseId', label: 'Receiving warehouse', type: 'string', format: 'text', dimension: true },
  { key: 'DeliveryAddressName', label: 'Delivery address', type: 'string', format: 'text', search: 'contains', dimension: true },
  { key: 'DeliveryModeId', label: 'Delivery mode', type: 'string', format: 'text', dimension: true },
  { key: 'DeliveryTermsId', label: 'Delivery terms', type: 'string', format: 'text', dimension: true },
  { key: 'PaymentTermsName', label: 'Payment terms', type: 'string', format: 'text', dimension: true },
  { key: 'PurchaseOrderPoolId', label: 'Order pool', type: 'string', format: 'text', dimension: true },
  { key: 'BuyerGroupId', label: 'Buyer group', type: 'string', format: 'text', dimension: true },
  { key: 'ProjectId', label: 'Project', type: 'string', format: 'text', dimension: true },
  { key: 'RequesterPersonnelNumber', label: 'Requester', type: 'string', format: 'text', dimension: true },
  { key: 'AccountingDate', label: 'Accounting date', type: 'date', format: 'date' },
  { key: 'RequestedDeliveryDate', label: 'Requested delivery', type: 'date', format: 'date' },
];

/**
 * The date the analyst windows on.
 *
 * `AccountingDate` and `RequestedDeliveryDate` are both fully populated;
 * `ConfirmedDeliveryDate` is the D365 null-date sentinel on every row in the
 * tenant, so it is deliberately absent from the schema above — offering it would
 * let the planner build a window that silently matches nothing.
 */
export const PURCHASE_ORDER_DATE_FIELD = 'AccountingDate';

/** `$select` for the detail table — every key above, plus the company. */
export const PURCHASE_ORDER_SELECT = [
  'dataAreaId',
  ...PURCHASE_ORDER_FIELDS.map((f) => f.key),
].join(',');

export const PURCHASE_ORDER_SEARCH_FIELDS: SearchField[] = [
  { field: 'PurchaseOrderNumber', mode: 'prefix' },
  { field: 'OrderVendorAccountNumber', mode: 'prefix' },
  { field: 'PurchaseOrderName', mode: 'contains' },
  { field: 'DeliveryAddressName', mode: 'contains' },
];
