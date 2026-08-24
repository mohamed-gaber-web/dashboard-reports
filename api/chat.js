/**
 * POST /api/chat — the AI Analyst backend.
 *
 * Holds the model API keys server-side (never shipped to the browser) and
 * streams the response back as Server-Sent Events. The model narrates in prose
 * and, when a report is wanted, calls the `emit_report` tool — whose input IS the
 * Report Spec the Angular app renders and computes locally against real data.
 *
 * Generative pattern, unchanged: THE MODEL DESIGNS, THE APP COMPUTES. Claude never
 * returns numbers — only the report's shape. Every figure the user sees is computed
 * by ReportEngineService against the real dataset, so nothing can be hallucinated.
 *
 * Why a tool instead of the old `<report>{…}</report>` text block: the tag block
 * existed because free OpenRouter models varied in tool support. Claude has
 * first-class tool use, and `tool_use.input` is always well-formed JSON built by
 * the API — no tag scanning, no brace matching, no code-fence stripping. The SSE
 * contract to the browser is byte-for-byte the same, so the Angular client is
 * unchanged.
 *
 * The tool is deliberately NOT `strict: true`: ReportSpec has many optional fields
 * (description, filters, table, valueField, topN…) and strict mode requires every
 * property to be listed as required. SpecCompilerService already validates each
 * clause against the real schema and surfaces anything it refuses via `omitted`,
 * so a permissive schema plus that compiler is both safer and more honest than a
 * rigid schema that would force the model to emit empty placeholders.
 *
 * ## Two providers, one SSE contract
 *
 * The request may name a provider (`"anthropic"` or `"gemini"`), chosen from the
 * model picker in the UI; `api/_lib/ai-provider.js` resolves it and holds the
 * keys. The two paths differ only in HOW the tool calls arrive — Claude streams
 * argument fragments, Gemini delivers each `functionCall` whole — and both end
 * up emitting the same `report` / `analysis` / `export` events through the same
 * `EVENT_FOR_TOOL` map. `chat-api.service.ts` cannot tell which one answered.
 *
 * Written against raw Node req/res so it runs unchanged both as a Vercel
 * serverless function and under the local dev server (dev-api/server.js).
 *
 * Env: ANTHROPIC_API_KEY / GEMINI_API_KEY (at least one)
 *      ANTHROPIC_MODEL  (optional, default claude-opus-5)
 *      ANTHROPIC_EFFORT (optional, default medium — see note below)
 *      GEMINI_MODEL     (optional, default gemini-2.5-flash)
 *      AI_PROVIDER      (optional, forces the server-side default)
 */

const Anthropic = require('@anthropic-ai/sdk');
const { resolveProvider } = require('./_lib/ai-provider');
const { streamGeminiAnalyst } = require('./_lib/gemini-analyst');

// Effort trades reasoning depth against latency. This is an interactive chat, so
// `medium` is the default rather than the API's `high` — report design is a
// modest reasoning task and a chat that pauses for many seconds feels broken.
// Raise to high/xhigh via env if report quality matters more than responsiveness.
const DEFAULT_EFFORT = 'medium';

/**
 * The Report Spec, as a tool schema. MUST stay in sync with `ReportSpec` in
 * features/ai-analyst/models/report-spec.model.ts — that interface is the
 * contract SpecCompilerService compiles against.
 */
const REPORT_TOOL = {
  name: 'emit_report',
  description:
    'Render a dashboard report for the user. Call this whenever the user wants to see, ' +
    'chart, break down, compare, or build a report or dashboard. Describe only the SHAPE ' +
    'of the report — field names and aggregations. Never include computed numbers: the ' +
    'app calculates every figure itself against the real dataset. Call at most once per ' +
    'reply, and not at all when the user only asks a question you can answer in prose.',
  input_schema: {
    type: 'object',
    properties: {
      title: { type: 'string', description: 'Report title.' },
      description: { type: 'string', description: 'Optional one-line subtitle.' },
      filters: {
        type: 'array',
        description: 'Optional. Rows to include. Field names must come from the SCHEMA.',
        items: {
          type: 'object',
          properties: {
            field: { type: 'string' },
            op: { type: 'string', enum: ['eq', 'neq', 'gt', 'lt', 'gte', 'lte', 'contains'] },
            value: { type: ['string', 'number'] },
          },
          required: ['field', 'op', 'value'],
        },
      },
      kpis: {
        type: 'array',
        description: 'Headline numbers. Prefer count — it is always exact and free.',
        items: {
          type: 'object',
          properties: {
            label: { type: 'string' },
            agg: { type: 'string', enum: ['count', 'sum', 'avg', 'distinctCount'] },
            field: { type: 'string', description: 'Omit when agg is "count".' },
            format: { type: 'string', enum: ['integer', 'quantity', 'currency'] },
          },
          required: ['label', 'agg'],
        },
      },
      charts: {
        type: 'array',
        description: 'Charts to draw. Empty array when the slice is too large to total.',
        items: {
          type: 'object',
          properties: {
            type: { type: 'string', enum: ['bar', 'donut'] },
            title: { type: 'string' },
            groupBy: { type: 'string' },
            agg: { type: 'string', enum: ['count', 'sum', 'avg'] },
            valueField: { type: 'string', description: 'Omit when agg is "count".' },
            topN: { type: 'number' },
          },
          required: ['type', 'title', 'groupBy', 'agg'],
        },
      },
      table: {
        type: 'object',
        description: 'Optional detail table.',
        properties: {
          columns: { type: 'array', items: { type: 'string' } },
        },
        required: ['columns'],
      },
      design: {
        type: 'object',
        description:
          "Optional LOOK of the report, as opposed to its content. Set it when the user asks " +
          "for a visual change — 'more compact', 'bigger charts', 'one colour', 'less busy'. " +
          'Omit it otherwise and the app uses its defaults. These are the only visual controls ' +
          'there are: never describe styling in prose as though you had applied it, and never ' +
          'emit CSS, colours or sizes of your own.',
        properties: {
          density: {
            type: 'string',
            enum: ['comfortable', 'compact'],
            description: 'compact = less padding and smaller figures, so more fits on screen.',
          },
          palette: {
            type: 'string',
            enum: ['categorical', 'brand', 'accent'],
            description:
              'categorical = a different hue per category (default). brand/accent = one hue ' +
              'stepped light to dark; use when the user asks for a single colour or a calmer look.',
          },
          chartLayout: {
            type: 'string',
            enum: ['auto', 'stacked', 'grid'],
            description:
              'auto fits the chart count to the width. stacked = one chart per row (bigger). ' +
              'grid = pack more per row (smaller).',
          },
        },
      },
    },
    required: ['title', 'kpis', 'charts'],
  },
};

/**
 * The written analysis. Prose only — no figures the app has not computed.
 *
 * This is the half of a report a spec cannot express: what the numbers mean.
 * It is rendered above the report on screen and forms the opening pages of an
 * exported document.
 */
const ANALYSIS_TOOL = {
  name: 'write_analysis',
  description:
    'Write a narrative analysis of the data — what it means, not what it totals. Call this ' +
    'when the user asks for analysis, insight, a summary, or a document/report to share. ' +
    'Refer to figures qualitatively ("most", "the largest share", "roughly a third") or quote ' +
    'values that appear verbatim in the DATA SUMMARY. Never compute your own numbers.',
  input_schema: {
    type: 'object',
    properties: {
      headline: { type: 'string', description: 'One-line takeaway. The document title.' },
      summary: {
        type: 'string',
        description: 'Two to four sentences of executive summary. Plain prose, no markdown.',
      },
      findings: {
        type: 'array',
        description: 'The three to six things worth knowing, most important first.',
        items: {
          type: 'object',
          properties: {
            title: { type: 'string', description: 'Short label, a few words.' },
            detail: { type: 'string', description: 'One or two sentences of explanation.' },
          },
          required: ['title', 'detail'],
        },
      },
      recommendations: {
        type: 'array',
        description: 'Optional. Concrete suggested actions.',
        items: { type: 'string' },
      },
    },
    required: ['headline', 'summary', 'findings'],
  },
};

/**
 * A download request from the conversation ("export this as a PDF").
 *
 * The model only asks; the browser builds and saves the file from data it already
 * holds. Nothing the model writes is executed, and no file is produced server-side.
 */
const EXPORT_TOOL = {
  name: 'export_document',
  description:
    'Deliver the current analysis and report to the user as a downloadable document. ' +
    'Call this ONLY when the user explicitly asks to export, download, save, print, or ' +
    '"send me" a document. Prefer pdf when the user says print, PDF, or sharing with ' +
    'management; prefer html when they say web page, email, or HTML.',
  input_schema: {
    type: 'object',
    properties: {
      format: { type: 'string', enum: ['pdf', 'html'], description: 'Document format.' },
    },
    required: ['format'],
  },
};

/** The three tools, in the order they are offered to the model. */
const TOOLS = [REPORT_TOOL, ANALYSIS_TOOL, EXPORT_TOOL];

/**
 * Which SSE event each tool's arguments become.
 *
 * A CLOSED map, and that is the guard: a call to anything not named here is
 * dropped rather than reaching the browser. Module scope because both provider
 * paths need it — the Anthropic loop below and `streamGeminiAnalyst`.
 */
const EVENT_FOR_TOOL = {
  [REPORT_TOOL.name]: (input) => ({ type: 'report', spec: input }),
  [ANALYSIS_TOOL.name]: (input) => ({ type: 'analysis', analysis: input }),
  [EXPORT_TOOL.name]: (input) => ({ type: 'export', format: input.format }),
};

/**
 * Tools whose event is held until the turn ends. An export must not be acted on
 * before a report emitted in the SAME reply has rendered, or the download ships
 * the previous report.
 */
const DEFERRED_TOOLS = [EXPORT_TOOL.name];

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
    'dashboard, call the `emit_report` tool. Describe the report in 1–2 sentences of prose',
    'as well — the prose is shown to the user, the tool call renders the dashboard.',
    '',
    'When the user asks for analysis, insight, a summary, or a document to share,',
    'also call `write_analysis` — the narrative half of a report, which a spec cannot',
    'express. It renders above the report and opens any exported document.',
    '',
    'When the user asks to export, download, save or print, call `export_document`.',
    'Pair it with `write_analysis` (and `emit_report` if none exists yet) so the',
    'document has something to say — a document with no analysis is a bare table.',
    '',
    'CHANGING A REPORT THAT IS ALREADY ON SCREEN:',
    '- When a report exists, its spec is given to you at the end of the latest user message.',
    '- A report is REPLACED, never patched: to change one thing, call `emit_report` again with',
    '  the FULL spec — the parts that stay the same, copied across, plus the change.',
    '- Visual requests ("more compact", "bigger charts", "one colour", "too busy", "simplify")',
    '  are the `design` block. Content requests (different field, another chart, a filter) are',
    '  the rest of the spec. Either way you re-emit the whole thing.',
    '- If a visual request is not expressible in `design`, say so plainly and offer the nearest',
    '  option. Do not claim to have applied a style the schema cannot carry.',
    '',
    'Rules:',
    '- Use ONLY field names from the SCHEMA.',
    '- Call each tool at most once per reply.',
    '- If the user only asks a question, answer in prose and call no tools.',
    '- Never write a report or analysis as JSON in your prose — always use the tools.',
    '- In `write_analysis`, never state a number the DATA SUMMARY does not contain.',
    '  Describe magnitude in words instead. The app renders the exact figures.',
    '',
    // The datasets here reach ~11,000,000 rows, and D365 OData cannot GROUP BY or
    // SUM. Counts are always exact and free; sums require reading every matching
    // row, which is only done for a slice the user has narrowed. The model must
    // know which of those worlds it is in, or it will confidently propose a total
    // that cannot be computed.
    'IMPORTANT — what can and cannot be computed:',
    `- This dataset currently has ${rowCount.toLocaleString()} matching rows.`,
    '- COUNT is always exact and free, at any size. Prefer "count" KPIs.',
    '- Filters on a field marked "enum" in the SCHEMA must use a value from its "values" list.',
    '- "contains" only works on text fields.',
    pending
      ? [
          '- SUMS, AVERAGES, DISTINCT COUNTS and CHARTS ARE NOT AVAILABLE for this slice:',
          '  it is too large to total. The DATA SUMMARY has no sum_/avg_/top_ entries.',
          '  DO NOT propose a "sum", "avg" or "distinctCount" KPI, and pass an empty charts array.',
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

/** Keep only the roles Claude accepts, and drop empty turns the API rejects. */
function sanitizeMessages(messages) {
  return (Array.isArray(messages) ? messages : [])
    .filter((m) => (m?.role === 'user' || m?.role === 'assistant') && String(m.content || '').trim())
    .map((m) => ({ role: m.role, content: String(m.content) }));
}

/**
 * Append the on-screen report's spec to the final user turn.
 *
 * The model needs to see what it built before it can be asked to change it —
 * the conversation carries prose only, so without this "make that a donut" or
 * "make it more compact" has no subject and the model rebuilds the whole report
 * from the memory of its own sentences.
 *
 * It rides on the MESSAGES rather than in the system prompt on purpose: the
 * system block is prompt-cached and identical across turns, and a value that
 * changes with every report would invalidate that cache on every reply.
 */
function withCurrentReport(turns, currentReport) {
  if (!currentReport || !turns.length) return turns;

  const last = turns[turns.length - 1];
  if (last.role !== 'user') return turns;

  const note = [
    '',
    '',
    '[Context, not part of my message: the report currently on screen, as the spec you emitted',
    'for it. If I am asking you to change, restyle, extend or simplify the report, call',
    'emit_report again with the FULL updated spec, not just the changed part:',
    JSON.stringify(currentReport),
    ']',
  ].join('\n');

  return [...turns.slice(0, -1), { ...last, content: last.content + note }];
}

/**
 * Turn an SDK error into something a user can act on.
 *
 * Shared with `api/chat-report.js` — two endpoints hitting the same API should
 * not disagree about what "no credits" looks like. Routes on the provider, so a
 * Gemini failure is explained in Gemini's terms.
 */
const { explainAiError } = require('./_lib/ai-errors');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.statusCode = 405;
    res.end('Method Not Allowed');
    return;
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');

  // Declared out here so the catch can explain a failure in the right
  // provider's terms — it is the first thing resolved and the last thing needed.
  let provider = null;

  try {
    const { messages = [], dataContext, currentReport, provider: requested } = await readBody(req);

    const turns = withCurrentReport(sanitizeMessages(messages), currentReport);
    if (!turns.length) {
      sse(res, { type: 'error', message: 'No message to send.' });
      res.end();
      return;
    }

    // Which model answers. `requested` comes from the picker in the UI and is
    // checked against a closed enum inside resolveProvider — an unknown value
    // falls back to the server's default rather than failing the request.
    const decision = resolveProvider(requested);
    if (!decision.ok) {
      sse(res, { type: 'error', message: decision.error });
      res.end();
      return;
    }
    provider = decision.provider;

    const system = systemPrompt(dataContext);

    if (provider.id === 'gemini') {
      const { refused } = await streamGeminiAnalyst(
        {
          apiKey: provider.apiKey,
          model: provider.model,
          system,
          tools: TOOLS,
          messages: turns,
          eventFor: EVENT_FOR_TOOL,
          deferTools: DEFERRED_TOOLS,
        },
        (event) => sse(res, event),
      );
      if (refused) {
        sse(res, { type: 'error', message: `${provider.label} declined to answer that request.` });
      }
      sse(res, { type: 'done' });
      res.end();
      return;
    }

    const client = new Anthropic({ apiKey: provider.apiKey });

    const stream = client.messages.stream({
      model: provider.model,
      max_tokens: 16000,
      // Adaptive thinking: designing a report against a live schema and coverage
      // rules is a reasoning task, and Claude decides how much to spend per turn.
      thinking: { type: 'adaptive' },
      output_config: { effort: process.env.ANTHROPIC_EFFORT || DEFAULT_EFFORT },
      // The system prompt carries the schema, aggregates and sample rows — large
      // and identical across every turn of a conversation. Caching it makes
      // follow-up questions markedly cheaper; it re-caches when the user changes
      // the slice, which is exactly when it should.
      system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
      tools: TOOLS,
      messages: turns,
    });

    // Claude may call several tools in one turn (analyse + report + export), so
    // the block currently streaming is tracked rather than assumed.
    //
    // Accumulates the streamed tool arguments. The API guarantees the assembled
    // string is valid JSON, but a stream cut short mid-call would not be — hence
    // the try/catch at the close.
    let toolJson = null;
    let toolName = null;

    for await (const event of stream) {
      switch (event.type) {
        case 'content_block_start':
          if (event.content_block.type === 'tool_use' && EVENT_FOR_TOOL[event.content_block.name]) {
            toolName = event.content_block.name;
            toolJson = '';
          }
          break;

        case 'content_block_delta':
          if (event.delta.type === 'text_delta') {
            // Prose — stream it straight through to the chat panel.
            if (event.delta.text) sse(res, { type: 'text', text: event.delta.text });
          } else if (event.delta.type === 'input_json_delta' && toolJson !== null) {
            toolJson += event.delta.partial_json;
          }
          // thinking_delta is intentionally ignored: `display` defaults to
          // omitted, and the chat panel has no surface for reasoning.
          break;

        case 'content_block_stop':
          if (toolJson !== null) {
            try {
              sse(res, EVENT_FOR_TOOL[toolName](JSON.parse(toolJson)));
            } catch {
              // Truncated tool call — prose still reached the user, so say
              // nothing rather than replacing a partial answer with an error.
            }
            toolJson = null;
            toolName = null;
          }
          break;
      }
    }

    const final = await stream.finalMessage();
    if (final.stop_reason === 'refusal') {
      sse(res, { type: 'error', message: 'Claude declined to answer that request.' });
    }

    sse(res, { type: 'done' });
    res.end();
  } catch (err) {
    console.error(`[api/chat] ${provider?.id ?? 'unresolved'} error:`, err);
    sse(res, { type: 'error', message: explainAiError(err, provider) });
    res.end();
  }
};
