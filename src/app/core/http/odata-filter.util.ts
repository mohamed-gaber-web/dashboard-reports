/**
 * Building `$filter` strings for D365 F&O OData.
 *
 * D365 is NOT standard OData v4 here, and the differences are load-bearing.
 * Everything in this file is a measured fact about the live sandbox, not a guess:
 *
 * - **`contains()` does not exist.** D365 implements "contains" as a *wildcard on
 *   equality*: `Field eq '*term*'`. Emitting `contains(Field,'term')` is a 400.
 * - **`startswith()` / `endswith()` do not exist either.** Prefix search is the
 *   same wildcard form: `Field eq 'term*'`.
 * - **Wildcard position decides the cost.** Measured on `Sha_SerialTrans` (11M rows):
 *   prefix `'2020*'` → **~300 ms** (index seek). Contains `'*2020*'` → **~13 s**
 *   (full scan). Prefer prefix; treat contains as an explicit, slow opt-in.
 * - **Enums are not strings.** `Sha_SerialTransType eq 'PurchaseOrder'` is a 400.
 *   It must be `Sha_SerialTransType eq Microsoft.Dynamics.DataEntities.Sha_SerialTransType'PurchaseOrder'`.
 *   Enums support only `eq` / `ne`.
 * - **`in` and `has` are unsupported.** Multi-select must become an `or` chain.
 *
 * Keep this pure (no DI, no HTTP) so it stays unit-testable.
 */

/** The namespace every D365 enum literal is qualified with. */
export const D365_ENUM_NS = 'Microsoft.Dynamics.DataEntities';

/** OData comparison operators D365 actually supports. */
export type ODataOp = 'eq' | 'ne' | 'gt' | 'ge' | 'lt' | 'le';

/** How a string field should be matched when the user types into a search box. */
export type SearchMode = 'prefix' | 'contains' | 'exact';

/**
 * Quote and escape a string literal. A single quote is escaped by doubling it —
 * this is what stops an LLM-authored or user-typed value from breaking out of the
 * literal and altering the query.
 */
export function odataString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/** A numeric literal, rejecting anything that isn't a finite number. */
export function odataNumber(value: unknown): string {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) throw new Error(`Not a finite number: ${String(value)}`);
  return String(n);
}

/** A `Edm.DateTimeOffset` literal — D365 wants an unquoted ISO-8601 instant. */
export function odataDate(value: string | Date): string {
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) throw new Error(`Not a valid date: ${String(value)}`);
  return d.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/**
 * An enum literal: `Microsoft.Dynamics.DataEntities.<EnumType>'<Member>'`.
 * The member is validated against the known members so a hallucinated value
 * becomes a caught error here rather than an opaque 400 from D365.
 */
export function odataEnum(enumType: string, member: string, members?: readonly string[]): string {
  if (members && !members.includes(member)) {
    throw new Error(`'${member}' is not a member of ${enumType}. Valid: ${members.join(', ')}`);
  }
  return `${D365_ENUM_NS}.${enumType}'${member}'`;
}

/** Wrap a wildcard term for the given mode. Any `*` or `'` the user typed is stripped. */
export function wildcard(term: string, mode: SearchMode): string {
  const clean = term.trim().replace(/[*']/g, '');
  if (mode === 'exact') return odataString(clean);
  if (mode === 'prefix') return odataString(`${clean}*`);
  return odataString(`*${clean}*`);
}

/** A field to search, and how. Prefer `prefix` — `contains` is a full table scan. */
export interface SearchField {
  field: string;
  mode: SearchMode;
}

/**
 * OR together a wildcard match across several fields, for a search box.
 *
 * Returns `null` for a term too short to be worth a scan of millions of rows —
 * a 1-character `contains` matches most of the table and costs a full scan for
 * a useless result.
 */
export function buildSearchFilter(
  term: string,
  fields: readonly SearchField[],
  minLength = 2,
): string | null {
  const clean = term.trim().replace(/[*']/g, '');
  if (clean.length < minLength || fields.length === 0) return null;

  const clauses = fields.map((f) => `${f.field} eq ${wildcard(clean, f.mode)}`);
  return clauses.length === 1 ? clauses[0] : `(${clauses.join(' or ')})`;
}

/** `and` together the clauses that are actually present. */
export function and(...clauses: (string | null | undefined)[]): string | undefined {
  const present = clauses.filter((c): c is string => !!c && c.trim().length > 0);
  if (present.length === 0) return undefined;
  return present.join(' and ');
}

/** A half-open date range — `ge from and lt to`. Either bound may be omitted. */
export function dateRange(field: string, from?: string | Date, to?: string | Date): string | null {
  const parts: string[] = [];
  if (from) parts.push(`${field} ge ${odataDate(from)}`);
  if (to) parts.push(`${field} lt ${odataDate(to)}`);
  return parts.length ? parts.join(' and ') : null;
}
