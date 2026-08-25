import { SearchField } from '../../core/http/odata-filter.util';
import { FieldMeta } from './models/field-meta.model';

/**
 * Field metadata for the general-ledger dataset behind the Executive report.
 *
 * ## READ THIS BEFORE THE MODULE GOES LIVE
 *
 * **The entity and the columns below are the STANDARD F&O shape and have not yet
 * been confirmed against your tenant.** Entity and column names are not portable
 * between F&O environments, and a wrong one is an opaque HTTP 400 rather than a
 * useful error — the same trap `CLAUDE.md` records for `enumType`. Confirm both
 * before trusting a figure, which takes about ten seconds:
 *
 * ```
 * node scripts/probe-entity.js --search journal        # what is published here?
 * node scripts/probe-entity.js --entity GeneralJournalAccountEntries --company 003
 * ```
 *
 * The second command prints the real column names and types for one row. Correct
 * the list below against it, then set `environment.trialBalance.entity` to
 * whatever the first command actually found. Until that is done the module is
 * wired but unverified, and `environment.trialBalance.enabled` keeps it out of
 * the pickers so nobody is shown a report built on a 400.
 *
 * ## Why a journal-entry entity and not a "trial balance" entity
 *
 * A trial balance is an aggregate: one row per main account, with a balance. F&O
 * publishes it as a report rather than as a queryable entity in most
 * environments, and this app cannot GROUP BY over OData anyway — that is what
 * the Worker fold exists for. So the source is the ENTRY level, and the fold
 * sums `AccountingCurrencyAmount` by `MainAccountId` to produce exactly the
 * trial balance the report needs. Same shape as every other module here.
 *
 * ## Why the account TYPE matters more than usual
 *
 * The Executive report separates revenue from expenses and assets from
 * liabilities. That classification lives on the main account, not on the entry
 * — so if your tenant's entry entity does not carry an account-type column, the
 * report can total by account but cannot build a real P&L or balance sheet, and
 * it is instructed to write `غير متاح` rather than guess which accounts are
 * which. Do not add a `MainAccountType` field here unless the probe shows one.
 */

export const TRIAL_BALANCE_FIELDS: FieldMeta[] = [
  {
    key: 'MainAccountId',
    label: 'Main account',
    type: 'string',
    format: 'text',
    search: 'prefix',
    dimension: true,
  },
  {
    key: 'LedgerAccount',
    label: 'Ledger account',
    type: 'string',
    format: 'text',
    search: 'prefix',
    dimension: true,
  },
  {
    key: 'PostingType',
    label: 'Posting type',
    type: 'string',
    format: 'text',
    dimension: true,
  },
  {
    key: 'JournalNumber',
    label: 'Journal number',
    type: 'string',
    format: 'text',
    search: 'prefix',
    dimension: true,
  },
  {
    key: 'TransactionCurrencyCode',
    label: 'Transaction currency',
    type: 'string',
    format: 'text',
    dimension: true,
  },
  // The measure the trial balance is actually made of. Accounting currency
  // rather than transaction currency: summing across currencies is meaningless,
  // and this is the one already converted to the ledger's own.
  {
    key: 'AccountingCurrencyAmount',
    label: 'Amount (accounting currency)',
    type: 'number',
    format: 'currency',
    measure: true,
  },
  {
    key: 'TransactionCurrencyAmount',
    label: 'Amount (transaction currency)',
    type: 'number',
    format: 'currency',
    measure: true,
  },
  { key: 'AccountingDate', label: 'Accounting date', type: 'date', format: 'date' },
];

/** The date the report windows on — the period a figure belongs to. */
export const TRIAL_BALANCE_DATE_FIELD = 'AccountingDate';

/** `$select` for the detail table — every key above, plus the company. */
export const TRIAL_BALANCE_SELECT = [
  'dataAreaId',
  ...TRIAL_BALANCE_FIELDS.map((f) => f.key),
].join(',');

export const TRIAL_BALANCE_SEARCH_FIELDS: SearchField[] = [
  { field: 'MainAccountId', mode: 'prefix' },
  { field: 'LedgerAccount', mode: 'prefix' },
  { field: 'JournalNumber', mode: 'prefix' },
];
