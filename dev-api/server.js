/**
 * Local dev server for the serverless API functions.
 *
 * In production, `/api/chat` is a Vercel serverless function. In dev, the Angular
 * dev server can't hold the model API keys, so it proxies `/api/chat` here
 * (see proxy.conf.js), and this tiny Node server runs the same handler.
 *
 * Run alongside `npm start`:  npm run dev:api
 * Requires ANTHROPIC_API_KEY and/or GEMINI_API_KEY (from .env or the shell).
 */

const http = require('http');

// Load .env (shared loader — also used by proxy.conf.js).
require('../scripts/load-env.js')();

const chatHandler = require('../api/chat.js');
const chatReportHandler = require('../api/chat-report.js');
const reportBuilderHandler = require('../api/report-builder.js');
const providersHandler = require('../api/ai-providers.js');
const tokenHandler = require('../api/token.js');
const { providerStatus, defaultProviderId } = require('../api/_lib/ai-provider.js');

const PORT = process.env.DEV_API_PORT || 3001;

/**
 * Same paths the Vercel functions are served at in production, so a route works
 * identically in both. Keyed on the path with the query string stripped.
 */
const ROUTES = {
  '/api/chat': chatHandler,
  '/api/chat-report': chatReportHandler,
  '/api/report-builder': reportBuilderHandler,
  '/api/ai-providers': providersHandler,
  '/api/token': tokenHandler,
};

const server = http.createServer((req, res) => {
  const url = (req.url || '').split('?')[0];
  const handler = ROUTES[url];
  if (handler) {
    handler(req, res);
    return;
  }
  res.statusCode = 404;
  res.end('Not found');
});

server.listen(PORT, () => {
  // Report each AI provider separately. "AI ✓" was a single flag back when there
  // was one provider; with a picker in the UI, "which of them can actually
  // answer right now" is the question this line has to settle at a glance.
  const ai = providerStatus()
    .map((p) => (p.available ? `${p.label} ✓ ${p.model}` : `${p.label} ✗ (${p.keyEnv})`))
    .join('] [');
  const az = process.env.AZURE_CLIENT_SECRET ? 'D365 ✓' : 'D365 ✗ (AZURE_CLIENT_SECRET)';
  const sh = process.env.AZURE_CLIENT_SECRET_SHATAT
    ? 'Shatat ✓'
    : 'Shatat ✗ (AZURE_CLIENT_SECRET_SHATAT)';
  console.log(`[dev-api] listening on http://localhost:${PORT}  [${ai}] [${az}] [${sh}]`);
  console.log(`[dev-api] default AI provider: ${defaultProviderId()}`);
});
