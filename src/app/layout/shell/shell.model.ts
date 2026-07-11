import { Injectable, signal } from '@angular/core';

/** View state for the app shell (mobile drawer open/closed). */
@Injectable()
export class ShellModel {
  private readonly _drawerOpen = signal(false);
  readonly drawerOpen = this._drawerOpen.asReadonly();

  openDrawer(): void {
    this._drawerOpen.set(true);
  }

  closeDrawer(): void {
    this._drawerOpen.set(false);
  }

  toggleDrawer(): void {
    this._drawerOpen.update((open) => !open);
  }
}
