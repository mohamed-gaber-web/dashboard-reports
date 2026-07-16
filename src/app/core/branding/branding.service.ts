import { Injectable, computed, signal } from '@angular/core';
import { buildScale, chartHue, lighten, darken, isValidHex } from '../../shared/utils/color.util';

/** User-configurable branding. */
export interface Branding {
  appName: string;
  primary: string; // hex, treated as the brand-600 base
  accent: string; // hex
  logo: string | null; // data URL, or null for the built-in mark
}

export const DEFAULT_BRANDING: Branding = {
  appName: 'Reports',
  primary: '#002559',
  accent: '#f24c1a',
  logo: null,
};

const STORAGE_KEY = 'rd.branding';

function normalizeHex(hex: string): string {
  const v = hex.trim().replace(/^#?/, '#');
  return v.toLowerCase();
}

/**
 * Owns the app's branding (name, logo, colours) and applies it live by
 * overriding the theme's CSS variables on <html>. Because Tailwind v4 tokens
 * are CSS variables, overriding `--color-brand-*` / `--color-accent-*`
 * re-themes every component instantly. Persists to localStorage.
 */
@Injectable({ providedIn: 'root' })
export class BrandingService {
  private readonly _branding = signal<Branding>(this.load());

  readonly branding = this._branding.asReadonly();
  readonly appName = computed(() => this._branding().appName);
  readonly primary = computed(() => this._branding().primary);
  readonly accent = computed(() => this._branding().accent);
  readonly logo = computed(() => this._branding().logo);

  readonly isDefault = computed(() => {
    const b = this._branding();
    return (
      b.appName === DEFAULT_BRANDING.appName &&
      b.primary === DEFAULT_BRANDING.primary &&
      b.accent === DEFAULT_BRANDING.accent &&
      !b.logo
    );
  });

  constructor() {
    // Apply synchronously during bootstrap so custom themes show without a flash.
    this.applyToDom(this._branding());
  }

  setAppName(name: string): void {
    this.update({ appName: name.trim() || DEFAULT_BRANDING.appName });
  }

  setPrimary(hex: string): void {
    if (isValidHex(hex)) this.update({ primary: normalizeHex(hex) });
  }

  setAccent(hex: string): void {
    if (isValidHex(hex)) this.update({ accent: normalizeHex(hex) });
  }

  setLogo(dataUrl: string | null): void {
    this.update({ logo: dataUrl });
  }

  applyPreset(primary: string, accent: string): void {
    this.update({ primary: normalizeHex(primary), accent: normalizeHex(accent) });
  }

  reset(): void {
    this._branding.set({ ...DEFAULT_BRANDING });
    this.persist();
    this.applyToDom(this._branding());
  }

  private update(patch: Partial<Branding>): void {
    this._branding.update((b) => ({ ...b, ...patch }));
    this.persist();
    this.applyToDom(this._branding());
  }

  private applyToDom(b: Branding): void {
    const root = document.documentElement.style;
    for (const [step, value] of Object.entries(buildScale(b.primary))) {
      root.setProperty(`--color-brand-${step}`, value);
    }
    root.setProperty('--color-accent-400', lighten(b.accent, 0.18));
    root.setProperty('--color-accent-500', b.accent);
    root.setProperty('--color-accent-600', darken(b.accent, 0.15));
    // Keep charts in sync with the brand identity — but as a chart mark, not as
    // the raw brand colour. `chartHue` keeps the hue and only corrects lightness
    // and saturation when the colour would otherwise be unusable as a fill; the
    // default navy is dark enough to disappear into the dark canvas untouched.
    root.setProperty('--color-chart-1', chartHue(b.primary));
    root.setProperty('--color-chart-2', chartHue(b.accent));
  }

  private persist(): void {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(this._branding()));
  }

  private load(): Branding {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) return { ...DEFAULT_BRANDING, ...(JSON.parse(raw) as Partial<Branding>) };
    } catch {
      // Corrupt storage — fall back to defaults.
    }
    return { ...DEFAULT_BRANDING };
  }
}
