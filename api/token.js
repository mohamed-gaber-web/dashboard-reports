/**
 * POST /api/token — Azure AD token proxy.
 *
 * Injects the client secret SERVER-SIDE so it never lives in the browser bundle
 * or in source control. The browser sends grant_type/client_id/scope; this
 * handler adds `client_secret` from AZURE_CLIENT_SECRET and forwards to Azure AD.
 *
 * Runs unchanged as a Vercel serverless function and under dev-api/server.js.
 *
 * Env: AZURE_CLIENT_SECRET (required). Optional: AZURE_TENANT_ID, AZURE_TOKEN_URL.
 */

const TENANT = process.env.AZURE_TENANT_ID || '26c58d65-b577-4f92-aed2-cec1395d146d';
const TOKEN_URL =
  process.env.AZURE_TOKEN_URL || `https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/token`;

async function readRaw(req) {
  if (typeof req.body === 'string') return req.body;
  if (req.body && typeof req.body === 'object') {
    // Vercel may pre-parse urlencoded bodies into an object.
    return new URLSearchParams(req.body).toString();
  }
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.statusCode = 405;
    res.end('Method Not Allowed');
    return;
  }

  res.setHeader('Content-Type', 'application/json');

  try {
    const secret = process.env.AZURE_CLIENT_SECRET;
    if (!secret) {
      res.statusCode = 500;
      res.end(JSON.stringify({ error: 'AZURE_CLIENT_SECRET is not set on the server.' }));
      return;
    }

    const params = new URLSearchParams(await readRaw(req));
    params.set('client_secret', secret);

    const azure = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
    });

    const text = await azure.text();
    res.statusCode = azure.status;
    res.end(text);
  } catch (err) {
    console.error('[api/token] error:', err);
    res.statusCode = 500;
    res.end(JSON.stringify({ error: 'Token proxy error', detail: err?.message }));
  }
};
