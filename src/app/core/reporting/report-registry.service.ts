import { Injectable, signal, computed } from '@angular/core';
import { ReportGroup, ReportModuleDefinition } from './report-module.model';
import { REPORT_GROUPS } from './report-modules';

/**
 * Single source of truth for the navigation structure. The shell sidebar reads
 * the grouped view; the dashboard reads the flattened module list. Neither
 * depends on any feature.
 */
@Injectable({ providedIn: 'root' })
export class ReportRegistryService {
  private readonly _groups = signal<ReportGroup[]>(REPORT_GROUPS);

  /** Navigation groups (parents with their child report modules). */
  readonly groups = this._groups.asReadonly();

  /** All report modules across every group, flattened. */
  readonly modules = computed<ReportModuleDefinition[]>(() =>
    this._groups().flatMap((group) => group.children),
  );

  /** How many report screens are available. */
  readonly count = computed(() => this.modules().length);

  /** Look up a module by its id. */
  byId(id: string): ReportModuleDefinition | undefined {
    return this.modules().find((m) => m.id === id);
  }
}
