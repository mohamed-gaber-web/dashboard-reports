import { Cube, GroupTotal } from './aggregate-plan.model';
import { SliceTooLargeError, cubeTopN } from './aggregation.service';

/**
 * The cube is the whole reason the fold exists: it holds EVERY group key, so a
 * top-N chart's "Other" bucket is an exact total rather than an estimate over a
 * truncated slice. These tests pin that guarantee.
 */
function cube(dims: Record<string, Record<string, GroupTotal>>): Cube {
  return { filter: 'x', builtAt: 0, rowsFolded: 0, totalRows: 0, totals: {}, dims };
}

function group(count: number, sums: Record<string, number> = {}): GroupTotal {
  return { count, sums };
}

describe('cubeTopN', () => {
  it('returns [] for a dimension that was never folded', () => {
    expect(cubeTopN(cube({}), 'Site', undefined)).toEqual([]);
  });

  it('ranks by row count when no measure is given', () => {
    const c = cube({ Site: { A: group(3), B: group(10), C: group(1) } });
    expect(cubeTopN(c, 'Site', undefined)).toEqual([
      { label: 'B', value: 10 },
      { label: 'A', value: 3 },
      { label: 'C', value: 1 },
    ]);
  });

  it('ranks by a measure sum when one is given', () => {
    const c = cube({
      Site: {
        A: group(3, { Amount: 30 }),
        B: group(10, { Amount: 5 }),
      },
    });
    expect(cubeTopN(c, 'Site', 'Amount')).toEqual([
      { label: 'A', value: 30 },
      { label: 'B', value: 5 },
    ]);
  });

  it('returns every group unchanged when there are no more than topN', () => {
    const c = cube({ Site: { A: group(3), B: group(2) } });
    expect(cubeTopN(c, 'Site', undefined, 8)).toHaveLength(2);
  });

  it('collapses the tail into an EXACT "Other" total once topN is exceeded', () => {
    const c = cube({
      Site: { A: group(50), B: group(40), C: group(30), D: group(20), E: group(10) },
    });
    // topN = 3 → two heads (A, B) plus an Other bucket summing C+D+E = 60.
    expect(cubeTopN(c, 'Site', undefined, 3)).toEqual([
      { label: 'A', value: 50 },
      { label: 'B', value: 40 },
      { label: 'Other', value: 60 },
    ]);
  });

  it('treats a missing measure sum in a group as zero', () => {
    const c = cube({ Site: { A: group(1, { Amount: 5 }), B: group(1) } });
    expect(cubeTopN(c, 'Site', 'Amount')).toEqual([
      { label: 'A', value: 5 },
      { label: 'B', value: 0 },
    ]);
  });
});

describe('SliceTooLargeError', () => {
  it('carries the numbers and states them in a human message', () => {
    const err = new SliceTooLargeError(11_000_000, 250_000);
    expect(err.rows).toBe(11_000_000);
    expect(err.limit).toBe(250_000);
    expect(err.name).toBe('SliceTooLargeError');
    expect(err.message).toContain('11,000,000');
    expect(err.message).toContain('250,000');
  });
});
