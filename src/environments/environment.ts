/**
 * Development environment.
 *
 * The dashboard is a browser app, so it never talks to Azure AD or D365
 * directly — both are reached through the dev proxy (`proxy.conf.js`):
 *   - `/api/token` -> Azure AD OAuth2 token endpoint
 *   - `/data`      -> D365 OData API
 * This keeps the client secret off the request Origin and avoids CORS.
 *
 * NOTE: `d365BaseUrl` and `auth.scope` must point at the SAME D365 tenant —
 * the token audience (scope) has to match the resource being called. The
 * values below are the proven sandbox pair. To target another environment,
 * change both together.
 */
export const environment = {
  production: false,

  auth: {
    tokenUrl:
      'https://login.microsoftonline.com/26c58d65-b577-4f92-aed2-cec1395d146d/oauth2/v2.0/token',
    clientId: 'db61ee09-84a1-4912-b319-709480fa243a',
    // The client secret is NEVER stored here or shipped to the browser. It is
    // injected server-side by the `/api/token` function (dev: dev-api/server.js,
    // prod: the serverless function), which reads it from AZURE_CLIENT_SECRET.
    clientSecret: '',
    scope: 'https://growpath.sandbox.operations.eu.dynamics.com/.default',
    grantType: 'client_credentials',
  },

  /** Reached through the dev proxy in the browser. */
  tokenUrl: '/api/token',
  apiBaseUrl: '',
  d365BaseUrl: 'https://growpath.sandbox.operations.eu.dynamics.com',

  /** Default D365 legal entity used by report filters. */
  defaultCompany: 'usmf',
};
