/**
 * Dev-server proxy for Angular 21's Vite-based dev server.
 *
 * Same-origin relative paths in the browser are forwarded to the local dev API
 * server (dev-api/server.js) for anything that needs a secret, and to D365
 * directly for data.
 *
 *   /api/token, /api/chat  -> dev-api (holds AZURE_CLIENT_SECRET, OPENROUTER_API_KEY)
 *   /data                  -> D365 OData
 *
 * The dev API injects the Azure client secret server-side, so it never lives in
 * the browser bundle or in source. Run it with `npm run dev:api` alongside
 * `npm start`.
 *
 * NOTE: proxy config is read once at startup — restart `npm start` after editing.
 * Referenced by `angular.json` → serve.options.proxyConfig.
 */
const stripBrowserOrigin = (proxy) => {
  proxy.on('proxyReq', (proxyReq) => {
    proxyReq.removeHeader('origin');
    proxyReq.removeHeader('referer');
    // D365 auth is bearer-only. Never forward browser cookies to it, and don't
    // let cookies bloat the request either.
    proxyReq.removeHeader('cookie');
  });
  // D365 responds with affinity/session Set-Cookie headers that have no Domain,
  // so the browser stores them against localhost:4200. They accumulate on every
  // request until the dev server rejects the headers with a 431. We authenticate
  // with a bearer token and never need these cookies — drop them at the proxy.
  proxy.on('proxyRes', (proxyRes) => {
    delete proxyRes.headers['set-cookie'];
  });
};

module.exports = {
  // Azure AD token — dev-api injects the client secret and forwards to Azure.
  '/api/token': {
    target: 'http://localhost:3001',
    changeOrigin: true,
    secure: false,
  },

  // AI Analyst backend — dev-api holds OPENROUTER_API_KEY.
  '/api/chat': {
    target: 'http://localhost:3001',
    changeOrigin: true,
    secure: false,
  },

  // D365 OData API — primary source (Growpath).
  '/data': {
    target: 'https://growpath.sandbox.operations.eu.dynamics.com',
    changeOrigin: true,
    secure: true,
    configure: stripBrowserOrigin,
  },

  // D365 OData API — second source (Shatat UAT). `/shatat-data/*` -> that host's `/data/*`.
  '/shatat-data': {
    target: 'https://shatat-uat.sandbox.operations.dynamics.com',
    changeOrigin: true,
    secure: true,
    pathRewrite: { '^/shatat-data': '/data' },
    configure: stripBrowserOrigin,
  },
};
