import { HttpInterceptorFn, HttpErrorResponse } from '@angular/common/http';
import { inject } from '@angular/core';
import { from, switchMap, catchError, throwError } from 'rxjs';
import { AuthService } from './auth.service';

/** Requests that must NOT carry the D365 bearer token. */
function isTokenRequest(url: string): boolean {
  return url.includes('/api/token') || url.includes('oauth2/v2.0/token');
}

/** Only D365 data calls get the token attached. */
function isDataRequest(url: string): boolean {
  return url.startsWith('/data') || url.includes('.dynamics.com/data');
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

  return from(auth.getToken()).pipe(
    switchMap((token) =>
      next(req.clone({ setHeaders: { Authorization: `Bearer ${token}` } })),
    ),
    catchError((error: HttpErrorResponse) => {
      if (error.status !== 401) return throwError(() => error);
      auth.clearToken();
      return from(auth.getToken()).pipe(
        switchMap((token) =>
          next(req.clone({ setHeaders: { Authorization: `Bearer ${token}` } })),
        ),
      );
    }),
  );
};
