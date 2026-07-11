import { Injectable, inject, signal } from '@angular/core';
import { HttpClient, HttpParams } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { environment } from '../../../environments/environment';

interface TokenResponse {
  token_type: string;
  expires_in: number;
  access_token: string;
}

const STORAGE_KEYS = {
  ACCESS_TOKEN: 'rd.access_token',
  TOKEN_EXPIRY: 'rd.token_expiry',
} as const;

/** Refresh the token this many ms before it actually expires. */
const REFRESH_BUFFER_MS = 5 * 60 * 1000;

/**
 * Owns the D365 access token (Azure AD client_credentials flow).
 * The browser never calls Azure directly — it hits the same-origin
 * `/api/token` proxy so the client secret and Origin stay off the wire.
 */
@Injectable({ providedIn: 'root' })
export class AuthService {
  private readonly http = inject(HttpClient);

  /** In-flight fetch, shared so concurrent callers don't stampede Azure AD. */
  private pending: Promise<string> | null = null;

  private readonly _ready = signal(false);
  /** True once a valid token is available. */
  readonly ready = this._ready.asReadonly();

  /**
   * Called once at startup via APP_INITIALIZER. Warms the token but never
   * blocks bootstrap — if it fails, the interceptor retries per request and
   * the top bar shows a "Connecting…" state.
   */
  async initialize(): Promise<void> {
    try {
      await this.getToken();
    } catch {
      // Non-fatal: keep booting; requests will re-attempt the token fetch.
    }
  }

  /** Returns a valid token, fetching or refreshing as needed. */
  getToken(): Promise<string> {
    const cached = this.readValidToken();
    if (cached) {
      this._ready.set(true);
      return Promise.resolve(cached);
    }
    return (this.pending ??= this.fetchToken().finally(() => (this.pending = null)));
  }

  /** Drop the cached token so the next request forces a refresh. */
  clearToken(): void {
    localStorage.removeItem(STORAGE_KEYS.ACCESS_TOKEN);
    localStorage.removeItem(STORAGE_KEYS.TOKEN_EXPIRY);
    this._ready.set(false);
  }

  private readValidToken(): string | null {
    const token = localStorage.getItem(STORAGE_KEYS.ACCESS_TOKEN);
    const expiry = Number(localStorage.getItem(STORAGE_KEYS.TOKEN_EXPIRY));
    if (!token || !expiry) return null;
    return Date.now() < expiry - REFRESH_BUFFER_MS ? token : null;
  }

  private async fetchToken(): Promise<string> {
    const { clientId, clientSecret, scope, grantType } = environment.auth;

    let body = new HttpParams()
      .set('grant_type', grantType)
      .set('client_id', clientId)
      .set('scope', scope);

    // Dev sends the secret through the proxy; in prod the `/api/token`
    // function injects it server-side, so it's omitted from the bundle.
    if (!environment.production && clientSecret) {
      body = body.set('client_secret', clientSecret);
    }

    const response = await firstValueFrom(
      this.http.post<TokenResponse>(environment.tokenUrl, body.toString(), {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      }),
    );

    const expiry = Date.now() + response.expires_in * 1000;
    localStorage.setItem(STORAGE_KEYS.ACCESS_TOKEN, response.access_token);
    localStorage.setItem(STORAGE_KEYS.TOKEN_EXPIRY, String(expiry));
    this._ready.set(true);
    return response.access_token;
  }
}
