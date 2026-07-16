import { SearchMode } from '../../../core/http/odata-filter.util';

export type FieldType = 'string' | 'number' | 'date' | 'enum';
export type ValueFormat = 'integer' | 'quantity' | 'currency' | 'date' | 'text';

/** Describes one queryable field so the engine can format and the LLM can reason about it. */
export interface FieldMeta {
  key: string;
  label: string;
  type: FieldType;
  format?: ValueFormat;

  /**
   * For `type: 'enum'` — the D365 enum type name and its members.
   *
   * Both are required to build a legal `$filter`: D365 rejects a plain string
   * comparison on an enum with a 400, and the literal must be qualified
   * (`Microsoft.Dynamics.DataEntities.<enumType>'<member>'`). Carrying the
   * members here also lets us reject a hallucinated value *before* it becomes an
   * opaque 400 from D365.
   */
  enumType?: string;
  enumMembers?: readonly string[];

  /**
   * How this field behaves in a search box. Omit for fields that shouldn't be
   * searched. `prefix` is an index seek; `contains` is a full table scan — at
   * 11M rows that is the difference between 300 ms and 13 s.
   */
  search?: SearchMode;

  /**
   * True when this field can be totalled. Only numeric measures qualify — a
   * record id is numeric but summing it is meaningless.
   */
  measure?: boolean;

  /** True when this field is a sensible group-by dimension (low-to-mid cardinality). */
  dimension?: boolean;
}
