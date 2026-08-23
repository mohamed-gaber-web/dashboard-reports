/**
 * Minimal .env loader (no dependency) — reads KEY=VALUE lines from the
 * project-root `.env` into process.env.
 *
 * Shared by dev-api/server.js (needs the secrets) and proxy.conf.js (needs
 * REMOTE_API_URL). Existing shell variables always win, so `VAR=x npm start`
 * still overrides the file.
 */
const fs = require('fs');
const path = require('path');

module.exports = function loadDotenv() {
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
};
