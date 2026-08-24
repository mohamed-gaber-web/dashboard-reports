/**
 * POST /api/chat-report — the chat-reports backend.
 *
 * Holds the Anthropic key server-side and answers with ONE strict JSON object
 * matching the chat-reports contract (see `api/_lib/report-contract.js`). Unlike
 * `/api/chat`, which streams SSE for the AI Analyst, this endpoint is
 * request/response: the payload has to be complete before anything can be
 * rendered, so streaming it to the browser would buy latency theatre and
 * nothing else.
 *
 * The route itself holds no business logic (BE-ARCH-02). It validates, delegates
 * to the pure helpers in `api/_lib/`, and maps the result onto HTTP.
 *
 * ## Why the tool is NOT forced
 *
 * `tool_choice: {type: 'tool'}` looks like the obvious way to guarantee JSON,
 * but extended thinking requires `tool_choice` to be `auto` or `none`, and
 * thinking is ON BY DEFAULT on claude-opus-5. Forcing the tool would mean
 * disabling thinking — which on this model has a documented failure mode where
 * it writes the tool call into its VISIBLE TEXT instead of emitting a tool_use
 * block. That is precisely the failure forcing was meant to prevent.
 *
 * So thinking stays adaptive, `tool_choice` stays auto, and the strict-JSON
 * guarantee is moved into a three-tier recovery chain below, which holds no
 * matter what the model does.
 *
 * ## Two providers, one contract
 *
 * The request may name a provider (`"anthropic"` or `"gemini"`), chosen from the
 * model picker in the UI; `api/_lib/ai-provider.js` resolves it and holds the
 * keys. Claude asks for a tool call, Gemini is decoded against a response
 * schema — but `payloadFrom` below sees the same Anthropic-shaped message either
 * way, so the recovery chain and the browser's contract are provider-agnostic.
 *
 * Runs unchanged as a Vercel serverless function and under dev-api/server.js.
 *
 * Env: ANTHROPIC_API_KEY / GEMINI_API_KEY (at least one)
 *      ANTHROPIC_MODEL   (optional, default claude-opus-5)
 *      ANTHROPIC_EFFORT  (optional, default medium)
 *      GEMINI_MODEL      (optional, default gemini-2.5-flash)
 *      AI_PROVIDER       (optional, forces the server-side default)
 */

const Anthropic = require('@anthropic-ai/sdk');
const { REPORT_TOOL, systemPrompt } = require('./_lib/report-contract');
const { normalizePayload, extractJson } = require('./_lib/report-payload');
const { validateChatRequest } = require('./_lib/chat-request');
const { resolveProvider } = require('./_lib/ai-provider');
const { runGeminiReport } = require('./_lib/gemini-report');
const { explainAiError } = require('./_lib/ai-errors');

// This is an interactive chat, so `medium` rather than the API default `high` —
// designing a small report from supplied aggregates is a modest reasoning task
// and a chat that pauses for many seconds reads as broken. Same reasoning as
// api/chat.js; raise via env if report quality matters more than latency.
const DEFAULT_EFFORT = 'medium';

function json(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  // A generated report is per-conversation and must never be cached by a proxy.
  res.setHeader('Cache-Control', 'no-store');
  // Defence in depth: this body is JSON, never a document, so a browser must
  // not be allowed to sniff it into something executable.
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.end(JSON.stringify(body));
}

async function readBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    // Bound the read itself — validation cannot protect against a body that is
    // never allowed to finish arriving.
    if (size > 1_000_000) throw new Error('Request body too large.');
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? JSON.parse(raw) : {};
}

/**
 * Pull a renderable payload out of Claude's reply.
 *
 * Three tiers, most reliable first. The last one cannot fail, which is what
 * makes the endpoint's contract total: the browser always receives a valid
 * payload, even when the model ignores the tool entirely.
 */
function payloadFrom(message) {
  const blocks = Array.isArray(message?.content) ? message.content : [];

  const prose = blocks
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('')
    .trim();

  // Tier 1 — the tool call. Assembled from a schema by the API, so it is always
  // well-formed JSON. This is the path that fires in practice.
  const toolUse = blocks.find((b) => b.type === 'tool_use' && b.name === REPORT_TOOL.name);
  if (toolUse) {
    const normalized = normalizePayload(toolUse.input);
    if (normalized) {
      // Prose alongside a tool call is commentary the model wrote outside the
      // payload. Prefer the payload's own text; fall back to the prose so a
      // sentence the user was meant to read is never dropped on the floor.
      if (!normalized.payload.text_response && prose) {
        normalized.payload.text_response = prose.slice(0, 2000);
      }
      return normalized;
    }
  }

  // Tier 2 — the model answered in text. Recover a JSON object from it.
  const recovered = extractJson(prose);
  if (recovered) {
    const normalized = normalizePayload(recovered);
    if (normalized) return normalized;
  }

  // Tier 3 — plain prose, no report. Still a valid payload: a question answered
  // in a sentence is a legitimate reply, it just has no components.
  return {
    payload: {
      text_response: prose.slice(0, 2000) || 'I could not produce a report for that request.',
      suggested_actions: [],
      template_type: 'custom_report',
      components: [],
    },
    dropped: [],
  };
}

/**
 * The Claude path. Returns the SDK's final message, which is the shape
 * `payloadFrom` reads — and the shape `runGeminiReport` adapts itself to.
 *
 * Streamed server-side, then collected. The browser gets one JSON body;
 * streaming here is purely so a slow reply cannot trip the SDK's HTTP timeout
 * or Vercel's function timeout on a large report.
 */
async function runClaudeReport({ apiKey, model, system, messages }) {
  const client = new Anthropic({ apiKey });

  const stream = client.messages.stream({
    model,
    max_tokens: 16000,
    thinking: { type: 'adaptive' },
    output_config: { effort: process.env.ANTHROPIC_EFFORT || DEFAULT_EFFORT },
    // The system block carries the schema and aggregates — large, and identical
    // across every turn of a conversation. Caching it makes follow-ups markedly
    // cheaper, and it re-caches when the dataset changes, which is exactly when
    // it should.
    system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
    tools: [REPORT_TOOL],
    messages,
  });

  return stream.finalMessage();
}

module.exports = async function handler(req, res) {
  // Only the verb this endpoint actually serves (BE-HDR-03).
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    json(res, 405, { error: 'Method Not Allowed' });
    return;
  }

  let body;
  try {
    body = await readBody(req);
  } catch {
    json(res, 400, { error: 'Request body must be valid JSON and under 1 MB.' });
    return;
  }

  // Validate at the edge, before any business logic runs (BE-VAL-02).
  const parsed = validateChatRequest(body);
  if (!parsed.ok) {
    json(res, 400, { error: parsed.error });
    return;
  }
  const { messages, dataContext, provider: requestedProvider } = parsed.value;

  // Resolve AFTER validation so a malformed body is a 400, not a 503, and never
  // echo a key (BE-RT-03/04). An unknown provider name falls back to the
  // server's default rather than failing — see ai-provider.js.
  const decision = resolveProvider(requestedProvider);
  if (!decision.ok) {
    json(res, decision.status, { error: decision.error });
    return;
  }
  const provider = decision.provider;
  const system = systemPrompt(dataContext);

  try {
    // Both branches return the SAME message shape, so everything downstream —
    // the refusal check, `payloadFrom`, `normalizePayload` — is written once.
    const message =
      provider.id === 'gemini'
        ? await runGeminiReport({
            apiKey: provider.apiKey,
            model: provider.model,
            system,
            messages,
          })
        : await runClaudeReport({
            apiKey: provider.apiKey,
            model: provider.model,
            system,
            messages,
          });

    if (message.stop_reason === 'refusal') {
      json(res, 200, {
        text_response: 'I was not able to answer that request.',
        suggested_actions: [],
        template_type: 'custom_report',
        components: [],
        dropped: [],
      });
      return;
    }

    const { payload, dropped } = payloadFrom(message);
    json(res, 200, { ...payload, dropped });
  } catch (err) {
    // Log the real error server-side; return the actionable summary only.
    console.error(`[api/chat-report] ${provider.id} error:`, err);
    json(res, 502, { error: explainAiError(err, provider) });
  }
};
