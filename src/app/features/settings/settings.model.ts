import { Injectable, computed, inject, signal } from '@angular/core';
import { BrandingService } from '../../core/branding/branding.service';
import { ThemeService } from '../../core/theme/theme.service';

export interface BrandPreset {
  name: string;
  primary: string;
  accent: string;
}

/** Curated brand colour pairings for one-click theming. */
const PRESETS: BrandPreset[] = [
  { name: 'Navy & Orange', primary: '#002559', accent: '#f24c1a' },
  { name: 'Indigo & Pink', primary: '#4f46e5', accent: '#ec4899' },
  { name: 'Emerald & Amber', primary: '#047857', accent: '#f59e0b' },
  { name: 'Slate & Sky', primary: '#0f172a', accent: '#0ea5e9' },
  { name: 'Violet & Rose', primary: '#6d28d9', accent: '#f43f5e' },
  { name: 'Teal & Coral', primary: '#0f766e', accent: '#fb7185' },
];

/** Max logo size we'll store in localStorage as a data URL. */
const MAX_LOGO_BYTES = 512 * 1024;

/** ViewModel for the Settings screen — delegates to the branding/theme services. */
@Injectable()
export class SettingsModel {
  private readonly branding = inject(BrandingService);
  private readonly theme = inject(ThemeService);

  readonly appName = this.branding.appName;
  readonly primary = this.branding.primary;
  readonly accent = this.branding.accent;
  readonly logo = this.branding.logo;
  readonly isDefault = this.branding.isDefault;
  readonly isDark = computed(() => this.theme.theme() === 'dark');

  readonly presets = PRESETS;

  private readonly _logoError = signal<string | null>(null);
  readonly logoError = this._logoError.asReadonly();

  setAppName(name: string): void {
    this.branding.setAppName(name);
  }

  setPrimary(hex: string): void {
    this.branding.setPrimary(hex);
  }

  setAccent(hex: string): void {
    this.branding.setAccent(hex);
  }

  applyPreset(preset: BrandPreset): void {
    this.branding.applyPreset(preset.primary, preset.accent);
  }

  isActivePreset(preset: BrandPreset): boolean {
    return this.primary() === preset.primary && this.accent() === preset.accent;
  }

  removeLogo(): void {
    this._logoError.set(null);
    this.branding.setLogo(null);
  }

  reset(): void {
    this._logoError.set(null);
    this.branding.reset();
  }

  setDark(dark: boolean): void {
    if (dark !== this.isDark()) this.theme.toggle();
  }

  /** Read an image file and store it as the logo (validated). */
  uploadLogo(file: File | undefined): void {
    this._logoError.set(null);
    if (!file) return;
    if (!file.type.startsWith('image/')) {
      this._logoError.set('Please choose an image file (PNG, JPG or SVG).');
      return;
    }
    if (file.size > MAX_LOGO_BYTES) {
      this._logoError.set('Image is too large — please use one under 512 KB.');
      return;
    }
    const reader = new FileReader();
    reader.onload = () => this.branding.setLogo(String(reader.result));
    reader.onerror = () => this._logoError.set('Could not read that file. Try another.');
    reader.readAsDataURL(file);
  }
}
