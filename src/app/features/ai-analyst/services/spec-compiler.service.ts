import { Injectable } from '@angular/core';
import {
  ODataOp,
  odataDate,
  odataEnum,
  odataNumber,
  odataString,
  wildcard,
} from '../../../core/http/odata-filter.util';
import { FieldMeta } from '../models/field-meta.model';
import { FilterSpec } from '../models/report-spec.model';

/** A spec clause we refused to compile, and why. Surfaced to the user, never dropped. */
export interface RejectedFilter {
  filter: FilterSpec;
  reason: string;
}

export interface CompiledFilters {
  /** The `$filter` fragment, or null if nothing compiled. */
  filter: string | null;
  rejected: RejectedFilter[];
}

/**
 * Compiles the LLM's {@link FilterSpec}s into a D365 `$filter`.
 *
 * This is the seam where model output becomes a query, so it is also the seam
 * where model output gets **validated**. The rules are not stylistic — each one
 * is a 400 (or a silently wrong result) waiting to happen:
 *
 * - The spec's operator names are NOT OData's. `neq`/`gte`/`lte` must become
 *   `ne`/`ge`/`le`.
 * - `contains` is not a function in D365. It is a wildcard on equality:
 *   `Field eq '*term*'`.
 * - Enums are not strings. `Sha_SerialTransType eq 'Sales'` is a 400; it needs a
 *   qualified literal, and only `eq`/`ne` are legal.
 * - A field the model invented, or an enum member it hallucinated, is rejected
 *   here — with a reason we can show — rather than sent to D365 to fail opaquely.
 *
 * Values are escaped, never concatenated raw. Nothing the model emits is
 * executed; it only ever *selects* from a fixed vocabulary of fields and ops.
 */
@Injectable({ providedIn: 'root' })
export class SpecCompilerService {
  /** Spec operator -> OData operator. `contains` is handled separately (it's a wildcard). */
  private static readonly OPS: Record<string, ODataOp> = {
    eq: 'eq',
    neq: 'ne',
    gt: 'gt',
    lt: 'lt',
    gte: 'ge',
    lte: 'le',
  };

  compile(filters: readonly FilterSpec[] | undefined, fields: FieldMeta[]): CompiledFilters {
    const byKey = new Map(fields.map((f) => [f.key, f]));
    const clauses: string[] = [];
    const rejected: RejectedFilter[] = [];

    for (const f of filters ?? []) {
      const meta = byKey.get(f.field);
      if (!meta) {
        rejected.push({ filter: f, reason: `Unknown field “${f.field}”.` });
        continue;
      }
      try {
        clauses.push(this.clause(f, meta));
      } catch (e) {
        rejected.push({ filter: f, reason: e instanceof Error ? e.message : String(e) });
      }
    }

    return {
      filter: clauses.length ? clauses.join(' and ') : null,
      rejected,
    };
  }

  private clause(f: FilterSpec, meta: FieldMeta): string {
    if (meta.type === 'enum') {
      if (f.op !== 'eq' && f.op !== 'neq') {
        throw new Error(`${meta.label} is an enum — only “is” / “is not” are supported.`);
      }
      const literal = odataEnum(meta.enumType!, String(f.value), meta.enumMembers);
      return `${f.field} ${f.op === 'eq' ? 'eq' : 'ne'} ${literal}`;
    }

    if (f.op === 'contains') {
      if (meta.type !== 'string') {
        throw new Error(`“contains” only applies to text fields, and ${meta.label} is not one.`);
      }
      // D365 has no contains() function — it is a wildcard on eq.
      return `${f.field} eq ${wildcard(String(f.value), 'contains')}`;
    }

    const op = SpecCompilerService.OPS[f.op];
    if (!op) throw new Error(`Unsupported operator “${f.op}”.`);

    if (meta.type === 'number') return `${f.field} ${op} ${odataNumber(f.value)}`;
    if (meta.type === 'date') return `${f.field} ${op} ${odataDate(String(f.value))}`;
    return `${f.field} ${op} ${odataString(String(f.value))}`;
  }
}
