/**
 * POST /api/token — Azure AD token proxy.
 *
 * Injects the client secret SERVER-SIDE so it never lives in the browser bundle
 * or in source control. The browser sends grant_type/client_id/scope; this
 * handler adds `client_secret` from AZURE_CLIENT_SECRET and forwards to Azure AD.
 *
 * Runs unchanged as a Vercel serverless function and under dev-api/server.js.
 *
 * Supports MULTIPLE D365 sources (each its own app registration + tenant). The
 * correct secret + tenant are chosen from the incoming `client_id`.
 *
 * Env (primary): AZURE_CLIENT_SECRET (required). Optional: AZURE_TENANT_ID, AZURE_TOKEN_URL.
 * Env (Shatat):  AZURE_CLIENT_SECRET_SHATAT. Optional: AZURE_TENANT_ID_SHATAT.
 */

const DEFAULT_TENANT = process.env.AZURE_TENANT_ID || '26c58d65-b577-4f92-aed2-cec1395d146d';

/**
 * Per-client-id credentials, resolved server-side. The browser only sends the
 * client_id + scope; the secret and tenant never leave the server.
 */
const CLIENTS = {
  // Primary source (Growpath).
  'db61ee09-84a1-4912-b319-709480fa243a': {
    secretEnv: 'AZURE_CLIENT_SECRET',
    tenant: DEFAULT_TENANT,
    tokenUrlOverride: process.env.AZURE_TOKEN_URL,
  },
  // Second source (Shatat UAT).
  'af9c6191-37aa-4bb4-a623-5e7f2c364c17': {
    secretEnv: 'AZURE_CLIENT_SECRET_SHATAT',
    tenant: process.env.AZURE_TENANT_ID_SHATAT || 'be88f713-a964-488f-89ef-00a04bc0f789',
  },
};

function resolveClient(clientId) {
  // Fall back to the primary config for an unknown/absent client_id so existing
  // callers keep working.
  const cfg = CLIENTS[clientId] || CLIENTS['db61ee09-84a1-4912-b319-709480fa243a'];
  const tokenUrl =
    cfg.tokenUrlOverride ||
    `https://login.microsoftonline.com/${cfg.tenant}/oauth2/v2.0/token`;
  return { secret: process.env[cfg.secretEnv], tokenUrl, secretEnv: cfg.secretEnv };
}

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
    const params = new URLSearchParams(await readRaw(req));
    const { secret, tokenUrl, secretEnv } = resolveClient(params.get('client_id'));
    if (!secret) {
      res.statusCode = 500;
      res.end(JSON.stringify({ error: `${secretEnv} is not set on the server.` }));
      return;
    }

    params.set('client_secret', secret);

    const azure = await fetch(tokenUrl, {
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
