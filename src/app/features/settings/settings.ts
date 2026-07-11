import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { PageHeaderComponent } from '../../shared/ui/page-header/page-header';
import { IconComponent } from '../../shared/ui/icon/icon';
import { StatusBadgeComponent } from '../../shared/ui/status-badge/status-badge';
import { SettingsModel } from './settings.model';

/** Settings screen — branding (name, logo, colours) and appearance. */
@Component({
  selector: 'app-settings',
  imports: [PageHeaderComponent, IconComponent, StatusBadgeComponent],
  templateUrl: './settings.html',
  styleUrl: './settings.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
  providers: [SettingsModel],
})
export class SettingsComponent {
  protected readonly model = inject(SettingsModel);

  protected readonly icons = {
    reset: 'M3 12a9 9 0 1 0 9-9 9 9 0 0 0-6.36 2.64L3 8M3 3v5h5',
    upload: 'M12 16V4m0 0-4 4m4-4 4 4M4 16v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2',
    trash: 'M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m2 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6',
    sun: 'M12 3v2m0 14v2M5.6 5.6l1.4 1.4m10 10 1.4 1.4M3 12h2m14 0h2M5.6 18.4l1.4-1.4m10-10 1.4-1.4M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8z',
    moon: 'M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z',
    check: 'M20 6 9 17l-5-5',
    image: 'M3 5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5zm2 12 4-4 3 3 4-5 4 6',
  };

  protected onLogoSelected(event: Event): void {
    const input = event.target as HTMLInputElement;
    this.model.uploadLogo(input.files?.[0]);
    input.value = '';
  }
}
