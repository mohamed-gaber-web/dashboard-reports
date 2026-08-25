import { describe, expect, it } from 'vitest';
import { GroupTotal } from '../../../core/aggregation/aggregate-plan.model';
import {
  chooseGrain,
  isPeriodShorthand,
  maxPointsFor,
  periodBound,
  rollUp,
  windowTotals,
} from './time-buckets';

/**
 * Trends and period comparisons are the two things the report could not do
 * before, and both are this file's arithmetic. The properties worth pinning are
 * the ones that make a chart LIE when they break: chronological order, gaps
 * filled as zeros, and windows that include both their end days.
 */
function days(entries: Record<string, [number, Record<string, number>?]>): Record<string, GroupTotal> {
  return Object.fromEntries(
    Object.entries(entries).map(([day, [count, sums]]) => [day, { count, sums: sums ?? {} }]),
  );
}

describe('chooseGrain', () => {
  it('uses days for a short span', () => {
    expect(chooseGrain(['2025-03-01', '2025-03-20'])).toBe('day');
  });

  it('uses weeks for a few months', () => {
    expect(chooseGrain(['2025-01-01', '2025-05-01'])).toBe('week');
  });

  it('uses months for a year or two', () => {
    expect(chooseGrain(['2024-01-01', '2025-06-01'])).toBe('month');
  });

  it('uses years for a decade', () => {
    expect(chooseGrain(['2010-01-01', '2025-01-01'])).toBe('year');
  });

  it('is chosen from the SPAN, not the point count', () => {
    // Two points three years apart is a monthly story, not a two-day one.
    expect(chooseGrain(['2022-01-01', '2025-01-01'])).toBe('month');
  });
});

describe('rollUp', () => {
  it('returns nothing for an unfolded dimension', () => {
    expect(rollUp(undefined, 'month').buckets).toEqual([]);
  });

  it('ignores keys that are not calendar days', () => {
    // A nominal dimension would never be passed here, but model output decides
    // which field is grouped, so a non-date key must not become a bucket.
    const { buckets } = rollUp(days({ 'Site A': [5], '2025-03-01': [2] }), 'month');
    expect(buckets).toHaveLength(1);
    expect(buckets[0].key).toBe('2025-03');
  });

  it('sums days into months and labels them', () => {
    const { buckets } = rollUp(
      days({
        '2025-01-05': [2, { Qty: 10 }],
        '2025-01-20': [3, { Qty: 5 }],
        '2025-02-02': [1, { Qty: 7 }],
      }),
      'month',
      ['Qty'],
    );
    expect(buckets.map((b) => b.key)).toEqual(['2025-01', '2025-02']);
    expect(buckets[0]).toMatchObject({ label: 'Jan 2025', count: 5, sums: { Qty: 15 } });
    expect(buckets[1]).toMatchObject({ label: 'Feb 2025', count: 1, sums: { Qty: 7 } });
  });

  it('fills an empty month with a zero rather than skipping it', () => {
    // A line chart that skips March draws a straight segment across it, which
    // reads as "flat" instead of "nothing happened".
    const { buckets } = rollUp(
      days({ '2025-01-05': [2], '2025-04-05': [4] }),
      'month',
      ['Qty'],
    );
    expect(buckets.map((b) => b.key)).toEqual(['2025-01', '2025-02', '2025-03', '2025-04']);
    expect(buckets[1]).toMatchObject({ count: 0, sums: { Qty: 0 } });
    expect(buckets[3].count).toBe(4);
  });

  it('is always chronological, never ranked by value', () => {
    const { buckets } = rollUp(days({ '2025-03-01': [1], '2025-01-01': [99] }), 'month');
    expect(buckets.map((b) => b.key)).toEqual(['2025-01', '2025-02', '2025-03']);
  });

  it('buckets by quarter with the right boundaries', () => {
    const { buckets } = rollUp(
      days({ '2025-03-31': [1], '2025-04-01': [2], '2025-12-31': [3] }),
      'quarter',
    );
    expect(buckets.map((b) => b.key)).toEqual(['2025-Q1', '2025-Q2', '2025-Q3', '2025-Q4']);
    expect(buckets[0].label).toBe('Q1 2025');
    expect(buckets[1].count).toBe(2);
  });

  it('buckets a week onto its Monday', () => {
    // 2025-03-05 is a Wednesday; 2025-03-09 the Sunday that closes the same week.
    const { buckets } = rollUp(days({ '2025-03-05': [1], '2025-03-09': [2] }), 'week');
    expect(buckets).toHaveLength(1);
    expect(buckets[0].key).toBe('2025-03-03');
    expect(buckets[0].count).toBe(3);
  });

  it('keeps the RECENT end when a series is longer than the grain allows', () => {
    const cap = maxPointsFor('month');
    const entries: Record<string, [number]> = {};
    for (let i = 0; i < cap + 6; i++) {
      const month = String((i % 12) + 1).padStart(2, '0');
      entries[`${2000 + Math.floor(i / 12)}-${month}-01`] = [i];
    }
    const { buckets, truncated } = rollUp(days(entries), 'month');
    expect(buckets).toHaveLength(cap);
    expect(truncated).toBe(6);
    // The newest month survives; the oldest is what was dropped.
    expect(buckets[buckets.length - 1].key).toBe(`${2000 + Math.floor((cap + 5) / 12)}-${String(((cap + 5) % 12) + 1).padStart(2, '0')}`);
  });

  it('picks the grain itself when asked for "auto"', () => {
    const { grain } = rollUp(days({ '2020-01-01': [1], '2025-01-01': [1] }), 'auto');
    expect(grain).toBe('quarter');
  });
});

describe('windowTotals', () => {
  const data = days({
    '2025-01-31': [1, { Qty: 10 }],
    '2025-02-01': [2, { Qty: 20 }],
    '2025-02-28': [4, { Qty: 40 }],
    '2025-03-01': [8, { Qty: 80 }],
  });

  it('includes both end days', () => {
    expect(windowTotals(data, '2025-02-01', '2025-02-28')).toEqual({
      count: 6,
      sums: { Qty: 60 },
    });
  });

  it('excludes days outside the window', () => {
    expect(windowTotals(data, '2025-03-01', '2025-03-31').count).toBe(8);
  });

  it('accepts a full ISO timestamp, not only a day', () => {
    expect(windowTotals(data, '2025-02-01T00:00:00Z', '2025-02-28T23:59:59Z').count).toBe(6);
  });

  it('is empty for a window with no rows, rather than throwing', () => {
    expect(windowTotals(data, '2024-01-01', '2024-12-31')).toEqual({ count: 0, sums: {} });
  });

  it('is empty for an unparseable range', () => {
    expect(windowTotals(data, 'last month', 'now')).toEqual({ count: 0, sums: {} });
  });
});

/**
 * The tool schema asks for YYYY-MM-DD, but a live model asked to compare
 * "August with July" writes `2025-08` about as often as `2025-08-01`. The
 * abbreviation is unambiguous, and a comparison is usually the ONLY section in
 * its report — so rejecting it over a formatting detail costs the user the
 * whole answer.
 */
describe('periodBound', () => {
  it('passes a full day through, timestamp or not', () => {
    expect(periodBound('2025-08-17', 'start')).toBe('2025-08-17');
    expect(periodBound('2025-08-17T09:00:00Z', 'end')).toBe('2025-08-17');
  });

  it('expands a month to its real first and last day', () => {
    expect(periodBound('2025-08', 'start')).toBe('2025-08-01');
    expect(periodBound('2025-08', 'end')).toBe('2025-08-31');
    expect(periodBound('2025-02', 'end')).toBe('2025-02-28');
    // Leap years come from the calendar, not from a table someone has to update.
    expect(periodBound('2024-02', 'end')).toBe('2024-02-29');
  });

  it('expands a quarter, however it is spelled', () => {
    expect(periodBound('2025-Q2', 'start')).toBe('2025-04-01');
    expect(periodBound('2025-Q2', 'end')).toBe('2025-06-30');
    expect(periodBound('2025q4', 'end')).toBe('2025-12-31');
  });

  it('expands a bare year', () => {
    expect(periodBound('2025', 'start')).toBe('2025-01-01');
    expect(periodBound('2025', 'end')).toBe('2025-12-31');
  });

  it('rejects prose, blanks and nonsense rather than guessing', () => {
    for (const value of ['last month', '', null, undefined, 'Q2', 'August 2025']) {
      expect(periodBound(value, 'start')).toBeNull();
    }
  });

  it('rejects a date that does not exist', () => {
    // Shape alone is not enough: these look like dates and match nothing, so
    // accepting them would report a real zero for an unreal window.
    expect(periodBound('2025-13', 'start')).toBeNull();
    expect(periodBound('2025-00', 'start')).toBeNull();
    expect(periodBound('2025-02-31', 'start')).toBeNull();
    expect(periodBound('2025-02-28', 'start')).toBe('2025-02-28');
  });

  it('distinguishes a shorthand from a specific day', () => {
    // Only a shorthand may fill in a missing opposite bound — a single day is
    // almost never what "this month" meant.
    expect(isPeriodShorthand('2025-08')).toBe(true);
    expect(isPeriodShorthand('2025-Q2')).toBe(true);
    expect(isPeriodShorthand('2025-08-17')).toBe(false);
    expect(isPeriodShorthand('whenever')).toBe(false);
  });
});
