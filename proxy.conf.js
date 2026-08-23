/**
 * Dev-server proxy for Angular 21's Vite-based dev server.
 *
 * Same-origin relative paths in the browser are forwarded to the local dev API
 * server (dev-api/server.js) for anything that needs a secret, and to D365
 * directly for data.
 *
 *   /api/token, /api/chat  -> dev-api (holds AZURE_CLIENT_SECRET, ANTHROPIC_API_KEY)
 *   /data                  -> D365 OData
 *
 * The dev API injects the Azure client secret server-side, so it never lives in
 * the browser bundle or in source. Run it with `npm run dev:api` alongside
 * `npm start`.
 *
 * NOTE: proxy config is read once at startup — restart `npm start` after editing.
 * Referenced by `angular.json` → serve.options.proxyConfig.
 */
require('./scripts/load-env.js')();

/**
 * Where each `/api/*` route goes.
 *
 * The two routes are decided independently, because their secrets differ in
 * whether they can be held locally at all:
 *
 *   /api/token — needs AZURE_CLIENT_SECRET. Vercel marks it "Sensitive", so it
 *                pulls back as "[SENSITIVE]" and can never be read out. Set
 *                REMOTE_API_URL to borrow the DEPLOYED endpoint instead.
 *   /api/chat  — needs ANTHROPIC_API_KEY. If that key is present locally, the
 *                route stays LOCAL so you run the code in this working tree;
 *                otherwise it falls back to the deployed function.
 *
 * That split matters when developing the AI Analyst: sending /api/chat to the
 * deployed function would silently exercise the previously deployed backend and
 * ignore every local edit.
 */
const REMOTE_API_URL = process.env.REMOTE_API_URL;
const LOCAL_API = `http://localhost:${process.env.DEV_API_PORT || 3001}`;

// The token route can't be served locally without the Azure secret.
const TOKEN_TARGET = REMOTE_API_URL || LOCAL_API;
// The chat route prefers local whenever the Anthropic key is available.
const CHAT_TARGET = process.env.ANTHROPIC_API_KEY ? LOCAL_API : REMOTE_API_URL || LOCAL_API;

const proxyTo = (target) => ({
  target,
  changeOrigin: true,
  // Remote targets are HTTPS with valid certs; localhost is plain HTTP.
  secure: target.startsWith('https:'),
});

const describe = (target) =>
  target === LOCAL_API ? `${target} (run \`npm run dev:api\`)` : `${target} (deployed)`;
console.log(`[proxy] /api/token -> ${describe(TOKEN_TARGET)}`);
console.log(`[proxy] /api/chat  -> ${describe(CHAT_TARGET)}`);

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
  // Azure AD token — the API injects the client secret and forwards to Azure.
  '/api/token': proxyTo(TOKEN_TARGET),

  // AI Analyst backend — the API holds ANTHROPIC_API_KEY.
  '/api/chat': proxyTo(CHAT_TARGET),

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
