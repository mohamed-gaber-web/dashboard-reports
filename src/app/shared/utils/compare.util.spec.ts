import { describe, expect, it } from 'vitest';
import { compareValues, numericValue } from './compare.util';

describe('numericValue', () => {
  it('reads plain and grouped numbers', () => {
    expect(numericValue('145')).toBe(145);
    expect(numericValue('1,240')).toBe(1240);
    expect(numericValue('12.5')).toBe(12.5);
  });

  it('reads decorated quantities', () => {
    expect(numericValue('$4,350')).toBe(4350);
    expect(numericValue('14.5%')).toBe(14.5);
    expect(numericValue('-2.1%')).toBe(-2.1);
    expect(numericValue('1,240 USD')).toBe(1240);
  });

  it('reads an accounting negative', () => {
    expect(numericValue('(1,240)')).toBe(-1240);
  });

  it('refuses text that merely contains digits', () => {
    // These are the cases that make a text column sort by an arbitrary
    // substring if the check is too loose.
    expect(numericValue('Q4 2025')).toBeNull();
    expect(numericValue('Order 1240')).toBeNull();
    expect(numericValue('SO-00123')).toBeNull();
    expect(numericValue('Leather Bag')).toBeNull();
    expect(numericValue('')).toBeNull();
  });
});

describe('compareValues', () => {
  it('sorts numeric strings by value, not lexically', () => {
    // The bug this exists to prevent: lexically "92" sorts after "145".
    expect(['145', '92', '1000'].sort(compareValues)).toEqual(['92', '145', '1000']);
  });

  it('sorts currency by value', () => {
    expect(['$4,350', '$920', '$12,000'].sort(compareValues)).toEqual([
      '$920',
      '$4,350',
      '$12,000',
    ]);
  });

  it('sorts real numbers', () => {
    expect([3, 1, 2].sort(compareValues)).toEqual([1, 2, 3]);
  });

  it('sorts text by locale, digits within text naturally', () => {
    expect(['Item 10', 'Item 2'].sort(compareValues)).toEqual(['Item 2', 'Item 10']);
  });

  it('sinks blanks to the bottom in both directions', () => {
    // An empty cell is absent data, not the smallest value — letting it lead a
    // descending sort buries the rows the user asked to see.
    expect(compareValues('', 'a')).toBeGreaterThan(0);
    expect(compareValues('a', '')).toBeLessThan(0);
    expect(compareValues(null, 'a')).toBeGreaterThan(0);
    expect(compareValues(undefined, 5)).toBeGreaterThan(0);
    expect(compareValues('', '')).toBe(0);
  });
});
