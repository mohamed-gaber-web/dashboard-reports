/** Comparison helpers for sorting table columns. Pure — no state. */

/**
 * A string that is really a number, allowing for the decoration a formatted
 * cell carries: currency symbols, thousands separators, percent signs,
 * parenthesised negatives, and a leading sign.
 *
 * Deliberately strict about what it accepts. `"Q4 2025"` and `"Order 1240"`
 * contain digits but are not quantities, and coercing them would sort a text
 * column by an arbitrary substring.
 */
const NUMERIC_TEXT = /^[($+-]*\s*[\d,]+(\.\d+)?\s*[)%]*$|^[+-]?[\d,]+(\.\d+)?\s*[A-Z]{0,3}$/;

/**
 * Read a formatted string as a number, or `null` if it is not one.
 *
 * This is what stops `"92"` sorting after `"145"`. Lexical order is right for
 * text and wrong for every quantity, and a table whose "Units Sold" column
 * sorts alphabetically looks broken in a way that is easy to miss and hard to
 * trust once noticed.
 */
export function numericValue(value: string): number | null {
  const trimmed = value.trim();
  if (!trimmed || !NUMERIC_TEXT.test(trimmed)) return null;

  // Accounting negatives: "(1,240)" means -1240.
  const negated = /^\(.*\)$/.test(trimmed);
  const digits = trimmed.replace(/[^0-9.-]/g, '');
  if (!digits || digits === '-' || digits === '.') return null;

  const parsed = Number(digits);
  if (!Number.isFinite(parsed)) return null;
  return negated ? -Math.abs(parsed) : parsed;
}

/**
 * Compare two cell values for sorting.
 *
 * Numbers sort numerically, strings that look like numbers sort numerically,
 * everything else sorts by locale. Blank and nullish values always sink to the
 * bottom regardless of direction — an empty cell is absent data, not the
 * smallest value, and letting it lead a descending sort buries the rows the
 * user actually asked to see.
 */
export function compareValues(a: unknown, b: unknown): number {
  const aBlank = a == null || a === '';
  const bBlank = b == null || b === '';
  if (aBlank && bBlank) return 0;
  if (aBlank) return 1;
  if (bBlank) return -1;

  if (typeof a === 'number' && typeof b === 'number') return a - b;

  const aText = String(a);
  const bText = String(b);

  const aNum = numericValue(aText);
  const bNum = numericValue(bText);
  if (aNum !== null && bNum !== null) return aNum - bNum;

  return aText.localeCompare(bText, undefined, { numeric: true, sensitivity: 'base' });
}
