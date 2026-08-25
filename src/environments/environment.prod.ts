/**
 * Production environment. Mirrors `environment.ts` — see that file for the
 * source/tenant rules. The client secrets are intentionally absent: the
 * deployed `/api/token` function injects them from server-side environment
 * variables, so they never reach the browser bundle.
 */

const GROWPATH = {
  dataPath: '/data',
  d365BaseUrl: 'https://growpath.sandbox.operations.eu.dynamics.com',
  company: 'usmf',
  crossCompany: false,
  auth: {
    clientId: 'db61ee09-84a1-4912-b319-709480fa243a',
    clientSecret: '',
    scope: 'https://growpath.sandbox.operations.eu.dynamics.com/.default',
    grantType: 'client_credentials',
  },
};

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
  production: true,

  auth: GROWPATH.auth,

  tokenUrl: '/api/token',
  apiBaseUrl: '',
  d365BaseUrl: GROWPATH.d365BaseUrl,

  defaultCompany: GROWPATH.company,

  shatat: SHATAT,

  /** Source behind every Sales Order screen — see environment.ts. */
  salesOrder: {
    source: SHATAT,
    company: '003',
    lineEntity: 'SalesLineBiEntities',
    headerEntity: 'SalesTableBiEntities' as string | undefined,
  },

  /**
   * The general-ledger module behind the Executive financial report. Off until
   * the entity is confirmed against the tenant — see the dev environment for
   * the two probe commands that confirm it.
   */
  trialBalance: {
    enabled: false,
    source: SHATAT,
    company: '003',
    entity: 'GeneralJournalAccountEntries',
  },
};
