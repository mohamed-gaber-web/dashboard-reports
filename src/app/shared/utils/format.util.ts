/** Formatting helpers shared across reports. Pure functions — no state. */

/** Group a whole number with locale thousands separators (e.g. 12,480). */
export function formatInteger(value: number): string {
  return new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 }).format(value ?? 0);
}

/** Format a decimal quantity with up to two fraction digits. */
export function formatQuantity(value: number): string {
  return new Intl.NumberFormat('en-US', {
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  }).format(value ?? 0);
}

/** Compact large numbers for KPI tiles (e.g. 12.4K, 3.1M). */
export function formatCompact(value: number): string {
  return new Intl.NumberFormat('en-US', {
    notation: 'compact',
    maximumFractionDigits: 1,
  }).format(value ?? 0);
}

/** Percentage of `part` within `total`, rounded to a whole number. */
export function percentOf(part: number, total: number): number {
  return total > 0 ? Math.round((part / total) * 100) : 0;
}

/**
 * Format a D365 date (ISO string) as `30 Dec 2016`. D365 uses `1900-01-01`
 * as an "unset" sentinel, which is rendered as an em dash.
 */
export function formatDate(value: string | undefined): string {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime()) || date.getUTCFullYear() <= 1900) return '—';
  return new Intl.DateTimeFormat('en-GB', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(date);
}

/** Format a monetary amount with its currency code (e.g. `$1,240.00`). */
export function formatCurrency(value: number, currency: string | undefined): string {
  const amount = value ?? 0;
  if (!currency) return formatQuantity(amount);
  try {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency,
      maximumFractionDigits: 2,
    }).format(amount);
  } catch {
    // Unknown currency code — fall back to a plain number.
    return `${formatQuantity(amount)} ${currency}`;
  }
}
