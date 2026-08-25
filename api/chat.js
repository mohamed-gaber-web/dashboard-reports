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
 * ## The report has no fixed shape
 *
 * `emit_report` takes an ORDERED LIST of sections — metrics, chart, comparison,
 * ranking, table, text, insights, recommendations — and the model picks which
 * appear, how many, and in what order. It used to take a fixed `{kpis, charts,
 * table}` triple, so every answer came back as the same dashboard whatever was
 * asked, which is the limitation this schema exists to remove.
 *
 * A section is a FLAT object with a `type` discriminator, not a schema union.
 * `oneOf` does not survive translation into Gemini's dialect (see
 * `_lib/gemini-schema.js`), and the client validates every clause anyway.
 *
 * The tool is deliberately NOT `strict: true`: a section has many optional
 * fields and strict mode requires every property to be listed as required.
 * `report-plan.ts` validates each clause against the real schema — dropping what
 * cannot mean anything, rewriting what is merely the wrong form — and surfaces
 * all of it via `omitted`. A permissive schema plus that planner is both safer
 * and more honest than a rigid schema that forces empty placeholders.
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

/** A measure clause, reused by `metrics` sections and by `comparison`. */
const METRIC_ITEM = {
  type: 'object',
  properties: {
    label: { type: 'string', description: 'What this figure is called on screen.' },
    agg: { type: 'string', enum: ['count', 'sum', 'avg', 'distinctCount'] },
    field: { type: 'string', description: 'Omit when agg is "count". Must be a SCHEMA field.' },
    format: { type: 'string', enum: ['integer', 'quantity', 'currency', 'percent'] },
    higherIsBetter: {
      type: 'boolean',
      description:
        'COMPARISON SECTIONS ONLY. Set it only when a rise really is an improvement (revenue) ' +
        'or really is not (overdue lines). Omit when it is genuinely ambiguous — the app then ' +
        'shows the change without colouring it good or bad, which is the honest default.',
    },
  },
  required: ['label', 'agg'],
};

/**
 * The two periods of a comparison, as SIX FLAT STRINGS rather than two nested
 * `{label, from, to}` objects.
 *
 * This is not a style choice. Measured against the live endpoint, Gemini
 * repeatedly emitted the nested form with `from` missing — twice out of two,
 * despite `required: ['label','from','to']` and an emphatic description — while
 * scalar properties at the top of a section come back intact. A comparison is
 * usually the ONLY section in its report, so a dropped bound is a blank sheet
 * rather than a slightly worse chart.
 *
 * `report-plan.ts` still accepts the nested form, so a spec echoed back from an
 * older session keeps working.
 */
const PERIOD_FIELDS = {
  currentLabel: { type: 'string', description: 'comparison: name of the LATER period, e.g. "August 2025".' },
  currentFrom: {
    type: 'string',
    description:
      'comparison: REQUIRED. First day of the later period, inclusive, as YYYY-MM-DD ' +
      '(e.g. "2025-08-01"). Never omit it and never leave it blank.',
  },
  currentTo: {
    type: 'string',
    description:
      'comparison: REQUIRED. Last day of the later period, inclusive, as YYYY-MM-DD ' +
      '(e.g. "2025-08-31"). Never omit it and never leave it blank.',
  },
  previousLabel: { type: 'string', description: 'comparison: name of the BASELINE period, e.g. "July 2025".' },
  previousFrom: {
    type: 'string',
    description: 'comparison: REQUIRED. First day of the baseline period, inclusive, as YYYY-MM-DD.',
  },
  previousTo: {
    type: 'string',
    description: 'comparison: REQUIRED. Last day of the baseline period, inclusive, as YYYY-MM-DD.',
  },
};

/**
 * ONE section of the report.
 *
 * Deliberately a FLAT object with a `type` discriminator rather than a schema
 * union: `oneOf` does not survive translation into Gemini's dialect (see
 * `api/_lib/gemini-schema.js`), and the app validates every clause anyway —
 * `report-plan.ts` drops or rewrites whatever does not fit the section's kind
 * and reports what it did. A permissive schema plus a strict planner is both
 * safer and more honest than a rigid schema the model has to pad with
 * placeholders.
 */
const SECTION = {
  type: 'object',
  properties: {
    type: {
      type: 'string',
      enum: [
        'metrics',
        'chart',
        'comparison',
        'ranking',
        'table',
        'text',
        'insights',
        'recommendations',
      ],
      description:
        'metrics = a row of headline figures. chart = one visualisation. comparison = the same ' +
        'measures over two periods, with the change. ranking = an ordered top-N with shares. ' +
        'table = detail rows. text = a paragraph of explanation. insights = short readings of ' +
        'the data. recommendations = suggested actions.',
    },
    title: { type: 'string', description: 'Heading. Omit on a metrics row — the stats caption themselves.' },
    note: { type: 'string', description: 'One line of context under the heading.' },

    // metrics
    items: { type: 'array', description: 'metrics: the figures in this row.', items: METRIC_ITEM },

    // chart
    chartType: {
      type: 'string',
      enum: ['bar', 'column', 'line', 'area', 'donut'],
      description:
        'bar = horizontal, best for top-N categories with long names. column = vertical, for a ' +
        'category axis read left to right. line = change over TIME. area = the same where the ' +
        'magnitude matters. donut = parts of one whole, 6 slices at most. line and area REQUIRE ' +
        'a date field in groupBy.',
    },
    groupBy: { type: 'string', description: 'chart/ranking: the field to group by. A date field makes it a trend.' },
    agg: { type: 'string', enum: ['count', 'sum', 'avg'], description: 'chart/ranking.' },
    valueField: { type: 'string', description: 'chart/ranking: the measure. Omit when agg is "count".' },
    topN: { type: 'number', description: 'chart/ranking: how many groups to show.' },
    grain: {
      type: 'string',
      enum: ['auto', 'day', 'week', 'month', 'quarter', 'year'],
      description: 'chart over a date field: the bucket size. "auto" fits the grain to the span.',
    },

    // comparison
    dateField: { type: 'string', description: 'comparison: the date field to cut periods on.' },
    ...PERIOD_FIELDS,
    metrics: { type: 'array', description: 'comparison: the measures to compare.', items: METRIC_ITEM },

    // ranking
    chart: { type: 'boolean', description: 'ranking: draw a proportional bar per row. Default true.' },
    format: { type: 'string', enum: ['integer', 'quantity', 'currency', 'percent'], description: 'ranking.' },

    // table
    columns: { type: 'array', description: 'table: SCHEMA field names, in order.', items: { type: 'string' } },

    // text
    body: { type: 'string', description: 'text: the paragraph. Plain prose, no markdown.' },

    // insights / recommendations
    points: {
      type: 'array',
      description: 'insights/recommendations: one short sentence each.',
      items: { type: 'string' },
    },
  },
  required: ['type'],
};

/**
 * The Report Spec, as a tool schema. MUST stay in sync with `ReportSpec` in
 * features/ai-analyst/models/report-spec.model.ts — that interface is the
 * contract `report-plan.ts` and `ReportEngineService` compile against.
 */
const REPORT_TOOL = {
  name: 'emit_report',
  description:
    'Render a report for the user. Call this whenever the user wants to see, chart, break ' +
    'down, rank, compare, or build a report. Describe only the SHAPE of the report — which ' +
    'sections, which fields, which aggregations. Never include computed numbers: the app ' +
    'calculates every figure itself against the real dataset. There is NO fixed template: ' +
    'choose the sections that answer THIS question and leave the rest out. Call at most once ' +
    'per reply, and not at all when the user only asks something you can answer in prose.',
  input_schema: {
    type: 'object',
    properties: {
      title: { type: 'string', description: 'Report title. Name the answer, not the dataset.' },
      description: { type: 'string', description: 'Optional one-line subtitle.' },
      filters: {
        type: 'array',
        description:
          'Optional. Rows to include, ANDed together. Field names must come from the SCHEMA. ' +
          'Do NOT filter to a single period when the report contains a comparison — both ' +
          'periods have to be inside the filter or the earlier one measures zero.',
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
      sections: {
        type: 'array',
        description:
          'The report body, in the order it should be read. Include ONLY sections that earn ' +
          'their place for this question — a focused report of two sections beats a dashboard ' +
          'of seven. Typical shapes: a ranking question is one ranking (plus a table if the ' +
          'detail helps); a trend question is a metrics row and one line chart; a "why" ' +
          'question is text, the metrics that explain it, a chart of the contributing ' +
          'dimension, then insights.',
        items: SECTION,
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
    required: ['title', 'sections'],
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

  const today = new Date().toISOString().slice(0, 10);

  return [
    'You are an AI Business Analyst working inside a Dynamics 365 reporting dashboard.',
    'A user asks a question about their operational data; you decide what actually answers it',
    'and lay that out as a report. You are not filling in a template.',
    '',
    'For every request, work out:',
    '- what the user is really asking, including what the earlier turns already established;',
    '- which fields are relevant, and which are noise;',
    '- which measures and which dimensions carry the answer;',
    '- whether a comparison is meaningful, and against what;',
    '- whether a visualisation adds anything at all, and if so which one;',
    '- which findings deserve to be called out;',
    '- whether a recommendation is justified by the data, or would just be filler.',
    '',
    'Then call `emit_report` with ONLY the sections that earn their place. Prioritise clarity,',
    'accuracy and relevance over visual volume. A focused report of two sections is a better',
    'answer than a dashboard of seven, and padding one out with unrelated charts makes the real',
    'answer harder to find. Say what you built in 1–2 sentences of prose as well — the prose is',
    'shown in the chat, the tool call renders the report.',
    '',
    'CHOOSING THE SHAPE — match the question, not a house style:',
    '- "Show the trend / over time / last 6 months" → a small metrics row plus ONE line or area',
    '  chart grouped by a DATE field. Set `grain` (month/quarter/week) or leave it "auto".',
    '- "Top / best / worst / biggest N by X" → a `ranking` section. It states the position, the',
    '  figure and the share of the total, which a bar chart alone only implies. Add a `table`',
    '  only when the individual rows behind it are genuinely useful.',
    '- "Compare A with B" / "this month vs last" → a `comparison` section. Set ALL SIX of',
    '  currentLabel, currentFrom, currentTo, previousLabel, previousFrom, previousTo — the two',
    '  date pairs are what make it a comparison, and a missing one loses the whole section.',
    '  Add a chart only if the shape of the change matters.',
    '- "Why did X change?" → open with a `text` paragraph, then the metrics that evidence it,',
    '  then a chart of the dimension that explains it, then `insights`. Add `recommendations`',
    '  only when the data actually supports an action.',
    '- "Break down by category" → one chart. Donut only for parts of a whole with ≤6 slices;',
    '  bar for anything with long category names; column for a short ordered axis.',
    '- A question that is just a question → answer in prose and call NO tools.',
    '',
    'What NOT to do: do not add a KPI row to every report out of habit; do not attach a detail',
    'table unless the rows matter; do not draw two charts of the same breakdown; do not open',
    'with a paragraph that only restates the title.',
    '',
    `TODAY IS ${today}. Use it to resolve "last 30 days", "this month", "Q2" and similar into`,
    'real dates, and check them against the min/max date in the DATA SUMMARY — if the data ends',
    'well before today, say so rather than reporting an empty recent window.',
    '',
    'CONVERSATION CONTEXT — follow-ups are refinements, not new questions:',
    '- "Only the last 30 days", "just Q2", "now compare it with Q1", "make it by customer"',
    '  all refer to the report you just built. Carry the subject, the measures and any filters',
    '  forward; change only what the user actually changed.',
    '- The user should never have to restate the data source or the earlier filters.',
    '- When the report on screen is given to you (see below), that spec is the state of the',
    '  conversation. Start from it.',
    '',
    'IN-REPORT PROSE vs `write_analysis` — they are not the same thing, and doing both',
    'puts the same sentences on screen twice:',
    '- `text` / `insights` / `recommendations` SECTIONS are part of the report. Use them to',
    '  explain and read the figures beside them. This is the normal choice.',
    '- `write_analysis` is a standalone written brief — an executive summary with numbered',
    '  findings. It renders ABOVE the report and forms the opening pages of an exported',
    '  document. Call it when the user asks for a write-up, a summary to share, or a',
    '  document — not as a companion to insights you already put in the report.',
    '',
    'When the user asks to export, download, save or print, call `export_document`.',
    'Pair it with `write_analysis` (and `emit_report` if none exists yet) so the',
    'document has something to say — a document with no analysis is a bare table.',
    '',
    'CHANGING A REPORT THAT IS ALREADY ON SCREEN:',
    '- When a report exists, its spec is given to you at the end of the latest user message.',
    '- A report is REPLACED, never patched: to change one thing, call `emit_report` again with',
    '  the FULL spec — the sections that stay the same, copied across, plus the change.',
    '- Visual requests ("more compact", "bigger charts", "one colour", "too busy", "simplify")',
    '  are the `design` block. Content requests (different field, another section, a filter) are',
    '  the rest of the spec. Either way you re-emit the whole thing.',
    '- If a visual request is not expressible in `design`, say so plainly and offer the nearest',
    '  option. Do not claim to have applied a style the schema cannot carry.',
    '',
    'GROUNDING — this is the rule the whole feature rests on:',
    '- You NEVER produce figures. You describe the shape of a report and the app computes every',
    '  number in it from the live dataset. Do not put numbers in a section title or note.',
    '- In prose, `text` sections, `insights` and `write_analysis`, state ONLY what the DATA',
    '  SUMMARY below supports. Never invent a revenue, an order count, a product, a date, a',
    '  percentage or a trend. Describe magnitude in words ("most", "roughly a third", "the',
    '  largest share") unless the exact figure appears verbatim in the DATA SUMMARY.',
    '- If the data cannot answer the question, SAY SO and say what would be needed. An honest',
    '  "this slice has no delivery dates, so a trend cannot be drawn" is a good answer; a',
    '  plausible-looking report built on a guess is not.',
    '- A recommendation is your suggestion, not a measurement. Only make one the data supports.',
    '',
    'Rules:',
    '- Use ONLY field names from the SCHEMA.',
    '- Call each tool at most once per reply.',
    '- Never write a report or analysis as JSON in your prose — always use the tools.',
    '',
    // The datasets here reach ~11,000,000 rows, and D365 OData cannot GROUP BY or
    // SUM. Counts are always exact and free; sums require reading every matching
    // row, which is only done for a slice the user has narrowed. The model must
    // know which of those worlds it is in, or it will confidently propose a total
    // that cannot be computed.
    'IMPORTANT — what can and cannot be computed:',
    `- This dataset currently has ${rowCount.toLocaleString()} matching rows.`,
    '- COUNT is always exact and free, at any size. Prefer "count" metrics.',
    '- Filters on a field marked "enum" in the SCHEMA must use a value from its "values" list.',
    '- "contains" only works on text fields.',
    '- A trend or a comparison groups a DATE field. Both are cut from the same totalled slice,',
    '  so a comparison needs BOTH periods inside the report\'s filters — never filter to just',
    '  the current period and then compare it with the one before.',
    '- Distinct counts cannot be measured over a period, only over the whole slice.',
    pending
      ? [
          '- SUMS, AVERAGES, DISTINCT COUNTS, CHARTS, RANKINGS and COMPARISONS ARE NOT AVAILABLE',
          '  for this slice: it is too large to total. The DATA SUMMARY has no sum_/avg_/top_',
          '  entries. Use only "count" metrics and a table, and tell the user in prose to narrow',
          '  the slice (date range, or a search term) so the rest becomes possible.',
        ].join('\n')
      : '- Sums, averages, distinct counts, charts, rankings and comparisons ARE available — the slice has been totalled.',
    '',
    'SCHEMA (available fields):',
    JSON.stringify(dataContext?.schema ?? [], null, 2),
    '',
    // `monthly_<dateField>` is the last twelve months of real, folded rows. It is
    // the evidence behind a "why did this change?" answer — without it the model
    // can see the total but has no view of the series, so it can only say that
    // something moved, never when.
    'DATA SUMMARY (aggregates over the current filtered slice). `sum_`/`avg_` are totals over',
    'the whole slice, `top_` are the largest groups of a dimension, and `monthly_<date field>`',
    'is the recent month-by-month shape of the data — use it to locate WHEN something changed:',
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
