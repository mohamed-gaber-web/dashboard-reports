/**
 * GET /api/ai-providers — what the model picker in the UI renders.
 *
 * Returns every provider this deployment knows about, whether each one is
 * actually usable, and which model it would use. The browser needs this because
 * a toggle that offers a provider with no key configured is a toggle that
 * produces a 503 on the next question — the picker should say so up front and
 * disable the option instead.
 *
 * ## No secret crosses this boundary
 *
 * `available` is a boolean derived from a key; `keyEnv` is the NAME of an
 * environment variable, already published in `.env.example` and in this repo's
 * documentation. Neither is, or is derived from, the key's value (BE-SEC-04).
 *
 * Runs unchanged as a Vercel serverless function and under dev-api/server.js.
 */

const { providerStatus, defaultProviderId } = require('./_lib/ai-provider');

module.exports = async function handler(req, res) {
  // Only the verb this endpoint serves (BE-HDR-03).
  if (req.method !== 'GET') {
    res.statusCode = 405;
    res.setHeader('Allow', 'GET');
    res.end('Method Not Allowed');
    return;
  }

  res.statusCode = 200;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  // Availability follows the environment, which can change on redeploy or on a
  // dev-api restart. A cached "Gemini is unavailable" would outlive the fix.
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.end(JSON.stringify({ providers: providerStatus(), selected: defaultProviderId() }));
};
