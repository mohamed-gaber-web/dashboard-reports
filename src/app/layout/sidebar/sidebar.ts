import { ChangeDetectionStrategy, Component, inject, output, signal } from '@angular/core';
import { RouterLink, RouterLinkActive } from '@angular/router';
import { ReportRegistryService } from '../../core/reporting/report-registry.service';
import { ICONS } from '../../core/reporting/report-modules';
import { BrandingService } from '../../core/branding/branding.service';
import { IconComponent } from '../../shared/ui/icon/icon';

/** Primary navigation: branding, the dashboard, collapsible report groups, settings. */
@Component({
  selector: 'app-sidebar',
  imports: [RouterLink, RouterLinkActive, IconComponent],
  templateUrl: './sidebar.html',
  styleUrl: './sidebar.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class SidebarComponent {
  private readonly registry = inject(ReportRegistryService);
  protected readonly branding = inject(BrandingService);

  protected readonly groups = this.registry.groups;
  protected readonly icons = ICONS;
  protected readonly aiIcon =
    'M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9L12 3z M5 3v4M3 5h4M19 17v4M17 19h4';
  protected readonly settingsIcon =
    'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z';

  /** Ids of expanded groups — every group starts open. */
  private readonly expanded = signal(new Set(this.registry.groups().map((g) => g.id)));

  /** Emitted when a nav item is chosen so the shell can close the mobile drawer. */
  readonly navigate = output<void>();

  protected isOpen(groupId: string): boolean {
    return this.expanded().has(groupId);
  }

  protected toggle(groupId: string): void {
    this.expanded.update((set) => {
      const next = new Set(set);
      next.has(groupId) ? next.delete(groupId) : next.add(groupId);
      return next;
    });
  }
}
