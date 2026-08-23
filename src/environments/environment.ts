/**
 * Development environment.
 *
 * The dashboard is a browser app, so it never talks to Azure AD or D365
 * directly — both are reached through the dev proxy (`proxy.conf.js`):
 *   - `/api/token`   -> Azure AD OAuth2 token endpoint
 *   - `/data`        -> D365 OData API (Growpath)
 *   - `/shatat-data` -> D365 OData API (Shatat UAT)
 * This keeps the client secret off the request Origin and avoids CORS.
 */

/**
 * A D365 source: one host + one Azure AD app registration + one legal entity.
 *
 * NOTE: `d365BaseUrl` and `auth.scope` must point at the SAME tenant — the token
 * audience (scope) has to match the resource being called. Change them together.
 *
 * The client secret is NEVER stored here or shipped to the browser. It is
 * injected server-side by the `/api/token` function (dev: dev-api/server.js,
 * prod: the serverless function), keyed off `clientId`.
 */
const GROWPATH = {
  /** Same-origin prefix the proxy/rewrite forwards to this host's `/data`. */
  dataPath: '/data',
  d365BaseUrl: 'https://growpath.sandbox.operations.eu.dynamics.com',
  company: 'usmf',
  /** Whether reads need `cross-company=true` to see that legal entity at all. */
  crossCompany: false,
  auth: {
    clientId: 'db61ee09-84a1-4912-b319-709480fa243a',
    clientSecret: '',
    scope: 'https://growpath.sandbox.operations.eu.dynamics.com/.default',
    grantType: 'client_credentials',
  },
};

/**
 * Second D365 source — Shatat UAT. A DIFFERENT tenant / app registration / host
 * than Growpath, so it carries its own auth block. Browser requests use
 * `dataPath` (`/shatat-data`), which the dev proxy / vercel rewrite forwards to
 * `d365BaseUrl/data`. Secret: `AZURE_CLIENT_SECRET_SHATAT`.
 */
const SHATAT = {
  dataPath: '/shatat-data',
  d365BaseUrl: 'https://shatat-uat.sandbox.operations.dynamics.com',
  company: '001',
  crossCompany: true,
  auth: {
    clientId: 'af9c6191-37aa-4bb4-a623-5e7f2c364c17',
    clientSecret: '',
    scope: 'https://shatat-uat.sandbox.operations.dynamics.com/.default',
    grantType: 'client_credentials',
  },
};

export const environment = {
  production: false,

  /** Primary source credentials — the default for `AuthService.getToken()`. */
  auth: GROWPATH.auth,

  /** Reached through the dev proxy in the browser. */
  tokenUrl: '/api/token',
  apiBaseUrl: '',
  d365BaseUrl: GROWPATH.d365BaseUrl,

  /** Default D365 legal entity for anything not bound to a specific source. */
  defaultCompany: GROWPATH.company,

  /** Shatat UAT, also used directly by the `Sha_SerialTrans` screens. */
  shatat: SHATAT,

  /**
   * Which source the Sales Order screens read from — the list, the report, the
   * dashboard headline numbers and the AI Analyst's Sales Order tab all follow
   * this one block.
   *
   * Entity names are NOT portable between the two hosts. Growpath publishes the
   * composite `GP_SalesHeaderAndLineData`, which already carries the header
   * columns as `SalesTable_*`; on Shatat that entity does not exist (it 404s),
   * so the report is assembled from the two stock BI entities instead.
   * `headerEntity: undefined` means "the line entity is already composite".
   *
   * The company is its own setting rather than `source.company`: on Shatat the
   * `Sha_SerialTrans` screens read company `001`, but every sales order with
   * remaining physical inventory lives in `003`.
   *
   * To move back to Growpath:
   *   source: GROWPATH, company: GROWPATH.company,
   *   lineEntity: 'GP_SalesHeaderAndLineData', headerEntity: undefined
   */
  salesOrder: {
    source: SHATAT,
    company: '003',
    lineEntity: 'SalesLineBiEntities',
    headerEntity: 'SalesTableBiEntities' as string | undefined,
  },
};
