import {
  D365_ENUM_NS,
  and,
  buildSearchFilter,
  dateRange,
  odataDate,
  odataEnum,
  odataNumber,
  odataString,
  wildcard,
} from './odata-filter.util';

/**
 * These functions are the seam where user- and LLM-authored text becomes a D365
 * `$filter`. Every case here is a 400, a full-table scan, or an injection waiting
 * to happen if the escaping/validation regresses — see the file's own header.
 */
describe('odata-filter.util', () => {
  describe('odataString', () => {
    it('quotes a plain value', () => {
      expect(odataString('abc')).toBe("'abc'");
    });

    it("doubles a single quote so a value can't break out of the literal", () => {
      expect(odataString("O'Brien")).toBe("'O''Brien'");
      expect(odataString("' or 1 eq 1 or '")).toBe("''' or 1 eq 1 or '''");
    });
  });

  describe('odataNumber', () => {
    it('accepts a finite number', () => {
      expect(odataNumber(42)).toBe('42');
      expect(odataNumber(-3.5)).toBe('-3.5');
    });

    it('coerces a numeric string', () => {
      expect(odataNumber('7')).toBe('7');
    });

    it('rejects anything that is not a finite number', () => {
      expect(() => odataNumber('abc')).toThrow(/finite/);
      expect(() => odataNumber(Infinity)).toThrow(/finite/);
      expect(() => odataNumber(NaN)).toThrow(/finite/);
    });
  });

  describe('odataDate', () => {
    it('emits an unquoted ISO instant with no milliseconds', () => {
      expect(odataDate('2020-06-01')).toBe('2020-06-01T00:00:00Z');
    });

    it('accepts a Date', () => {
      expect(odataDate(new Date('2020-06-01T12:30:00Z'))).toBe('2020-06-01T12:30:00Z');
    });

    it('rejects an invalid date', () => {
      expect(() => odataDate('not-a-date')).toThrow(/valid date/);
    });
  });

  describe('odataEnum', () => {
    it('qualifies the member with the D365 namespace', () => {
      expect(odataEnum('SalesStatus', 'Backorder')).toBe(
        `${D365_ENUM_NS}.SalesStatus'Backorder'`,
      );
    });

    it('accepts a known member when members are supplied', () => {
      expect(odataEnum('SalesStatus', 'Backorder', ['Backorder', 'Delivered'])).toBe(
        `${D365_ENUM_NS}.SalesStatus'Backorder'`,
      );
    });

    it('rejects a hallucinated member before it reaches D365', () => {
      expect(() => odataEnum('SalesStatus', 'Imaginary', ['Backorder', 'Delivered'])).toThrow(
        /not a member/,
      );
    });
  });

  describe('wildcard', () => {
    it('builds a prefix seek', () => {
      expect(wildcard('2020', 'prefix')).toBe("'2020*'");
    });

    it('builds a contains scan', () => {
      expect(wildcard('abc', 'contains')).toBe("'*abc*'");
    });

    it('builds an exact match', () => {
      expect(wildcard('abc', 'exact')).toBe("'abc'");
    });

    it("strips any '*' or ' the user typed so they can't inject wildcards or break the literal", () => {
      expect(wildcard("a*b'c", 'prefix')).toBe("'abc*'");
    });
  });

  describe('buildSearchFilter', () => {
    const fields = [
      { field: 'SalesId', mode: 'prefix' as const },
      { field: 'ItemId', mode: 'prefix' as const },
    ];

    it('ORs a wildcard match across the fields, parenthesised', () => {
      expect(buildSearchFilter('SO1', fields)).toBe(
        "(SalesId eq 'SO1*' or ItemId eq 'SO1*')",
      );
    });

    it('does not parenthesise a single field', () => {
      expect(buildSearchFilter('SO1', [fields[0]])).toBe("SalesId eq 'SO1*'");
    });

    it('returns null for a term below the minimum length — a 1-char scan of 11M rows is useless', () => {
      expect(buildSearchFilter('a', fields)).toBeNull();
    });

    it('returns null when there are no fields', () => {
      expect(buildSearchFilter('abc', [])).toBeNull();
    });

    it('counts length after stripping wildcards', () => {
      // '*' and "'" are stripped, leaving one real character → below minLength.
      expect(buildSearchFilter("*'", fields)).toBeNull();
    });
  });

  describe('and', () => {
    it('joins the clauses that are present', () => {
      expect(and('a eq 1', 'b eq 2')).toBe('a eq 1 and b eq 2');
    });

    it('drops null/undefined/blank clauses', () => {
      expect(and('a eq 1', null, undefined, '   ')).toBe('a eq 1');
    });

    it('returns undefined when nothing is present', () => {
      expect(and(null, undefined)).toBeUndefined();
    });
  });

  describe('dateRange', () => {
    it('builds a half-open range', () => {
      expect(dateRange('TransDate', '2020-01-01', '2021-01-01')).toBe(
        'TransDate ge 2020-01-01T00:00:00Z and TransDate lt 2021-01-01T00:00:00Z',
      );
    });

    it('allows an open-ended lower bound', () => {
      expect(dateRange('TransDate', '2020-01-01')).toBe('TransDate ge 2020-01-01T00:00:00Z');
    });

    it('allows an open-ended upper bound', () => {
      expect(dateRange('TransDate', undefined, '2021-01-01')).toBe(
        'TransDate lt 2021-01-01T00:00:00Z',
      );
    });

    it('returns null when neither bound is given', () => {
      expect(dateRange('TransDate')).toBeNull();
    });
  });
});
