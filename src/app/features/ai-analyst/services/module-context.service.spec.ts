import { TestBed } from '@angular/core/testing';
import { Observable, of, throwError } from 'rxjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AnalystDataService, DateBounds } from './analyst-data.service';
import { ModuleContextPhase, ModuleContextService } from './module-context.service';

/**
 * The service adds three things to the pure adapter, and each is tested here:
 * the one round trip it makes, what it does when that round trip fails, and
 * that it does not make it twice.
 *
 * `AnalystDataService` is stubbed rather than mocked deeply — the point is to
 * control what `dateBounds` does, not to exercise HTTP.
 */

interface Stub {
  dateBounds: ReturnType<typeof vi.fn>;
}

function configure(dateBounds: Observable<DateBounds> = of({})): {
  service: ModuleContextService;
  stub: Stub;
} {
  const stub: Stub = { dateBounds: vi.fn(() => dateBounds) };

  TestBed.configureTestingModule({
    providers: [{ provide: AnalystDataService, useValue: stub }],
  });

  return { service: TestBed.inject(ModuleContextService), stub };
}

/** Collect every phase. The whole pipeline is synchronous under these stubs. */
function phases(service: ModuleContextService, moduleId: string): ModuleContextPhase[] {
  const seen: ModuleContextPhase[] = [];
  service.load(moduleId).subscribe((phase) => seen.push(phase));
  return seen;
}

describe('ModuleContextService', () => {
  beforeEach(() => TestBed.resetTestingModule());

  // ── Test 1 — Sales Orders ─────────────────────────────────────────────────

  it('describes Sales Orders with no I/O at all', () => {
    const { service, stub } = configure();

    const context = service.describe('sales-order');

    expect(context?.moduleId).toBe('sales-order');
    expect(context?.fields.length).toBeGreaterThan(0);
    // Metadata comes from a compile-time constant. Nothing should be fetched.
    expect(stub.dateBounds).not.toHaveBeenCalled();
  });

  it('emits the schema before the date range, not after it', () => {
    const { service } = configure(of({ min: '2024-01-05', max: '2025-11-30' }));

    const seen = phases(service, 'sales-order');

    expect(seen.map((p) => p.phase)).toEqual(['loading', 'ready']);
    // The loading phase already carries the context, so a screen can paint the
    // field list instead of spinning over information it already has.
    expect(seen[0].phase === 'loading' && seen[0].context.fields.length).toBeGreaterThan(0);
    expect(seen[1]).toMatchObject({
      phase: 'ready',
      dateRange: { min: '2024-01-05', max: '2025-11-30' },
    });
  });

  // ── Test 2 — Inventory ────────────────────────────────────────────────────

  it('describes Inventory without asking for a date range it has no field for', () => {
    const { service, stub } = configure();

    const seen = phases(service, 'inventory');
    const ready = seen.at(-1);

    expect(ready).toMatchObject({ phase: 'ready' });
    expect(ready?.phase === 'ready' && ready.dateRange).toBeUndefined();
    expect(ready?.phase === 'ready' && ready.context.moduleId).toBe('inventory');
    // Not merely "the request came back empty": the service never issues it,
    // because a module with no date field has no bounds to read. Inventory
    // describes itself with zero network traffic.
    expect(stub.dateBounds).not.toHaveBeenCalled();
  });

  // ── Test 3 — Unknown module ───────────────────────────────────────────────

  it('reports an unknown module instead of falling back to a default', () => {
    const { service, stub } = configure();

    expect(service.describe('returns')).toBeNull();

    const seen = phases(service, 'returns');
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ phase: 'error', reason: 'unknown-module' });
    expect(seen[0].phase === 'error' && seen[0].message).toContain('returns');
    // No point looking up bounds for a module that does not exist.
    expect(stub.dateBounds).not.toHaveBeenCalled();
  });

  // ── Test 4 — A failure that must not take the whole context down ──────────

  it('degrades a failed date-range read to a warning, keeping the schema', () => {
    const { service } = configure(throwError(() => new Error('D365 unreachable')));

    const ready = phases(service, 'sales-order').at(-1);

    // Everything except the date range is static and correct, so failing the
    // whole panel would withhold everything that did work.
    expect(ready).toMatchObject({ phase: 'ready' });
    expect(ready?.phase === 'ready' && ready.dateRange).toBeUndefined();
    expect(ready?.phase === 'ready' && ready.warning).toContain('date range');
    expect(ready?.phase === 'ready' && ready.context.fields.length).toBeGreaterThan(0);
  });

  // ── Test 5 — Module switching ─────────────────────────────────────────────

  it('gives the right context every time across a switch sequence', () => {
    const { service } = configure();

    for (const id of ['sales-order', 'inventory', 'transaction', 'sales-order']) {
      const ready = phases(service, id).at(-1);
      expect(ready?.phase).toBe('ready');
      expect(ready?.phase === 'ready' && ready.context.moduleId).toBe(id);
    }
  });

  it('reads the date range once per module, not once per switch', () => {
    const { service, stub } = configure();

    phases(service, 'sales-order');
    phases(service, 'transaction');
    phases(service, 'sales-order');
    phases(service, 'sales-order');

    // Two modules, two reads — switching back is served from the cache.
    expect(stub.dateBounds).toHaveBeenCalledTimes(2);
  });

  it('re-reads after a refresh', () => {
    const { service, stub } = configure();

    phases(service, 'sales-order');
    service.refresh('sales-order');
    phases(service, 'sales-order');

    expect(stub.dateBounds).toHaveBeenCalledTimes(2);
  });

  // ── The AI projection ─────────────────────────────────────────────────────

  it('hands out the AI payload, with availability only when supplied', () => {
    const { service } = configure();
    const context = service.describe('inventory')!;

    expect(service.toAiContext(context).data).toBeUndefined();

    const withData = service.toAiContext(context, {
      rowCount: 787,
      coverage: 'counts-only',
      totalsAvailable: false,
    });
    expect(withData.data).toMatchObject({ rowCount: 787, totalsAvailable: false });
    expect(withData.module.id).toBe('inventory');
  });

  it('lists every module as a picker option, and nothing more', () => {
    const { service } = configure();

    expect(service.modules.length).toBeGreaterThan(2);
    for (const option of service.modules) {
      // A dropdown has no business seeing an entity, a host or an auth config.
      expect(Object.keys(option).sort()).toEqual(
        option.description ? ['description', 'id', 'label'] : ['id', 'label'],
      );
    }
    expect(service.modules.some((m) => m.id === 'inventory')).toBe(true);
  });
});
