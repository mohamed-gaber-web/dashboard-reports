import { Injectable, inject } from '@angular/core';
import { Observable, catchError, concat, map, of, shareReplay } from 'rxjs';
import { SourceOption } from '../../../shared/models/source-option.model';
import { ANALYST_SOURCES } from '../analyst-sources';
import { AnalystSource } from '../models/analyst-source.model';
import {
  AiDataContext,
  ModuleContext,
  ModuleDataAvailability,
} from '../models/module-context.model';
import { AnalystDataService } from './analyst-data.service';
import { moduleContextFor, toAiDataContext } from './module-context.adapter';

/** Why a module could not be described. Both cases mean there is nothing to show. */
export type ModuleContextError = 'unknown-module' | 'no-metadata';

/**
 * Where describing a module has got to.
 *
 * A phase union rather than a `loading`/`loaded`/`error` triple of booleans, for
 * the reason `ContextPhase` is one in `report-context.service.ts`: three
 * booleans have eight states, five of which are nonsense, and the UI ends up
 * checking them in an order that happens to work.
 *
 * `loading` already carries the context, because METADATA needs no I/O — only
 * the date bounds do. So a screen can render the field list immediately and fill
 * the data range in when it lands, instead of showing a spinner over information
 * it already has.
 *
 * `ready` is terminal.
 */
export type ModuleContextPhase =
  | { phase: 'loading'; context: ModuleContext }
  | {
      phase: 'ready';
      context: ModuleContext;
      /** Earliest/latest value of the module's date field, when it has one. */
      dateRange?: { field: string; min?: string; max?: string };
      /**
       * Set when part of the description could not be read but the rest is
       * sound — today, only a failed date-bounds request.
       *
       * Deliberately not an error: the field list, the roles, the filters and
       * the capabilities are all static registry data and are complete. Failing
       * the whole screen over a missing date range would withhold everything
       * that did work, so the shortfall is reported instead of hidden.
       */
      warning?: string;
    }
  | { phase: 'error'; reason: ModuleContextError; message: string };

/**
 * Describes the currently-selected module for the AI layer.
 *
 * ## What this owns, and what it deliberately does not
 *
 * It owns the answer to **"what is this module, and what may be asked of it?"**
 * — resolving an id against the shared registry, normalizing it through
 * `module-context.adapter.ts`, and reading the one fact that needs a round trip
 * (the module's date range).
 *
 * It does NOT own the figures. `DataContextService` builds those from a folded
 * slice, and duplicating any of it here would give the app two answers to "what
 * does this module total". The two compose: this says a report COULD group by
 * customer and sum `LineAmount`; that says what those numbers are.
 *
 * It also does not fetch rows, and is not a step towards doing so. The eventual
 * shape — question → decide what is needed → query that → send only that — is
 * served by `AnalystDataService` (count, gate, fold, page), which already
 * refuses a slice too large to total rather than silently summarising the first
 * few thousand rows. What this class adds is the vocabulary that lets a later
 * step decide *which* query to run.
 *
 * ## Why the metadata half costs nothing
 *
 * A module's fields, roles, filters and capabilities are static: they come from
 * `ANALYST_SOURCES`, which is a compile-time constant. So {@link describe} is
 * synchronous and always succeeds for a known id, and only {@link load} touches
 * the network — for a single two-row read, and not even that on a module with no
 * date field.
 */
@Injectable({ providedIn: 'root' })
export class ModuleContextService {
  private readonly data = inject(AnalystDataService);

  /** Normalized contexts, keyed by module id. Pure over a constant — cache freely. */
  private readonly contexts = new Map<string, ModuleContext>();

  /**
   * In-flight and completed loads, keyed by module id.
   *
   * `shareReplay` so switching away and back does not re-read the bounds, and so
   * two callers asking at once share one request rather than racing.
   */
  private readonly loads = new Map<string, Observable<ModuleContextPhase>>();

  /**
   * Every module the app can report on, as picker options.
   *
   * Mapped down to `SourceOption` on purpose: a dropdown has no business seeing
   * an OData entity, an auth config or a field schema.
   */
  readonly modules: readonly SourceOption[] = ANALYST_SOURCES.map((source) => ({
    id: source.id,
    label: source.label,
    ...(source.description ? { description: source.description } : {}),
  }));

  /**
   * The module's description, with no I/O. `null` for an id the registry does
   * not know — the caller decides whether that is an error or a fallback.
   */
  describe(moduleId: string): ModuleContext | null {
    const cached = this.contexts.get(moduleId);
    if (cached) return cached;

    const context = moduleContextFor(moduleId);
    if (context) this.contexts.set(moduleId, context);
    return context;
  }

  /**
   * The module's description plus the one fact that needs D365: how far back its
   * data goes.
   *
   * Emits `loading` immediately WITH the context, so a screen can paint the
   * field list before the request returns, then `ready`. An unknown id and a
   * module with no fields both short-circuit to `error` without a request —
   * there is nothing to look up bounds for.
   */
  load(moduleId: string): Observable<ModuleContextPhase> {
    const cached = this.loads.get(moduleId);
    if (cached) return cached;

    const built = this.build(moduleId).pipe(shareReplay({ bufferSize: 1, refCount: false }));
    this.loads.set(moduleId, built);
    return built;
  }

  /**
   * Drop what is cached so the next {@link load} re-reads.
   *
   * Only the bounds are dropped by default — the normalized context is derived
   * from a compile-time constant and cannot go stale within a session. Pass no
   * id to clear every module.
   */
  refresh(moduleId?: string): void {
    if (moduleId) this.loads.delete(moduleId);
    else this.loads.clear();
  }

  /**
   * The AI-facing payload for a context, optionally carrying what is currently
   * known about the data behind it.
   *
   * Routed through the service rather than having callers import the adapter, so
   * there is one documented way from "a module is selected" to "this is what the
   * model may be told" — and one place to change if that payload ever needs
   * narrowing further.
   */
  toAiContext(context: ModuleContext, availability?: ModuleDataAvailability): AiDataContext {
    return toAiDataContext(context, availability);
  }

  private build(moduleId: string): Observable<ModuleContextPhase> {
    const source = ANALYST_SOURCES.find((s) => s.id === moduleId);
    if (!source) {
      return of<ModuleContextPhase>({
        phase: 'error',
        reason: 'unknown-module',
        message: `“${moduleId}” is not a module this app can report on.`,
      });
    }

    const context = this.describe(moduleId);
    // Belt and braces: `describe` resolves against the same registry, so this
    // cannot be null here. Narrowing it explicitly beats a non-null assertion.
    if (!context) {
      return of<ModuleContextPhase>({
        phase: 'error',
        reason: 'unknown-module',
        message: `“${moduleId}” is not a module this app can report on.`,
      });
    }

    if (!context.fields.length) {
      // A registered module with no fields is a broken descriptor, not an empty
      // dataset — and the two need different messages, because only one of them
      // is fixed by changing the filter.
      return of<ModuleContextPhase>({
        phase: 'error',
        reason: 'no-metadata',
        message: `No field metadata is available for ${context.moduleName}.`,
      });
    }

    return concat(
      of<ModuleContextPhase>({ phase: 'loading', context }),
      this.dateRange(source).pipe(
        map(
          (result): ModuleContextPhase => ({
            phase: 'ready',
            context,
            ...(result.dateRange ? { dateRange: result.dateRange } : {}),
            ...(result.warning ? { warning: result.warning } : {}),
          }),
        ),
      ),
    );
  }

  /**
   * Earliest and latest value of the module's date field.
   *
   * Two one-row queries (`$orderby` + `$top=1`), which run in a few hundred
   * milliseconds even against 11M rows — and none at all when the module has no
   * date field, because `dateBounds` short-circuits on that.
   *
   * A failure is downgraded to a warning rather than propagated. Everything else
   * in the context is static and correct, and a screen that renders nothing
   * because one optional read failed is worse than one that renders the schema
   * and says the date range is unknown.
   */
  private dateRange(source: AnalystSource): Observable<{
    dateRange?: { field: string; min?: string; max?: string };
    warning?: string;
  }> {
    const field = source.dateField;
    if (!field) return of({});

    return this.data.dateBounds(source).pipe(
      map((bounds) => ({ dateRange: { field, min: bounds.min, max: bounds.max } })),
      catchError(() =>
        of({
          warning:
            `We couldn’t read the date range for ${source.label}. ` +
            `Everything else below is accurate.`,
        }),
      ),
    );
  }
}
