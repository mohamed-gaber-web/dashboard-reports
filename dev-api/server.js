/**
 * Local dev server for the serverless API functions.
 *
 * In production, `/api/chat` is a Vercel serverless function. In dev, the Angular
 * dev server can't hold the LLM secret, so it proxies `/api/chat` here
 * (see proxy.conf.js), and this tiny Node server runs the same handler.
 *
 * Run alongside `npm start`:  npm run dev:api
 * Requires OPENROUTER_API_KEY (loaded from .env below or the shell).
 */

const http = require('http');
const fs = require('fs');
const path = require('path');

// Minimal .env loader (no dependency) — loads KEY=VALUE lines from project-root .env.
(function loadDotenv() {
  try {
    const file = path.join(__dirname, '..', '.env');
    if (!fs.existsSync(file)) return;
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq === -1) continue;
      const key = trimmed.slice(0, eq).trim();
      const value = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
      if (!(key in process.env)) process.env[key] = value;
    }
  } catch {
    // Ignore — env can also be provided by the shell.
  }
})();

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
  const ai = process.env.OPENROUTER_API_KEY ? 'AI ✓' : 'AI ✗ (OPENROUTER_API_KEY)';
  const az = process.env.AZURE_CLIENT_SECRET ? 'D365 ✓' : 'D365 ✗ (AZURE_CLIENT_SECRET)';
  console.log(`[dev-api] listening on http://localhost:${PORT}  [${ai}] [${az}]`);
});
