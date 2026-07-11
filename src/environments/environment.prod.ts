/**
 * Production environment.
 *
 * The client secret is intentionally absent — the deployed `/api/token`
 * serverless function injects it from a server-side environment variable,
 * so it never reaches the browser bundle.
 */
export const environment = {
  production: true,

  auth: {
    tokenUrl:
      'https://login.microsoftonline.com/26c58d65-b577-4f92-aed2-cec1395d146d/oauth2/v2.0/token',
    clientId: 'db61ee09-84a1-4912-b319-709480fa243a',
    clientSecret: '',
    scope: 'https://growpath.sandbox.operations.eu.dynamics.com/.default',
    grantType: 'client_credentials',
  },

  tokenUrl: '/api/token',
  apiBaseUrl: '',
  d365BaseUrl: 'https://growpath.sandbox.operations.eu.dynamics.com',

  defaultCompany: 'usmf',
};
