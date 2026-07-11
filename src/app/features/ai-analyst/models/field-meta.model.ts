export type FieldType = 'string' | 'number' | 'date';
export type ValueFormat = 'integer' | 'quantity' | 'currency' | 'date' | 'text';

/** Describes one queryable field so the engine can format and the LLM can reason about it. */
export interface FieldMeta {
  key: string;
  label: string;
  type: FieldType;
  format?: ValueFormat;
}
