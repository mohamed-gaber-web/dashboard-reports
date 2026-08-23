import { ChangeDetectionStrategy, Component, computed, inject, output } from '@angular/core';
import { NavigationEnd, Router, RouterLink } from '@angular/router';
import { toSignal } from '@angular/core/rxjs-interop';
import { filter, map } from 'rxjs';
import { ThemeService } from '../../core/theme/theme.service';
import { AuthService } from '../../core/auth/auth.service';
import { ReportRegistryService } from '../../core/reporting/report-registry.service';
import { IconComponent } from '../../shared/ui/icon/icon';

const ICON = {
  menu: 'M4 6h16M4 12h16M4 18h16',
  sun: 'M12 3v2m0 14v2M5.6 5.6l1.4 1.4m10 10 1.4 1.4M3 12h2m14 0h2M5.6 18.4l1.4-1.4m10-10 1.4-1.4M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8z',
  moon: 'M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z',
  chevron: 'm9 6 6 6-6 6',
  settings:
    'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z',
} as const;

/** Where a route sits in the nav tree — drives the topbar breadcrumb. */
interface Crumb {
  readonly section: string | null;
  readonly title: string;
}

/** Routes that are not report modules, so the registry cannot name them. */
const STATIC_CRUMBS: Record<string, Crumb> = {
  '/dashboard': { section: null, title: 'Overview' },
  '/ai/analyst': { section: 'AI Analyst', title: 'Generative reports' },
  '/settings': { section: null, title: 'Settings' },
};

/**
 * Top bar: breadcrumb, connection status, settings and theme toggle.
 *
 * It used to be an empty navy slab — three icons pushed right by `ml-auto`,
 * with 80% of the heaviest element on screen carrying nothing. It is now light
 * chrome (the sidebar keeps the brand) and it states where you are.
 */
@Component({
  selector: 'app-topbar',
  imports: [RouterLink, IconComponent],
  templateUrl: './topbar.html',
  styleUrl: './topbar.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class TopbarComponent {
  private readonly theme = inject(ThemeService);
  private readonly auth = inject(AuthService);
  private readonly router = inject(Router);
  private readonly registry = inject(ReportRegistryService);

  protected readonly icon = ICON;
  protected readonly isDark = computed(() => this.theme.theme() === 'dark');
  protected readonly connected = this.auth.ready;

  readonly menu = output<void>();

  /** Current URL, without query string or fragment. */
  private readonly url = toSignal(
    this.router.events.pipe(
      filter((e): e is NavigationEnd => e instanceof NavigationEnd),
      map((e) => e.urlAfterRedirects.split(/[?#]/)[0]),
    ),
    { initialValue: this.router.url.split(/[?#]/)[0] },
  );

  /**
   * Resolve the URL to a section + page name. Report modules come from the
   * registry, so a new module gets a correct breadcrumb with no edit here.
   */
  protected readonly crumb = computed<Crumb>(() => {
    const url = this.url();
    const path = url.startsWith('/') ? url.slice(1) : url;

    for (const group of this.registry.groups()) {
      const child = group.children.find((c) => c.route === path);
      if (child) return { section: group.title, title: child.title };
    }

    return STATIC_CRUMBS[url] ?? { section: null, title: 'Reports' };
  });

  protected toggleTheme(): void {
    this.theme.toggle();
  }
}
