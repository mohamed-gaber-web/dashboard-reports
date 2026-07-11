import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { RouterLink } from '@angular/router';
import { KpiCardComponent } from '../../shared/ui/kpi-card/kpi-card';
import { IconComponent } from '../../shared/ui/icon/icon';
import { ICONS } from '../../core/reporting/report-modules';
import { DashboardModel } from './dashboard.model';

/** Landing overview: gradient hero, headline numbers, and a card per report module. */
@Component({
  selector: 'app-dashboard',
  imports: [RouterLink, KpiCardComponent, IconComponent],
  templateUrl: './dashboard.html',
  styleUrl: './dashboard.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
  providers: [DashboardModel],
})
export class DashboardComponent {
  protected readonly model = inject(DashboardModel);
  protected readonly icons = {
    modules: ICONS.dashboard,
    lines: 'M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01',
    units: 'M20 7 12 3 4 7m16 0-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4',
    arrow: 'M5 12h14m-6-6 6 6-6 6',
  };
}
