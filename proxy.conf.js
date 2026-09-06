/**
 * Dev-server proxy for Angular 21's Vite-based dev server.
 *
 * Same-origin relative paths in the browser are forwarded to the local dev API
 * server (dev-api/server.js) for anything that needs a secret, and to D365
 * directly for data.
 *
 *   /api/token, /api/chat  -> dev-api (holds AZURE_CLIENT_SECRET and the AI keys)
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
 *   /api/chat  — needs a model API key. If EITHER provider's key is present
 *                locally, the route stays LOCAL so you run the code in this
 *                working tree; otherwise it falls back to the deployed function.
 *
 * That split matters when developing the AI Analyst: sending /api/chat to the
 * deployed function would silently exercise the previously deployed backend and
 * ignore every local edit.
 */
const REMOTE_API_URL = process.env.REMOTE_API_URL;
const LOCAL_API = `http://localhost:${process.env.DEV_API_PORT || 3001}`;

// The token route can't be served locally without the Azure secret.
const TOKEN_TARGET = REMOTE_API_URL || LOCAL_API;
// The chat routes prefer local whenever ANY provider key is available — the
// model picker in the UI can switch between them at runtime, so one key is
// enough to make the local backend worth running.
const HAS_AI_KEY = !!(process.env.ANTHROPIC_API_KEY || process.env.GEMINI_API_KEY);
const CHAT_TARGET = HAS_AI_KEY ? LOCAL_API : REMOTE_API_URL || LOCAL_API;

/**
 * Turn "upstream is not there" into a message that names the fix.
 *
 * When dev-api isn't running, the proxy fails with ECONNREFUSED and the browser
 * sees a bare **500 with no body** — which reads as "the token endpoint is
 * broken" when the endpoint is fine and simply has nothing behind it. That
 * misdiagnosis has cost real time more than once.
 *
 * A connection-level failure is the dev API being down, not the request being
 * wrong, so it answers 503 (+ Retry-After) with the exact command to run.
 * Anything the upstream itself returns is untouched — this only fires when
 * there was no upstream to answer at all.
 */
const explainUpstreamDown = (route) => (proxy) => {
  proxy.on('error', (err, _req, res) => {
    const down = err.code === 'ECONNREFUSED' || err.code === 'ECONNRESET' || err.code === 'EHOSTUNREACH';
    // `res` is a plain ServerResponse here; a socket-level error may have no
    // usable response object, and headers may already be on the wire.
    if (!res || typeof res.writeHead !== 'function' || res.headersSent) return;

    res.writeHead(down ? 503 : 502, { 'Content-Type': 'application/json', 'Retry-After': '5' });
    res.end(
      JSON.stringify({
        error: down
          ? `The local dev API is not running, so ${route} cannot be served. ` +
            `Start it in a second terminal with "npm run dev:api" and try again.`
          : `The local dev API could not serve ${route} (${err.code || 'unknown error'}).`,
        code: err.code,
        route,
      }),
    );
  });
};

const proxyTo = (target, route) => ({
  target,
  changeOrigin: true,
  // Remote targets are HTTPS with valid certs; localhost is plain HTTP.
  secure: target.startsWith('https:'),
  // Only worth explaining for the local target — a deployed one being
  // unreachable is a different problem with a different fix.
  ...(target === LOCAL_API ? { configure: explainUpstreamDown(route) } : {}),
});

const describe = (target) =>
  target === LOCAL_API ? `${target} (run \`npm run dev:api\`)` : `${target} (deployed)`;
console.log(`[proxy] /api/token        -> ${describe(TOKEN_TARGET)}`);
console.log(`[proxy] /api/chat         -> ${describe(CHAT_TARGET)}`);
console.log(`[proxy] /api/chat-report  -> ${describe(CHAT_TARGET)}`);
console.log(`[proxy] /api/report-builder -> ${describe(CHAT_TARGET)}`);
console.log(`[proxy] /api/ai-report-lab -> ${describe(CHAT_TARGET)}`);
console.log(`[proxy] /api/ai-providers -> ${describe(CHAT_TARGET)}`);

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
  '/api/token': proxyTo(TOKEN_TARGET, '/api/token'),

  // AI Analyst backend — the API holds the model keys.
  '/api/chat': proxyTo(CHAT_TARGET, '/api/chat'),

  /*
   * chat-reports backend — same key, same local/deployed decision as /api/chat.
   *
   * Note that '/api/chat' is a string PREFIX, so it already matches
   * '/api/chat-report'. This entry is therefore not what makes the route work —
   * it works because both rules point at the same target and neither rewrites
   * the path, so '/api/chat-report' arrives intact whichever rule wins.
   *
   * It is declared anyway so the route is visible here, and so the day the two
   * targets diverge (a separate host, or a pathRewrite on /api/chat) this line
   * is already the thing that keeps them apart instead of a silent misroute.
   */
  '/api/chat-report': proxyTo(CHAT_TARGET, '/api/chat-report'),

  /*
   * AI Report Builder backend — the second generative report screen.
   *
   * Unlike '/api/chat-report' this path is NOT a suffix of '/api/chat', so this
   * entry is genuinely load-bearing: without it the route falls through to the
   * dev server itself and returns index.html, which the SSE client would read as
   * a stream of nothing. Same local/deployed decision as the other AI routes —
   * a model key present locally means local, so edits to api/report-builder.js
   * actually run.
   */
  '/api/report-builder': proxyTo(CHAT_TARGET, '/api/report-builder'),

  /*
   * AI Report Lab backend — the isolated HTML/SVG artifact prototype.
   *
   * Load-bearing for the same reason '/api/report-builder' is: this path is NOT
   * a suffix of '/api/chat', so without this entry the route falls through to
   * the Angular dev server and returns index.html — which the SSE client reads
   * as a stream of nothing, i.e. a page that hangs instead of one that fails.
   */
  '/api/ai-report-lab': proxyTo(CHAT_TARGET, '/api/ai-report-lab'),

  /*
   * Which providers this backend can actually use, for the model picker.
   *
   * It MUST follow CHAT_TARGET, not be decided separately: a picker answered by
   * the deployed function while the questions go to the local one would report
   * availability for the wrong process — offering Claude because production has
   * the key, while every question 503s locally.
   */
  '/api/ai-providers': proxyTo(CHAT_TARGET, '/api/ai-providers'),

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
