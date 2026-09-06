import { ChangeDetectionStrategy, Component, computed, input, signal } from '@angular/core';
import {
  AiDataContext,
  ModuleField,
  ModuleFilter,
} from '../../../ai-analyst/models/module-context.model';
import { ModuleContextPhase } from '../../../ai-analyst/services/module-context.service';

/**
 * Renders the module context the AI layer will be given.
 *
 * ## Why this exists
 *
 * The context is the app's answer to "what may be asked of this module", and
 * every later step — prompt, plan, report — is only as good as it is. Until
 * something consumes it, a wrong role or a missing filter is invisible: the
 * build passes, the screen looks fine, and the mistake surfaces much later as a
 * model proposing a total over a field that cannot be summed. This makes it
 * visible now, against the live registry, in one place.
 *
 * ## Why it is dev-only
 *
 * It shows the shape of an internal contract, not anything a user asked for.
 * The page mounts it behind `!environment.production`, so it is absent from a
 * production build rather than merely hidden by CSS.
 *
 * Presentational: it binds to two inputs and shapes them for display. No
 * service, no state beyond which sections are expanded.
 */
@Component({
  selector: 'app-module-context-debug',
  templateUrl: './module-context-debug.html',
  styleUrl: './module-context-debug.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ModuleContextDebugComponent {
  readonly phase = input.required<ModuleContextPhase | null>();
  /** The wire payload, so the redaction can be eyeballed rather than trusted. */
  readonly ai = input.required<AiDataContext | null>();

  protected readonly open = signal(false);
  protected readonly showJson = signal(false);

  protected readonly icons = {
    chevron: 'm6 9 6 6 6-6',
    spark: 'M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9L12 3z',
  };

  /** Null until the first load starts, which is a third state from loading. */
  protected readonly started = computed(() => this.phase() !== null);

  protected readonly loading = computed(() => this.phase()?.phase === 'loading');

  protected readonly error = computed(() => {
    const phase = this.phase();
    return phase?.phase === 'error' ? phase : null;
  });

  protected readonly warning = computed(() => {
    const phase = this.phase();
    return phase?.phase === 'ready' ? (phase.warning ?? null) : null;
  });

  protected readonly context = computed(() => {
    const phase = this.phase();
    return phase && phase.phase !== 'error' ? phase.context : null;
  });

  protected readonly dateRange = computed(() => {
    const phase = this.phase();
    return phase?.phase === 'ready' ? (phase.dateRange ?? null) : null;
  });

  /** Measures first, then dimensions, then attributes — the order they matter in. */
  protected readonly fields = computed<readonly ModuleField[]>(() => {
    const order = { measure: 0, dimension: 1, attribute: 2 } as const;
    return [...(this.context()?.fields ?? [])].sort(
      (a, b) => order[a.role] - order[b.role] || a.name.localeCompare(b.name),
    );
  });

  /** Only the two module-level filters. The per-field ones are in the table. */
  protected readonly slicers = computed<readonly ModuleFilter[]>(() =>
    (this.context()?.filters ?? []).filter((f) => f.kind !== 'field'),
  );

  protected readonly fieldFilterCount = computed(
    () => (this.context()?.filters ?? []).filter((f) => f.kind === 'field').length,
  );

  protected readonly capabilities = computed(() => {
    const caps = this.context()?.capabilities;
    if (!caps) return [];
    return [
      { label: 'count', on: caps.count },
      { label: 'aggregate', on: caps.aggregate },
      { label: 'date bounds', on: caps.dateBounds },
      { label: 'search', on: caps.search },
      { label: 'paging', on: caps.paging },
      { label: 'join', on: caps.join },
    ];
  });

  protected readonly availability = computed(() => this.ai()?.data ?? null);

  protected readonly json = computed(() => JSON.stringify(this.ai(), null, 2));

  /** A search filter names its fields; a date filter names its one field. */
  protected slicerDetail(filter: ModuleFilter): string {
    if (filter.kind === 'dateRange') return `${filter.field} · end bound ${filter.endBound}`;
    if (filter.kind === 'search') {
      return filter.fields.map((f) => `${f.field} (${f.mode})`).join(', ');
    }
    return filter.field;
  }

  protected toggle(): void {
    this.open.update((v) => !v);
  }

  protected toggleJson(): void {
    this.showJson.update((v) => !v);
  }
}
