/**
 * POST /api/chat — the AI Analyst backend (OpenRouter / free LLMs).
 *
 * Holds the OpenRouter API key server-side (never shipped to the browser) and
 * streams the model's response back as Server-Sent Events. The model narrates in
 * prose and, when a report is wanted, emits a single `<report>{…}</report>` block
 * — which we extract from the stream and parse into a Report Spec the Angular app
 * renders and computes locally against real data.
 *
 * A tag block (not tool/function calling) is used deliberately: free OpenRouter
 * models vary in tool support, but every model can emit text, so this works
 * everywhere.
 *
 * Written against raw Node req/res so it runs unchanged both as a Vercel
 * serverless function and under the local dev server (dev-api/server.js).
 *
 * Env: OPENROUTER_API_KEY (required), OPENROUTER_MODEL (optional).
 */

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';

// Static fallback list if live discovery fails.
const FREE_MODELS = [
  'meta-llama/llama-3.3-70b-instruct:free',
  'qwen/qwen-2.5-72b-instruct:free',
  'mistralai/mistral-small-3.1-24b-instruct:free',
  'google/gemini-2.0-flash-exp:free',
];

// Prefer these capable families when ordering the live free-model list.
const PREFERRED = ['llama-3.3', 'qwen-2.5', 'qwen3', 'deepseek', 'mistral', 'gemini-2', 'llama-3'];

// Only auth/billing failures abort; anything else (404 unavailable, 429 rate-limit,
// 5xx) just skips to the next candidate model.
const FATAL = new Set([401, 402, 403]);

const MAX_ATTEMPTS = 8;

/** Discover models that are currently free on OpenRouter (valid slugs, ordered). */
async function discoverFreeModels(apiKey) {
  try {
    const r = await fetch('https://openrouter.ai/api/v1/models', {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (!r.ok) return FREE_MODELS;
    const { data } = await r.json();
    const free = (data || [])
      .filter((m) => m?.pricing && Number(m.pricing.prompt) === 0 && Number(m.pricing.completion) === 0)
      .map((m) => m.id);
    if (!free.length) return FREE_MODELS;
    // Preferred families first, then the rest.
    const score = (id) => {
      const i = PREFERRED.findIndex((p) => id.includes(p));
      return i === -1 ? PREFERRED.length : i;
    };
    return [...free].sort((a, b) => score(a) - score(b));
  } catch {
    return FREE_MODELS;
  }
}

const REPORT_SHAPE = `{
  "title": string,
  "description": string,                       // optional, one line
  "filters": [                                 // optional
    { "field": string, "op": "eq|neq|gt|lt|gte|lte|contains", "value": string|number }
  ],
  "kpis": [
    { "label": string, "agg": "count|sum|avg|distinctCount",
      "field": string,                         // omit for count
      "format": "integer|quantity|currency" }  // optional
  ],
  "charts": [
    { "type": "bar|donut", "title": string, "groupBy": string,
      "agg": "count|sum|avg", "valueField": string, "topN": number }  // valueField omit for count
  ],
  "table": { "columns": [string] }             // optional
}`;

function systemPrompt(dataContext) {
  const pending = dataContext?.coverage === 'pending';
  const rowCount = dataContext?.rowCount ?? 0;

  return [
    'You are the AI Analyst inside a Dynamics 365 reporting dashboard.',
    'You help users understand their data and build dashboard reports through conversation.',
    '',
    'Ground every figure ONLY in the DATA SUMMARY below — never invent numbers.',
    '',
    'When the user wants to see, chart, break down, compare, or build/create a report or',
    'dashboard, include EXACTLY ONE report block in your reply, wrapped in tags:',
    '<report>',
    '{ ...valid JSON matching the shape below... }',
    '</report>',
    '',
    'Report JSON shape:',
    REPORT_SHAPE,
    '',
    'Rules:',
    '- Inside the tags: valid JSON only. No comments, no trailing commas, no code fences.',
    '- Use ONLY field names from the SCHEMA.',
    '- Write a short (1–2 sentence) explanation OUTSIDE the tags as normal prose.',
    '- At most one <report> block. If the user only asks a question, answer in prose with no block.',
    '',
    // The datasets here reach ~11,000,000 rows, and D365 OData cannot GROUP BY or
    // SUM. Counts are always exact and free; sums require reading every matching
    // row, which is only done for a slice the user has narrowed. The model must
    // know which of those worlds it is in, or it will confidently propose a total
    // that cannot be computed.
    'IMPORTANT — what can and cannot be computed:',
    `- This dataset currently has ${rowCount.toLocaleString()} matching rows.`,
    '- COUNT is always exact and free, at any size. Prefer "agg":"count" KPIs.',
    '- Filters on a field marked "enum" in the SCHEMA must use a value from its "values" list.',
    '- "contains" only works on text fields.',
    pending
      ? [
          '- SUMS, AVERAGES, DISTINCT COUNTS and CHARTS ARE NOT AVAILABLE for this slice:',
          '  it is too large to total. The DATA SUMMARY has no sum_/avg_/top_ entries.',
          '  DO NOT propose a "sum", "avg" or "distinctCount" KPI, and DO NOT propose charts.',
          '  Instead: answer with count-based KPIs and a table, and tell the user in prose to',
          '  narrow the slice (date range, or a search term) so totals can be computed.',
        ].join('\n')
      : '- Sums, averages, distinct counts and charts ARE available — the slice has been totalled.',
    '',
    'SCHEMA (available fields):',
    JSON.stringify(dataContext?.schema ?? [], null, 2),
    '',
    'DATA SUMMARY (aggregates over the current filtered slice):',
    JSON.stringify(dataContext?.summary ?? {}, null, 2),
    '',
    'SAMPLE ROWS:',
    JSON.stringify(dataContext?.sample ?? [], null, 2),
  ].join('\n');
}

function sse(res, obj) {
  res.write(`data: ${JSON.stringify(obj)}\n\n`);
}

async function readBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? JSON.parse(raw) : {};
}

/** Try hard to parse a report JSON string; strips stray code fences. */
function tryParseReport(text) {
  let s = String(text || '').trim();
  s = s.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start === -1 || end === -1) return null;
  try {
    return JSON.parse(s.slice(start, end + 1));
  } catch {
    return null;
  }
}

/**
 * Streaming extractor: forwards prose to `onText` while pulling the
 * `<report>…</report>` block out (never shown to the user) into `onReport`.
 */
function createExtractor(onText, onReport) {
  const OPEN = '<report>';
  const CLOSE = '</report>';
  let mode = 'out';
  let out = '';
  let rep = '';

  function feed(chunk) {
    if (mode === 'out') {
      out += chunk;
      const i = out.indexOf(OPEN);
      if (i !== -1) {
        const before = out.slice(0, i);
        if (before) onText(before);
        const rest = out.slice(i + OPEN.length);
        out = '';
        mode = 'in';
        rep = '';
        feed(rest);
      } else {
        // Forward everything except a possible partial "<report>" tail.
        const keep = Math.min(out.length, OPEN.length - 1);
        const safe = out.slice(0, out.length - keep);
        if (safe) onText(safe);
        out = out.slice(out.length - keep);
      }
    } else {
      rep += chunk;
      const j = rep.indexOf(CLOSE);
      if (j !== -1) {
        const spec = tryParseReport(rep.slice(0, j));
        if (spec) onReport(spec);
        const rest = rep.slice(j + CLOSE.length);
        rep = '';
        mode = 'out';
        out = '';
        feed(rest);
      }
    }
  }

  function flush() {
    if (mode === 'out' && out) {
      onText(out);
      out = '';
    } else if (mode === 'in' && rep) {
      const spec = tryParseReport(rep);
      if (spec) onReport(spec);
    }
  }

  return { feed, flush };
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.statusCode = 405;
    res.end('Method Not Allowed');
    return;
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');

  try {
    const apiKey = process.env.OPENROUTER_API_KEY;
    if (!apiKey) {
      sse(res, {
        type: 'error',
        message: 'AI is not configured. Set OPENROUTER_API_KEY (free at openrouter.ai) and restart.',
      });
      res.end();
      return;
    }

    const { messages = [], dataContext } = await readBody(req);
    const body = {
      stream: true,
      temperature: 0.3,
      max_tokens: 3000,
      messages: [{ role: 'system', content: systemPrompt(dataContext) }, ...messages],
    };
    const headers = {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'X-Title': 'Reports Dashboard',
    };

    // Candidate models: env override first, then live-discovered free models.
    const discovered = await discoverFreeModels(apiKey);
    const candidates = [...new Set([process.env.OPENROUTER_MODEL, ...discovered].filter(Boolean))].slice(
      0,
      MAX_ATTEMPTS,
    );

    let upstream = null;
    let lastError = 'No free model responded.';
    for (const model of candidates) {
      let resp;
      try {
        resp = await fetch(OPENROUTER_URL, {
          method: 'POST',
          headers,
          body: JSON.stringify({ ...body, model }),
        });
      } catch (e) {
        lastError = e?.message || 'network error';
        continue; // network hiccup — try the next model
      }
      if (resp.ok && resp.body) {
        upstream = resp;
        break;
      }
      lastError = `${model} → ${resp.status} ${(await resp.text().catch(() => '')).slice(0, 160)}`;
      // Only auth/billing errors abort; unavailable/rate-limited models skip on.
      if (FATAL.has(resp.status)) break;
    }

    if (!upstream) {
      sse(res, {
        type: 'error',
        message: `Free models are busy right now. ${lastError}`.slice(0, 400),
      });
      res.end();
      return;
    }

    const extractor = createExtractor(
      (text) => sse(res, { type: 'text', text }),
      (spec) => sse(res, { type: 'report', spec }),
    );

    const reader = upstream.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let nl;
      while ((nl = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (payload === '[DONE]') continue;
        let json;
        try {
          json = JSON.parse(payload);
        } catch {
          continue;
        }
        const delta = json?.choices?.[0]?.delta?.content;
        if (typeof delta === 'string' && delta) extractor.feed(delta);
      }
    }

    extractor.flush();
    sse(res, { type: 'done' });
    res.end();
  } catch (err) {
    console.error('[api/chat] error:', err);
    sse(res, { type: 'error', message: err?.message || 'Unexpected server error.' });
    res.end();
  }
};
