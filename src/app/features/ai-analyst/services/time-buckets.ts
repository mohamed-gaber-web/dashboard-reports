import { GroupTotal } from '../../../core/aggregation/aggregate-plan.model';
import { TimeGrain } from '../models/report-spec.model';

/**
 * Rolling day-grain cube buckets up into a time axis.
 *
 * The fold (see `aggregation.worker.ts`) groups every date field by calendar
 * day. Day is the finest grain anything asks for and every coarser one divides
 * it exactly, so a week, month, quarter or year total is a sum of days — never
 * a re-read of D365, and never an approximation.
 *
 * Pure functions, no Angular, no I/O: this is arithmetic over a small object,
 * and it is the part of a trend chart most worth pinning with tests.
 */

/** A grain that can actually be drawn. `auto` is resolved before it gets here. */
export type Grain = Exclude<TimeGrain, 'auto'>;

/** One point on a time axis. */
export interface TimeBucket {
  /** Sortable bucket id — `2025-03`, `2025-Q1`, `2025-03-17`, `2025`. */
  key: string;
  /** How it is written on the axis. */
  label: string;
  count: number;
  sums: Record<string, number>;
}

export interface RolledSeries {
  buckets: TimeBucket[];
  /** Points dropped off the FRONT to fit {@link maxPointsFor}. 0 when none were. */
  truncated: number;
  grain: Grain;
}

const MONTHS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
];

/**
 * How many points each grain may draw.
 *
 * Past these the axis is a smear: 400 daily points in a 600px card is one pixel
 * per day. The excess is dropped from the OLDEST end and the count is reported,
 * so the chart says "last 36 months of 51" rather than silently reframing the
 * question.
 */
export function maxPointsFor(grain: Grain): number {
  switch (grain) {
    case 'day':
      return 62;
    case 'week':
      return 53;
    case 'month':
      return 36;
    case 'quarter':
      return 24;
    case 'year':
      return 20;
  }
}

/** Whether a string is a `YYYY-MM-DD` day key the fold could have produced. */
export function isDayKey(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value);
}

/**
 * The grain that fits a span without either flattening it or shredding it.
 *
 * Chosen from the span rather than the point count: 400 rows spread over three
 * years is a monthly story, and the same 400 spread over a fortnight is a daily
 * one.
 */
export function chooseGrain(days: string[]): Grain {
  if (days.length < 2) return 'day';
  const sorted = [...days].sort();
  const span = daysBetween(sorted[0], sorted[sorted.length - 1]);
  if (span <= 45) return 'day';
  if (span <= 200) return 'week';
  if (span <= 1100) return 'month';
  if (span <= 3650) return 'quarter';
  return 'year';
}

/**
 * Fold day buckets into `grain`, chronologically, with empty periods filled in.
 *
 * Gap-filling is not cosmetic. A month with no orders is a zero, and a line
 * chart that simply skips it draws a straight segment across the hole — which
 * is the difference between "sales stopped in March" and "sales were flat".
 */
export function rollUp(
  days: Record<string, GroupTotal> | undefined,
  requested: TimeGrain | undefined,
  measures: string[] = [],
): RolledSeries {
  const entries = Object.entries(days ?? {}).filter(([key]) => isDayKey(key));
  const grain =
    !requested || requested === 'auto' ? chooseGrain(entries.map(([k]) => k)) : requested;

  if (!entries.length) return { buckets: [], truncated: 0, grain };

  const byKey = new Map<string, TimeBucket>();
  for (const [day, group] of entries) {
    const key = bucketKey(day, grain);
    let bucket = byKey.get(key);
    if (!bucket) {
      bucket = { key, label: bucketLabel(key, grain), count: 0, sums: {} };
      byKey.set(key, bucket);
    }
    bucket.count += group.count;
    for (const [measure, value] of Object.entries(group.sums)) {
      bucket.sums[measure] = (bucket.sums[measure] ?? 0) + value;
    }
  }

  const ordered = [...byKey.values()].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  const filled = fillGaps(ordered, grain, measures);

  const cap = maxPointsFor(grain);
  if (filled.length <= cap) return { buckets: filled, truncated: 0, grain };
  // Keep the RECENT end: a trend question is nearly always about now.
  return { buckets: filled.slice(-cap), truncated: filled.length - cap, grain };
}

/**
 * Totals for every day inside `[from, to]`, both ends inclusive.
 *
 * ISO day keys sort lexicographically in date order, so the window test is a
 * pair of string comparisons — no Date objects in the loop.
 */
export function windowTotals(
  days: Record<string, GroupTotal> | undefined,
  from: string,
  to: string,
): { count: number; sums: Record<string, number> } {
  const lo = normaliseDay(from);
  const hi = normaliseDay(to);
  const out = { count: 0, sums: {} as Record<string, number> };
  if (!lo || !hi) return out;

  for (const [day, group] of Object.entries(days ?? {})) {
    if (!isDayKey(day) || day < lo || day > hi) continue;
    out.count += group.count;
    for (const [measure, value] of Object.entries(group.sums)) {
      out.sums[measure] = (out.sums[measure] ?? 0) + value;
    }
  }
  return out;
}

/** `2025-03-17T00:00:00Z` / `2025-03-17` → `2025-03-17`. Anything else → null. */
export function normaliseDay(value: string): string | null {
  const day = String(value ?? '').slice(0, 10);
  return isDayKey(day) ? day : null;
}

/**
 * A period bound, from however precisely the model wrote it.
 *
 * `emit_report` asks for `YYYY-MM-DD`, but a model reaching for "August 2025"
 * or "Q2 2025" will often write `2025-08` or `2025-Q2` — the abbreviation is
 * unambiguous, and rejecting it would drop a comparison the user asked for over
 * a formatting detail. Anything genuinely ambiguous still returns null.
 *
 * @param edge which end of the period a partial value expands to.
 */
export function periodBound(value: unknown, edge: 'start' | 'end'): string | null {
  const text = String(value ?? '').trim();

  // `isDayKey` only checks the SHAPE — cube keys come from real ISO dates, so
  // that is enough there. A bound comes from the model, so "2025-02-31" and
  // "2025-13-01" have to be rejected rather than silently matching nothing.
  const day = normaliseDay(text);
  if (day) return isRealDay(day) ? day : null;

  const month = /^(\d{4})-(\d{2})$/.exec(text);
  if (month) {
    const index = Number(month[2]);
    if (index < 1 || index > 12) return null;
    return edge === 'start' ? `${text}-01` : lastDayOf(Number(month[1]), index);
  }

  const quarter = /^(\d{4})-?Q([1-4])$/i.exec(text);
  if (quarter) {
    const year = Number(quarter[1]);
    const first = (Number(quarter[2]) - 1) * 3 + 1;
    return edge === 'start'
      ? `${year}-${pad(first)}-01`
      : lastDayOf(year, first + 2);
  }

  const year = /^(\d{4})$/.exec(text);
  if (year) return edge === 'start' ? `${text}-01-01` : `${text}-12-31`;

  return null;
}

/** True when a bound named a whole month, quarter or year rather than one day. */
export function isPeriodShorthand(value: unknown): boolean {
  const text = String(value ?? '').trim();
  return !normaliseDay(text) && periodBound(text, 'start') !== null;
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

/** A day key that names a date that exists. `2025-02-31` does not round-trip. */
function isRealDay(day: string): boolean {
  return new Date(`${day}T00:00:00Z`).toISOString().slice(0, 10) === day;
}

/** Day 0 of the NEXT month is the last day of this one — no leap-year table. */
function lastDayOf(year: number, month: number): string {
  return new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10);
}

// ── Grain arithmetic ───────────────────────────────────────────────────────

function bucketKey(day: string, grain: Grain): string {
  switch (grain) {
    case 'day':
      return day;
    case 'week':
      return weekStart(day);
    case 'month':
      return day.slice(0, 7);
    case 'quarter':
      return `${day.slice(0, 4)}-Q${Math.floor((Number(day.slice(5, 7)) - 1) / 3) + 1}`;
    case 'year':
      return day.slice(0, 4);
  }
}

function bucketLabel(key: string, grain: Grain): string {
  switch (grain) {
    case 'day':
    case 'week': {
      const month = MONTHS[Number(key.slice(5, 7)) - 1] ?? '';
      return `${key.slice(8, 10)} ${month}`;
    }
    case 'month': {
      const month = MONTHS[Number(key.slice(5, 7)) - 1] ?? '';
      return `${month} ${key.slice(0, 4)}`;
    }
    case 'quarter':
      return `${key.slice(5)} ${key.slice(0, 4)}`;
    case 'year':
      return key;
  }
}

/** The Monday of the week `day` falls in, as a day key. */
function weekStart(day: string): string {
  const date = new Date(`${day}T00:00:00Z`);
  // getUTCDay: 0 = Sunday. Shift so Monday is 0.
  const offset = (date.getUTCDay() + 6) % 7;
  date.setUTCDate(date.getUTCDate() - offset);
  return date.toISOString().slice(0, 10);
}

/** The bucket immediately after `key`, at the same grain. */
function nextKey(key: string, grain: Grain): string {
  switch (grain) {
    case 'day':
      return shiftDays(key, 1);
    case 'week':
      return shiftDays(key, 7);
    case 'month':
      return shiftMonths(`${key}-01`, 1).slice(0, 7);
    case 'quarter': {
      const year = Number(key.slice(0, 4));
      const quarter = Number(key.slice(6));
      return quarter === 4 ? `${year + 1}-Q1` : `${year}-Q${quarter + 1}`;
    }
    case 'year':
      return String(Number(key) + 1);
  }
}

function shiftDays(day: string, by: number): string {
  const date = new Date(`${day}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + by);
  return date.toISOString().slice(0, 10);
}

function shiftMonths(day: string, by: number): string {
  const date = new Date(`${day}T00:00:00Z`);
  date.setUTCMonth(date.getUTCMonth() + by);
  return date.toISOString().slice(0, 10);
}

function daysBetween(from: string, to: string): number {
  const a = Date.parse(`${from}T00:00:00Z`);
  const b = Date.parse(`${to}T00:00:00Z`);
  return Number.isNaN(a) || Number.isNaN(b) ? 0 : Math.round((b - a) / 86_400_000);
}

/**
 * Insert zero buckets for every period between the first and the last.
 *
 * Bounded by the grain's own cap plus a safety margin: a corrupt date in the
 * data ("3025-01-01") would otherwise ask this to materialise a thousand years
 * of empty years.
 */
function fillGaps(buckets: TimeBucket[], grain: Grain, measures: string[]): TimeBucket[] {
  if (buckets.length < 2) return buckets;

  const limit = maxPointsFor(grain) * 4;
  const zeros = () => Object.fromEntries(measures.map((m) => [m, 0]));
  const out: TimeBucket[] = [];
  const last = buckets[buckets.length - 1].key;

  let cursor = buckets[0].key;
  let index = 0;

  while (out.length < limit) {
    if (buckets[index]?.key === cursor) {
      out.push(buckets[index]);
      index += 1;
    } else {
      out.push({ key: cursor, label: bucketLabel(cursor, grain), count: 0, sums: zeros() });
    }
    if (cursor === last) break;
    cursor = nextKey(cursor, grain);
  }

  // Ran past the guard — the range is nonsense, so fall back to the real
  // buckets rather than a wall of manufactured zeros.
  return out.length >= limit ? buckets : out;
}
