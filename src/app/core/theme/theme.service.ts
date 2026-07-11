import { Injectable, signal } from '@angular/core';

type Theme = 'light' | 'dark';

const STORAGE_KEY = 'rd.theme';

/**
 * Owns the light/dark theme. The initial class is applied by an inline script
 * in index.html to avoid a flash; this service keeps the signal in sync and
 * persists user choices.
 */
@Injectable({ providedIn: 'root' })
export class ThemeService {
  private readonly _theme = signal<Theme>(this.readInitial());
  readonly theme = this._theme.asReadonly();

  toggle(): void {
    this.apply(this._theme() === 'dark' ? 'light' : 'dark');
  }

  private apply(theme: Theme): void {
    this._theme.set(theme);
    document.documentElement.classList.toggle('dark', theme === 'dark');
    localStorage.setItem(STORAGE_KEY, theme);
  }

  private readInitial(): Theme {
    return document.documentElement.classList.contains('dark') ? 'dark' : 'light';
  }
}
