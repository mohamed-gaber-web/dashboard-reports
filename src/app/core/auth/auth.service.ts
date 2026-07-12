import { Injectable, inject, signal } from '@angular/core';
import { HttpClient, HttpParams } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { environment } from '../../../environments/environment';

interface TokenResponse {
  token_type: string;
  expires_in: number;
  access_token: string;
}

/**
 * The per-source Azure AD parameters the browser sends to `/api/token`. The
 * matching client secret + tenant are injected server-side, keyed off clientId.
 */
export interface AuthConfig {
  clientId: string;
  clientSecret: string;
  scope: string;
  grantType: string;
}

const STORAGE_PREFIX = {
  ACCESS_TOKEN: 'rd.access_token',
  TOKEN_EXPIRY: 'rd.token_expiry',
} as const;

/** Tokens are cached per scope so multiple D365 sources don't clobber each other. */
function tokenKey(scope: string): string {
  return `${STORAGE_PREFIX.ACCESS_TOKEN}::${scope}`;
}
function expiryKey(scope: string): string {
  return `${STORAGE_PREFIX.TOKEN_EXPIRY}::${scope}`;
}

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

  /** In-flight fetches, keyed by scope, so concurrent callers don't stampede Azure AD. */
  private readonly pending = new Map<string, Promise<string>>();

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

  /**
   * Returns a valid token for the given source, fetching or refreshing as
   * needed. Defaults to the primary D365 source; a second source (e.g. Shatat)
   * passes its own `AuthConfig`.
   */
  getToken(config: AuthConfig = environment.auth): Promise<string> {
    const cached = this.readValidToken(config.scope);
    if (cached) {
      this._ready.set(true);
      return Promise.resolve(cached);
    }
    let promise = this.pending.get(config.scope);
    if (!promise) {
      promise = this.fetchToken(config).finally(() => this.pending.delete(config.scope));
      this.pending.set(config.scope, promise);
    }
    return promise;
  }

  /** Drop the cached token for a scope so the next request forces a refresh. */
  clearToken(scope: string = environment.auth.scope): void {
    localStorage.removeItem(tokenKey(scope));
    localStorage.removeItem(expiryKey(scope));
    this._ready.set(false);
  }

  private readValidToken(scope: string): string | null {
    const token = localStorage.getItem(tokenKey(scope));
    const expiry = Number(localStorage.getItem(expiryKey(scope)));
    if (!token || !expiry) return null;
    return Date.now() < expiry - REFRESH_BUFFER_MS ? token : null;
  }

  private async fetchToken(config: AuthConfig): Promise<string> {
    const { clientId, clientSecret, scope, grantType } = config;

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
    localStorage.setItem(tokenKey(scope), response.access_token);
    localStorage.setItem(expiryKey(scope), String(expiry));
    this._ready.set(true);
    return response.access_token;
  }
}
