import { HttpInterceptorFn, HttpErrorResponse } from '@angular/common/http';
import { inject } from '@angular/core';
import { from, switchMap, catchError, throwError } from 'rxjs';
import { AuthService, AuthConfig } from './auth.service';
import { environment } from '../../../environments/environment';

/** Requests that must NOT carry the D365 bearer token. */
function isTokenRequest(url: string): boolean {
  return url.includes('/api/token') || url.includes('oauth2/v2.0/token');
}

const SHATAT = environment.shatat;

/** Only D365 data calls get the token attached (either source). */
function isDataRequest(url: string): boolean {
  return (
    url.startsWith('/data') ||
    url.includes('.dynamics.com/data') ||
    url.startsWith(SHATAT.dataPath) ||
    url.includes(new URL(SHATAT.d365BaseUrl).host)
  );
}

/** Picks which source's Azure AD credentials to authenticate the request with. */
function authFor(url: string): AuthConfig {
  const isShatat = url.startsWith(SHATAT.dataPath) || url.includes(new URL(SHATAT.d365BaseUrl).host);
  return isShatat ? SHATAT.auth : environment.auth;
}

/**
 * Attaches `Authorization: Bearer <token>` to D365 requests and, on a 401,
 * clears the stale token and retries once with a fresh one.
 */
export const authInterceptor: HttpInterceptorFn = (req, next) => {
  if (isTokenRequest(req.url) || !isDataRequest(req.url)) {
    return next(req);
  }

  const auth = inject(AuthService);
  const config = authFor(req.url);

  return from(auth.getToken(config)).pipe(
    switchMap((token) =>
      next(req.clone({ setHeaders: { Authorization: `Bearer ${token}` } })),
    ),
    catchError((error: HttpErrorResponse) => {
      if (error.status !== 401) return throwError(() => error);
      auth.clearToken(config.scope);
      return from(auth.getToken(config)).pipe(
        switchMap((token) =>
          next(req.clone({ setHeaders: { Authorization: `Bearer ${token}` } })),
        ),
      );
    }),
  );
};
