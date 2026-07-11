import { Injectable } from '@angular/core';
import { FieldMeta } from '../models/field-meta.model';

type Row = Record<string, unknown>;

/** Compact, privacy-preserving snapshot of a dataset sent to the LLM as context. */
export interface DataContext {
  rowCount: number;
  schema: { name: string; label: string; type: string }[];
  summary: Record<string, unknown>;
  sample: Row[];
}

/**
 * Builds the aggregated summary + schema the LLM reasons over. Only aggregates
 * and a few sample rows leave the browser — never the full dataset — so the
 * model designs reports while exact figures are computed locally.
 */
@Injectable({ providedIn: 'root' })
export class DataContextService {
  build(rows: readonly Row[], fields: FieldMeta[]): DataContext {
    const numericFields = fields.filter((f) => f.type === 'number');
    const stringFields = fields.filter((f) => f.type === 'string');

    const summary: Record<string, unknown> = { rowCount: rows.length };

    // Sum every numeric field.
    for (const f of numericFields) {
      summary[`sum_${f.key}`] = round(
        rows.reduce((total, r) => total + toNumber(r[f.key]), 0),
      );
    }

    // Distinct counts + top values for string fields.
    for (const f of stringFields) {
      const counts = new Map<string, number>();
      for (const r of rows) {
        const key = String(r[f.key] ?? '').trim();
        if (key) counts.set(key, (counts.get(key) ?? 0) + 1);
      }
      summary[`distinct_${f.key}`] = counts.size;
      const top = [...counts.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([value, count]) => ({ value, count }));
      if (top.length) summary[`top_${f.key}`] = top;
    }

    return {
      rowCount: rows.length,
      schema: fields.map((f) => ({ name: f.key, label: f.label, type: f.type })),
      summary,
      sample: rows.slice(0, 5).map((r) => project(r, fields)),
    };
  }
}

function project(row: Row, fields: FieldMeta[]): Row {
  const out: Row = {};
  for (const f of fields) out[f.key] = row[f.key];
  return out;
}

function toNumber(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}
