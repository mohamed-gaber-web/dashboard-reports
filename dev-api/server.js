/**
 * Local dev server for the serverless API functions.
 *
 * In production, `/api/chat` is a Vercel serverless function. In dev, the Angular
 * dev server can't hold the Anthropic key, so it proxies `/api/chat` here
 * (see proxy.conf.js), and this tiny Node server runs the same handler.
 *
 * Run alongside `npm start`:  npm run dev:api
 * Requires ANTHROPIC_API_KEY (loaded from .env or the shell).
 */

const http = require('http');

// Load .env (shared loader — also used by proxy.conf.js).
require('../scripts/load-env.js')();

const chatHandler = require('../api/chat.js');
const tokenHandler = require('../api/token.js');

const PORT = process.env.DEV_API_PORT || 3001;

const server = http.createServer((req, res) => {
  const url = (req.url || '').split('?')[0];
  if (url === '/api/chat') {
    chatHandler(req, res);
    return;
  }
  if (url === '/api/token') {
    tokenHandler(req, res);
    return;
  }
  res.statusCode = 404;
  res.end('Not found');
});

server.listen(PORT, () => {
  const ai = process.env.ANTHROPIC_API_KEY ? 'AI ✓' : 'AI ✗ (ANTHROPIC_API_KEY)';
  const az = process.env.AZURE_CLIENT_SECRET ? 'D365 ✓' : 'D365 ✗ (AZURE_CLIENT_SECRET)';
  const sh = process.env.AZURE_CLIENT_SECRET_SHATAT
    ? 'Shatat ✓'
    : 'Shatat ✗ (AZURE_CLIENT_SECRET_SHATAT)';
  console.log(`[dev-api] listening on http://localhost:${PORT}  [${ai}] [${az}] [${sh}]`);
});
