/**
 * POST /api/report-builder — the AI Report Builder backend (the SECOND generative
 * report screen, alongside `/api/chat`).
 *
 * ## Why this is a separate endpoint and not a flag on /api/chat
 *
 * The tool schema IS the contract. `/api/chat` emits a `ReportSpec`
 * (`features/ai-analyst/models/report-spec.model.ts`); this emits a
 * `ReportDefinition` (`features/report-builder/models/report-definition.model.ts`)
 * — a different, richer vocabulary: `density` is minimal/standard/detailed rather
 * than a CSS density, sections include `timeline`, charts include `pie`, insights
 * carry an OBSERVATION / INTERPRETATION distinction, and recommendations carry a
 * priority and a rationale. Two contracts cannot share one tool definition, and
 * branching a single endpoint on which schema to offer would make both harder to
 * read than either is apart. The two screens exist to be compared, so they are
 * kept genuinely independent.
 *
 * Everything BELOW the contract is shared, deliberately: `_lib/ai-provider.js`
 * resolves the provider and holds the keys, `_lib/gemini-analyst.js` runs the
 * Gemini path, `_lib/gemini-schema.js` translates this schema into Gemini's
 * dialect, and `_lib/ai-errors.js` explains a failure. No key is read here.
 *
 * ## The contract, unchanged from the house rule
 *
 * THE MODEL DESIGNS, THE APP COMPUTES. `emit_report` describes the SHAPE of a
 * report — which sections, which fields, which aggregations. It never carries a
 * figure. `ReportComposerService` computes every number against the real folded
 * D365 slice, and `report-definition.validator.ts` drops or rewrites any clause
 * that cannot mean anything, recording why.
 *
 * Written against raw Node req/res so it runs unchanged as a Vercel function and
 * under the local dev server (dev-api/server.js).
 *
 * Env: ANTHROPIC_API_KEY / GEMINI_API_KEY (at least one)
 *      ANTHROPIC_MODEL   (optional, default claude-opus-5)
 *      BUILDER_EFFORT    (optional, default medium)
 *      GEMINI_MODEL      (optional, default gemini-2.5-flash)
 */

const Anthropic = require('@anthropic-ai/sdk');
const { resolveProvider } = require('./_lib/ai-provider');
const { streamGeminiAnalyst } = require('./_lib/gemini-analyst');
const { explainAiError } = require('./_lib/ai-errors');

/**
 * Reasoning depth. Report composition is a modest reasoning task and this is an
 * interactive screen, so `medium` beats the API's `high` default on felt speed.
 */
const DEFAULT_EFFORT = 'medium';

const FORMATS = ['integer', 'quantity', 'currency', 'percent'];

/** One measure. Shared by `metrics`, `comparison` and (as a shape) `timeline`. */
const METRIC = {
  type: 'object',
  properties: {
    label: { type: 'string', description: 'What this figure is called on screen.' },
    agg: { type: 'string', enum: ['count', 'sum', 'avg', 'distinctCount'] },
    field: { type: 'string', description: 'Omit when agg is "count". Must be a SCHEMA field.' },
    format: { type: 'string', enum: FORMATS },
    goodDirection: {
      type: 'string',
      enum: ['up', 'down'],
      description:
        'Only when a move really is an improvement one way. Omit when it is genuinely ' +
        'ambiguous — the app then shows the change without colouring it good or bad, ' +
        'which is the honest default. More backorder units is not obviously good news.',
    },
    note: { type: 'string', description: 'One short line under the figure.' },
  },
  required: ['label', 'agg'],
};

/**
 * The two windows of a comparison, as SIX FLAT STRINGS.
 *
 * Not a style choice, and not to be "tidied" into two nested objects: measured
 * against the live endpoint, Gemini repeatedly dropped `from` out of a nested
 * `{label, from, to}` despite it being `required`, while flat scalars survive.
 * A comparison is often the only section in its report, so a lost bound is a
 * blank sheet rather than a slightly worse chart. (The same lesson is recorded
 * in CLAUDE.md for `/api/chat`; the validator reads the nested form as well.)
 */
const PERIOD_FIELDS = {
  currentLabel: { type: 'string', description: 'comparison: name of the LATER period, e.g. "August 2025".' },
  currentFrom: {
    type: 'string',
    description:
      'comparison: REQUIRED. First day of the later period, inclusive, YYYY-MM-DD. Never omit it.',
  },
  currentTo: {
    type: 'string',
    description:
      'comparison: REQUIRED. Last day of the later period, inclusive, YYYY-MM-DD. Never omit it.',
  },
  previousLabel: { type: 'string', description: 'comparison: name of the BASELINE period, e.g. "July 2025".' },
  previousFrom: {
    type: 'string',
    description: 'comparison: REQUIRED. First day of the baseline period, inclusive, YYYY-MM-DD.',
  },
  previousTo: {
    type: 'string',
    description: 'comparison: REQUIRED. Last day of the baseline period, inclusive, YYYY-MM-DD.',
  },
};

/**
 * One section, as a FLAT object with a `type` discriminator.
 *
 * Deliberately not a schema union: `oneOf` does not survive translation into
 * Gemini's dialect (`_lib/gemini-schema.js`), and the app validates every clause
 * anyway. A permissive schema plus a strict validator is safer AND more honest
 * than a rigid schema the model pads with placeholders.
 */
const SECTION = {
  type: 'object',
  properties: {
    type: {
      type: 'string',
      enum: [
        'metrics',
        'chart',
        'table',
        'ranking',
        'comparison',
        'timeline',
        'text',
        'insights',
        'recommendations',
      ],
      description:
        'metrics = a row of headline figures. chart = one visualisation. table = detail rows. ' +
        'ranking = an ordered top-N with shares. comparison = the same measures over two ' +
        'periods. timeline = period-by-period movement with the change at each step. ' +
        'text = a paragraph. insights = short readings of the data. recommendations = ' +
        'suggested actions.',
    },
    title: { type: 'string', description: 'Heading. Omit on a metrics row — the figures caption themselves.' },
    note: { type: 'string', description: 'One line of context under the heading.' },

    // metrics
    items: { type: 'array', description: 'metrics: the figures in this row.', items: METRIC },

    // chart / ranking / timeline
    chartType: {
      type: 'string',
      enum: ['line', 'area', 'bar', 'column', 'pie', 'donut'],
      description:
        'line = change over TIME. area = the same where magnitude matters. bar = horizontal, ' +
        'best for top-N categories with long names. column = vertical, short ordered axis. ' +
        'pie/donut = parts of ONE whole, 6 slices at most. line and area REQUIRE a date field ' +
        'in groupBy.',
    },
    groupBy: { type: 'string', description: 'chart/ranking: the field to group by. A date field makes it a trend.' },
    agg: { type: 'string', enum: ['count', 'sum', 'avg'], description: 'chart/ranking/timeline.' },
    valueField: { type: 'string', description: 'chart/ranking/timeline: the measure. Omit when agg is "count".' },
    topN: { type: 'number', description: 'chart/ranking: how many groups to show.' },
    grain: {
      type: 'string',
      enum: ['auto', 'day', 'week', 'month', 'quarter', 'year'],
      description: 'chart over a date field, or timeline: the bucket size. "auto" fits the span.',
    },
    format: { type: 'string', enum: FORMATS, description: 'ranking/timeline: how to write the figure.' },
    showBars: { type: 'boolean', description: 'ranking: draw a proportional bar per row. Default true.' },

    // comparison
    dateField: { type: 'string', description: 'comparison/timeline: the date field to cut periods on.' },
    ...PERIOD_FIELDS,
    metrics: { type: 'array', description: 'comparison: the measures to compare.', items: METRIC },

    // table
    columns: { type: 'array', description: 'table: SCHEMA field names, in order.', items: { type: 'string' } },

    // text
    body: { type: 'string', description: 'text: the paragraph. Plain prose, no markdown.' },

    // insights / recommendations
    points: {
      type: 'array',
      description:
        'insights/recommendations: one short sentence each. On INSIGHTS set `kind` to say ' +
        'whether the point is something the figures show ("observation") or your reading of ' +
        'them ("interpretation") — the report labels the two differently, and calling an ' +
        'interpretation an observation is the one thing that would make it dishonest. On ' +
        'RECOMMENDATIONS set `priority`, and use `rationale` to name the figure it rests on.',
      items: {
        type: 'object',
        properties: {
          text: { type: 'string', description: 'The point itself. One sentence.' },
          kind: {
            type: 'string',
            enum: ['observation', 'interpretation'],
            description: 'insights only. Default "observation" — only claim it if it IS one.',
          },
          priority: {
            type: 'string',
            enum: ['high', 'medium', 'low'],
            description: 'recommendations only.',
          },
          rationale: {
            type: 'string',
            description: 'recommendations only. Which figure on this report supports it.',
          },
        },
        required: ['text'],
      },
    },
  },
  required: ['type'],
};

/**
 * The Report Definition, as a tool schema.
 *
 * MUST stay in sync with `ReportDefinition` in
 * `features/report-builder/models/report-definition.model.ts` — that interface is
 * what `report-definition.validator.ts` and `ReportComposerService` compile
 * against.
 */
const REPORT_TOOL = {
  name: 'emit_report',
  description:
    'Compose the report the user asked for. Call this whenever they want to see, chart, ' +
    'break down, rank, compare, trend or build anything from the data. Describe only the ' +
    'SHAPE — which sections, which fields, which aggregations. NEVER include computed ' +
    'numbers: the app calculates every figure itself from the live dataset. There is NO ' +
    'fixed template — choose the sections that answer THIS question and leave the rest ' +
    'out. Call it at most once per reply, and not at all when the user asks something you ' +
    'can simply answer in prose.',
  input_schema: {
    type: 'object',
    properties: {
      title: { type: 'string', description: 'Name the ANSWER, not the dataset. "Where the backorder units sit", not "Sales Order Report".' },
      subtitle: { type: 'string', description: 'Optional one-line qualifier — the slice, the period, the scope.' },
      summary: {
        type: 'string',
        description:
          'Optional. Two or three sentences opening the report: what it shows and what it ' +
          'means. Qualitative only ("most", "roughly a third", "the largest share") unless ' +
          'the exact figure appears verbatim in the DATA SUMMARY. This is also what opens an ' +
          'exported PDF or HTML document.',
      },
      density: {
        type: 'string',
        enum: ['minimal', 'standard', 'detailed'],
        description:
          'How much the report should carry. minimal = a few figures and a short read, for ' +
          '"quick summary" / "executive". standard = the normal answer. detailed = a full ' +
          'work-up, for "analyse", "why", "deep dive". Pick it from the QUESTION, and let it ' +
          'govern how many sections you emit as well.',
      },
      layout: {
        type: 'string',
        enum: ['executive', 'analytical', 'operational'],
        description:
          'executive = headline figures and prose first, charts full width. analytical = ' +
          'charts side by side for comparison. operational = detail rows and rankings ' +
          'dominate. Omit if none obviously fits.',
      },
      filters: {
        type: 'array',
        description:
          'Optional. Rows to include, ANDed together. Field names must come from the SCHEMA. ' +
          'Do NOT filter to a single period when the report contains a comparison or a ' +
          'timeline — every period shown has to be inside the filter or the earlier one ' +
          'measures zero.',
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
          'their place. Three excellent sections beat ten padded ones, and an unnecessary ' +
          'chart makes the real answer harder to find.',
        items: SECTION,
      },
    },
    required: ['title', 'sections'],
  },
};

/**
 * A download request from the conversation ("export this as a PDF").
 *
 * The model only asks. The browser builds the file from figures it already
 * holds — nothing the model writes is executed and no file is made server-side.
 */
const EXPORT_TOOL = {
  name: 'export_document',
  description:
    'Deliver the report on screen to the user as a downloadable file. Call this ONLY when ' +
    'they explicitly ask to export, download, save, print or "send me" one. pdf for print ' +
    'or sharing with management, html for a web page or email, excel for the underlying data.',
  input_schema: {
    type: 'object',
    properties: {
      format: { type: 'string', enum: ['pdf', 'html', 'excel'], description: 'File format.' },
    },
    required: ['format'],
  },
};

const TOOLS = [REPORT_TOOL, EXPORT_TOOL];

/**
 * Which SSE event each tool's arguments become.
 *
 * A CLOSED map, and that IS the guard: a call to anything not named here never
 * reaches the browser. Shared by both provider paths.
 */
const EVENT_FOR_TOOL = {
  [REPORT_TOOL.name]: (input) => ({ type: 'report', definition: input }),
  [EXPORT_TOOL.name]: (input) => ({ type: 'export', format: input.format }),
};

/**
 * Tools whose event is held until the turn ends. An export must not be acted on
 * before a report emitted in the SAME reply has been computed, or the download
 * ships the previous one.
 */
const DEFERRED_TOOLS = [EXPORT_TOOL.name];

function systemPrompt(dataContext, sourceLabel) {
  const pending = dataContext?.coverage === 'pending';
  const rowCount = dataContext?.rowCount ?? 0;
  const today = new Date().toISOString().slice(0, 10);

  return [
    'You are a senior business analyst and report composer working inside a Dynamics 365',
    `reporting dashboard. The user has selected the "${sourceLabel || 'business'}" module and`,
    'asks questions about it in plain language. Your job is to understand what they actually',
    'want, read the supplied aggregates, and compose the most useful report — then say in one',
    'or two sentences what you built. The prose goes in the chat; the tool call renders the',
    'report above it.',
    '',
    'For every request, work out: what is really being asked (including what earlier turns',
    'already established); which fields carry the answer and which are noise; which measures',
    'and dimensions matter; whether a comparison is meaningful and against what; whether a',
    'visualisation adds anything at all, and if so which one; which findings deserve calling',
    'out; and whether a recommendation is justified by the data or would just be filler.',
    '',
    'THERE IS NO FIXED TEMPLATE. Do not reach for metrics + chart + table out of habit.',
    'Match the shape to the question:',
    '- "Top / best / worst N by X" → a `ranking`. It states position, figure AND share, which',
    '  a bar chart alone only implies. Add a chart only if the shape adds something.',
    '- "Trend / over time / last 6 months" → a small `metrics` row and ONE line or area chart',
    '  over a DATE field. Use `timeline` instead when the step-by-step CHANGE is the point.',
    '- "Compare A with B" → a `comparison`. Set ALL SIX of currentLabel/From/To and',
    '  previousLabel/From/To — the two date pairs are what make it a comparison, and one',
    '  missing bound loses the whole section.',
    '- "Why did X change?" → open with `text`, then the metrics that evidence it, then a chart',
    '  of the dimension that explains it, then `insights`. Add `recommendations` only when the',
    '  data supports an action.',
    '- "Break it down by category" → one chart. pie/donut only for parts of a whole with ≤6',
    '  slices; bar when the category names are long; column for a short ordered axis.',
    '- "How many / what is the total X?" → ONE `metrics` section with one figure. Nothing else.',
    '- A question that is just a question → answer in prose and call NO tools.',
    '',
    'DENSITY governs how much you emit, not just how it looks:',
    '- minimal → 3–4 figures, a short `summary`, 2–3 insights. Nothing else. Use it for',
    '  "quick", "executive", "just tell me", "at a glance".',
    '- standard → metrics, one or two visualisations, insights. The normal answer.',
    '- detailed → metrics, comparisons, visualisations, contributing factors, insights and',
    '  recommendations. Use it for "analyse", "deep dive", "why", "full breakdown".',
    '',
    'OBSERVATION vs INTERPRETATION — this is the rule that keeps the report trustworthy.',
    'On every insight set `kind`. An OBSERVATION is readable straight off the figures on the',
    'page ("three customers hold over half the remaining units"). An INTERPRETATION is your',
    'reading of them ("the concentration suggests a fulfilment bottleneck at one site"). Both',
    'are welcome; labelling one as the other is not. A RECOMMENDATION is neither — it is a',
    'proposed action, and the report presents it as your suggestion, so give it a `rationale`',
    'naming the figure it rests on.',
    '',
    `TODAY IS ${today}. Use it to resolve "last 30 days", "this month", "Q2" into real dates,`,
    'and check them against the min/max date in the DATA SUMMARY. If the data ends well before',
    'today, say so rather than reporting an empty recent window.',
    '',
    'CONVERSATION — follow-ups are refinements, not new questions:',
    '- "Only the last 30 days", "now compare it with Q1", "make it by customer", "remove the',
    '  chart", "add profit margin", "make this more executive" all refer to the report you',
    '  just built. Carry the subject, the measures and the filters forward and change only',
    '  what the user changed.',
    '- The user should never have to restate the module or the earlier filters.',
    '- When a report is on screen its definition is given to you at the end of the latest user',
    '  message. START FROM IT. A report is REPLACED, never patched: re-emit the FULL',
    '  definition — every section that stays, copied across, plus the change.',
    '- "Remove the chart" means re-emit everything except that section. "Change it to a bar',
    '  chart" means re-emit everything with that one `chartType` changed. Do not take the',
    '  opportunity to redesign the rest.',
    '- Only compose a genuinely new report when the user asks about a different subject.',
    '',
    'GROUNDING — the rule the whole feature rests on:',
    '- You NEVER produce figures. You describe a report; the app computes every number in it',
    '  from the live dataset. Do not put a number in a title, a note or a section heading.',
    '- In prose, `summary`, `text` and `insights`, state ONLY what the DATA SUMMARY supports.',
    '  Never invent a revenue, an order count, a product, a customer, a date, a percentage or',
    '  a trend. Describe magnitude in words unless the exact figure appears verbatim below.',
    '- If the data cannot answer the question, SAY SO and say what would be needed. "This',
    '  slice has no delivery dates, so a trend cannot be drawn" is a good answer; a',
    '  plausible-looking report built on a guess is not.',
    '',
    'Rules: use ONLY field names from the SCHEMA; call each tool at most once per reply; never',
    'write a report as JSON in your prose; never emit HTML, CSS, Angular or any styling of',
    'your own — the report`s look is `density` and `layout` and nothing else.',
    '',
    // The datasets here reach ~11,000,000 rows and D365 OData cannot GROUP BY or
    // SUM. Counts are exact and free; sums require reading every matching row,
    // which only happens for a slice the user has narrowed. The model has to know
    // which world it is in or it will confidently propose a total that cannot be
    // computed.
    'IMPORTANT — what can and cannot be computed:',
    `- This slice currently has ${rowCount.toLocaleString()} matching rows.`,
    '- COUNT is always exact and free, at any size. Prefer "count" metrics.',
    '- Filters on a field marked "enum" in the SCHEMA must use a value from its "values" list.',
    '- "contains" only works on text fields.',
    '- A trend, a timeline and a comparison all group a DATE field, and all are cut from the',
    '  same totalled slice — so every period they show must be inside the report`s filters.',
    '- Distinct counts cannot be measured over a period, only over the whole slice.',
    pending
      ? [
          '- SUMS, AVERAGES, DISTINCT COUNTS, CHARTS, RANKINGS, TIMELINES and COMPARISONS ARE',
          '  NOT AVAILABLE for this slice: it is too large to total, and the DATA SUMMARY below',
          '  has no sum_/avg_/top_ entries at all. Use "count" metrics and a table only, and',
          '  tell the user in prose to narrow the slice (a date range, or a search term) so the',
          '  rest becomes possible.',
        ].join('\n')
      : '- Sums, averages, distinct counts, charts, rankings, timelines and comparisons ARE available — the slice has been totalled.',
    '',
    'SCHEMA (available fields):',
    JSON.stringify(dataContext?.schema ?? [], null, 2),
    '',
    'DATA SUMMARY (aggregates over the current filtered slice). `sum_`/`avg_` are totals over',
    'the whole slice, `top_` are the largest groups of a dimension, and `monthly_<date field>`',
    'is the recent month-by-month shape — use it to locate WHEN something changed:',
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

/** Keep only the roles the APIs accept, and drop empty turns they reject. */
function sanitizeMessages(messages) {
  return (Array.isArray(messages) ? messages : [])
    .filter((m) => (m?.role === 'user' || m?.role === 'assistant') && String(m.content || '').trim())
    .map((m) => ({ role: m.role, content: String(m.content) }));
}

/**
 * Append the on-screen report's definition to the final user turn.
 *
 * Without it "remove the chart" has no subject — the conversation carries prose
 * only, so the model would rebuild the whole report from the memory of its own
 * sentences and quietly change things nobody asked about.
 *
 * It rides on the MESSAGES, not the system prompt, on purpose: the system block
 * is prompt-cached and identical across turns, and a value that changes with
 * every report would invalidate that cache on every single reply.
 */
function withCurrentReport(turns, currentReport) {
  if (!currentReport || !turns.length) return turns;

  const last = turns[turns.length - 1];
  if (last.role !== 'user') return turns;

  const note = [
    '',
    '',
    '[Context, not part of my message: the report currently on screen, as the definition you',
    'emitted for it. If I am asking you to change, extend, trim or restyle THIS report, call',
    'emit_report again with the FULL updated definition — every section that stays, copied',
    'across, plus my change. Do not redesign the parts I did not mention:',
    JSON.stringify(currentReport),
    ']',
  ].join('\n');

  return [...turns.slice(0, -1), { ...last, content: last.content + note }];
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

  // Declared out here so the catch can explain the failure in the right
  // provider's terms — first thing resolved, last thing needed.
  let provider = null;

  try {
    const {
      messages = [],
      dataContext,
      currentReport,
      sourceLabel,
      provider: requested,
    } = await readBody(req);

    const turns = withCurrentReport(sanitizeMessages(messages), currentReport);
    if (!turns.length) {
      sse(res, { type: 'error', message: 'No message to send.' });
      res.end();
      return;
    }

    // `requested` comes from the picker in the UI and is re-checked against a
    // closed enum inside resolveProvider — an unknown value falls back to the
    // server's default rather than failing the request.
    const decision = resolveProvider(requested);
    if (!decision.ok) {
      sse(res, { type: 'error', message: decision.error });
      res.end();
      return;
    }
    provider = decision.provider;

    const system = systemPrompt(dataContext, sourceLabel);

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
      // Composing a report against a live schema and coverage rules is a
      // reasoning task; adaptive lets Claude decide how much to spend per turn.
      thinking: { type: 'adaptive' },
      output_config: { effort: process.env.BUILDER_EFFORT || DEFAULT_EFFORT },
      // The system prompt carries the schema, aggregates and sample rows — large
      // and identical across every turn of a conversation. Caching it makes
      // follow-ups markedly cheaper, and it re-caches when the user changes the
      // slice, which is exactly when it should.
      system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
      tools: TOOLS,
      messages: turns,
    });

    // Claude may call both tools in one turn, so the block currently streaming is
    // tracked rather than assumed. The API guarantees the assembled arguments are
    // valid JSON; a stream cut short mid-call would not be, hence the try/catch.
    let toolJson = null;
    let toolName = null;
    const held = [];

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
            if (event.delta.text) sse(res, { type: 'text', text: event.delta.text });
          } else if (event.delta.type === 'input_json_delta' && toolJson !== null) {
            toolJson += event.delta.partial_json;
          }
          // thinking_delta is ignored on purpose — no chain-of-thought is exposed
          // to the browser, and the UI has no surface for it.
          break;

        case 'content_block_stop':
          if (toolJson !== null) {
            try {
              const built = EVENT_FOR_TOOL[toolName](JSON.parse(toolJson));
              // Same ordering rule the Gemini path enforces: an export is held
              // until the turn ends so a report emitted in this reply is computed
              // first and the download is of the report the user just asked for.
              if (DEFERRED_TOOLS.includes(toolName)) held.push(built);
              else sse(res, built);
            } catch {
              // Truncated tool call. Prose still reached the user, so say nothing
              // rather than replacing a partial answer with an error.
            }
            toolJson = null;
            toolName = null;
          }
          break;
      }
    }

    const final = await stream.finalMessage();
    if (final.stop_reason === 'refusal') {
      sse(res, { type: 'error', message: `${provider.label} declined to answer that request.` });
    }

    for (const event of held) sse(res, event);

    sse(res, { type: 'done' });
    res.end();
  } catch (err) {
    console.error(`[api/report-builder] ${provider?.id ?? 'unresolved'} error:`, err);
    sse(res, { type: 'error', message: explainAiError(err, provider) });
    res.end();
  }
};
