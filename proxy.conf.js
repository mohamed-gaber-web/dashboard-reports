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

  // D365 OData API.
  '/data': {
    target: 'https://growpath.sandbox.operations.eu.dynamics.com',
    changeOrigin: true,
    secure: true,
    configure: stripBrowserOrigin,
  },
};
