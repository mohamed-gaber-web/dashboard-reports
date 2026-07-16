import { D365_ENUM_NS } from '../../../core/http/odata-filter.util';
import { FieldMeta } from '../models/field-meta.model';
import { FilterSpec } from '../models/report-spec.model';
import { SpecCompilerService } from './spec-compiler.service';

/**
 * The compiler is where LLM output becomes a query — and therefore where it is
 * validated. Each case here is a clause D365 would reject with an opaque 400, or
 * accept and silently mis-answer, if the compiler let it through.
 */
describe('SpecCompilerService', () => {
  const compiler = new SpecCompilerService();

  const fields: FieldMeta[] = [
    { key: 'ItemId', label: 'Item', type: 'string' },
    { key: 'Qty', label: 'Quantity', type: 'number' },
    { key: 'TransDate', label: 'Transaction date', type: 'date' },
    {
      key: 'Sha_SerialTransType',
      label: 'Transaction type',
      type: 'enum',
      enumType: 'Sha_SerialTransType',
      enumMembers: ['Sales', 'Purchase'],
    },
  ];

  const compile = (filter: FilterSpec) => compiler.compile([filter], fields);

  describe('operator mapping (spec names are NOT OData names)', () => {
    it('maps neq → ne', () => {
      expect(compile({ field: 'Qty', op: 'neq', value: 5 }).filter).toBe('Qty ne 5');
    });

    it('maps gte → ge and lte → le', () => {
      expect(compile({ field: 'Qty', op: 'gte', value: 1 }).filter).toBe('Qty ge 1');
      expect(compile({ field: 'Qty', op: 'lte', value: 9 }).filter).toBe('Qty le 9');
    });

    it('passes eq/gt/lt through unchanged', () => {
      expect(compile({ field: 'Qty', op: 'gt', value: 0 }).filter).toBe('Qty gt 0');
    });
  });

  describe('typed literals', () => {
    it('quotes and escapes a string value', () => {
      expect(compile({ field: 'ItemId', op: 'eq', value: "O'B" }).filter).toBe(
        "ItemId eq 'O''B'",
      );
    });

    it('emits a bare numeric literal', () => {
      expect(compile({ field: 'Qty', op: 'eq', value: 12.5 }).filter).toBe('Qty eq 12.5');
    });

    it('emits an unquoted date instant', () => {
      expect(compile({ field: 'TransDate', op: 'gte', value: '2020-01-01' }).filter).toBe(
        'TransDate ge 2020-01-01T00:00:00Z',
      );
    });
  });

  describe('contains (D365 has no contains() function)', () => {
    it('compiles to a wildcard on equality for a text field', () => {
      expect(compile({ field: 'ItemId', op: 'contains', value: 'ABC' }).filter).toBe(
        "ItemId eq '*ABC*'",
      );
    });

    it('rejects contains on a non-text field, with a reason', () => {
      const { filter, rejected } = compile({ field: 'Qty', op: 'contains', value: 5 });
      expect(filter).toBeNull();
      expect(rejected).toHaveLength(1);
      expect(rejected[0].reason).toMatch(/contains/i);
    });
  });

  describe('enums', () => {
    it('builds a qualified enum literal for eq', () => {
      expect(compile({ field: 'Sha_SerialTransType', op: 'eq', value: 'Sales' }).filter).toBe(
        `Sha_SerialTransType eq ${D365_ENUM_NS}.Sha_SerialTransType'Sales'`,
      );
    });

    it('supports ne on an enum', () => {
      expect(compile({ field: 'Sha_SerialTransType', op: 'neq', value: 'Sales' }).filter).toBe(
        `Sha_SerialTransType ne ${D365_ENUM_NS}.Sha_SerialTransType'Sales'`,
      );
    });

    it('rejects an ordering operator on an enum', () => {
      const { filter, rejected } = compile({
        field: 'Sha_SerialTransType',
        op: 'gt',
        value: 'Sales',
      });
      expect(filter).toBeNull();
      expect(rejected[0].reason).toMatch(/enum/i);
    });

    it('rejects a hallucinated enum member, with a reason', () => {
      const { filter, rejected } = compile({
        field: 'Sha_SerialTransType',
        op: 'eq',
        value: 'Imaginary',
      });
      expect(filter).toBeNull();
      expect(rejected[0].reason).toMatch(/not a member/);
    });
  });

  describe('unknown fields', () => {
    it('rejects a field the model invented rather than sending it to D365', () => {
      const { filter, rejected } = compile({ field: 'Nope', op: 'eq', value: 1 });
      expect(filter).toBeNull();
      expect(rejected[0].reason).toMatch(/Unknown field/);
    });
  });

  describe('combining clauses', () => {
    it('ANDs the compiled clauses and keeps the rejected ones separate', () => {
      const { filter, rejected } = compiler.compile(
        [
          { field: 'Qty', op: 'gt', value: 0 },
          { field: 'Ghost', op: 'eq', value: 1 },
          { field: 'ItemId', op: 'eq', value: 'X' },
        ],
        fields,
      );
      expect(filter).toBe("Qty gt 0 and ItemId eq 'X'");
      expect(rejected).toHaveLength(1);
      expect(rejected[0].filter.field).toBe('Ghost');
    });

    it('returns null filter and no rejects for an empty/undefined spec', () => {
      expect(compiler.compile(undefined, fields)).toEqual({ filter: null, rejected: [] });
      expect(compiler.compile([], fields)).toEqual({ filter: null, rejected: [] });
    });
  });
});
