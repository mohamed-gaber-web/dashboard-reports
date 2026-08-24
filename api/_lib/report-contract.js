/**
 * The chat-reports data contract — the single definition of what the model is
 * asked to produce, and the prompt that asks for it.
 *
 * Files under `api/` that begin with `_` are NOT turned into serverless
 * functions by Vercel, which is why the shared backend helpers live in
 * `api/_lib/` rather than becoming three accidental public endpoints.
 *
 * ## Why a tool schema AND a "reply in raw JSON" instruction
 *
 * The requirement is that the frontend always receives strict JSON — no code
 * fences, no "Sure! Here's your report:" preamble. Two mechanisms enforce that,
 * in priority order:
 *
 * 1. **The tool call is the primary path.** `tool_use.input` is assembled by the
 *    API from a schema, so it is always well-formed JSON. There is nothing to
 *    strip and no brace-matching to get wrong.
 * 2. **The prose instruction is the fallback path.** A model that answers in
 *    text instead of calling the tool still emits a bare JSON object, which
 *    `report-payload.js` can recover.
 *
 * Either way `api/chat-report.js` responds with one strict JSON object, so the
 * contract the browser sees is the same regardless of which path fired.
 *
 * ## Sync obligation
 *
 * `REPORT_TOOL.input_schema` MUST stay in sync with `ReportPayload` in
 * `features/chat-reports/models/report-payload.model.ts`. That interface is what
 * the Angular renderer binds to.
 */

/** Allowed `template_type` values. Closed set — the renderer switches on it. */
const TEMPLATE_TYPES = ['kpi_overview', 'detailed_analytics', 'custom_report'];

/** Allowed `chart_type` values. Each maps to one hand-built SVG primitive. */
const CHART_TYPES = ['bar', 'line', 'pie', 'doughnut'];

/** Allowed `components[].type` values. */
const COMPONENT_TYPES = ['kpi_grid', 'chart', 'table'];

/**
 * Bounds. These are not stylistic — they are the DoS guard on a payload that is
 * rendered straight into the DOM, and they keep one bad reply from locking the
 * browser up with a 50,000-row table.
 */
const LIMITS = {
  suggestedActions: 6,
  components: 8,
  kpiItems: 12,
  chartLabels: 60,
  chartDatasets: 6,
  tableHeaders: 12,
  tableRows: 200,
  /** Any single string in the payload. Longer is truncated, never rejected. */
  text: 2000,
};

const REPORT_TOOL = {
  name: 'render_report',
  description:
    'Render an analytical report for the user inside the chat. Call this for ANY request ' +
    'that wants figures, a breakdown, a comparison, a chart, a table, a summary or a ' +
    'dashboard. This is the normal way to answer — prefer it over a plain prose reply ' +
    'whenever the data can carry the answer. Call it at most once per reply.',
  input_schema: {
    type: 'object',
    properties: {
      text_response: {
        type: 'string',
        description:
          'Short analytical commentary or narrative summary — two to four sentences. ' +
          'This is the chat bubble the user reads. Say what the numbers MEAN; do not ' +
          'restate every figure that the components already show.',
      },
      suggested_actions: {
        type: 'array',
        description:
          'Two to four short follow-up prompts, written as the USER would type them ' +
          '("Compare with last month", "Show top products"). Each becomes a clickable ' +
          'chip that is sent verbatim as the next message, so write them as instructions ' +
          'to you, not as questions to the user. Max 6 words each.',
        items: { type: 'string' },
      },
      template_type: {
        type: 'string',
        enum: TEMPLATE_TYPES,
        description:
          'kpi_overview = headline numbers lead. detailed_analytics = charts and tables ' +
          'lead. custom_report = anything else.',
      },
      components: {
        type: 'array',
        description:
          'The report body, rendered top to bottom in this order. Lead with a kpi_grid ' +
          'when there are headline numbers worth stating.',
        items: {
          type: 'object',
          properties: {
            type: { type: 'string', enum: COMPONENT_TYPES },

            // ── kpi_grid ────────────────────────────────────────────────────
            items: {
              type: 'array',
              description: 'kpi_grid only. Two to six metric tiles.',
              items: {
                type: 'object',
                properties: {
                  label: { type: 'string', description: 'Metric name, e.g. "Total Revenue".' },
                  value: {
                    type: 'string',
                    description:
                      'Pre-formatted display value, e.g. "$54,200" or "1,240". Include the ' +
                      'unit or currency symbol — it is rendered verbatim.',
                  },
                  change: {
                    type: 'string',
                    description:
                      'Optional signed delta versus a comparison period, e.g. "+14.5%". ' +
                      'Omit entirely when you have no real basis for a comparison — do ' +
                      'NOT invent one to fill the field.',
                  },
                  isPositive: {
                    type: 'boolean',
                    description:
                      'Whether `change` is GOOD for the business, not whether it is ' +
                      'arithmetically positive. Falling costs are positive.',
                  },
                },
                required: ['label', 'value'],
              },
            },

            // ── chart ───────────────────────────────────────────────────────
            chart_type: { type: 'string', enum: CHART_TYPES, description: 'chart only.' },
            title: { type: 'string', description: 'chart and table only.' },
            labels: {
              type: 'array',
              description:
                'chart only. The category axis — one entry per point. For pie and ' +
                'doughnut these are the slices.',
              items: { type: 'string' },
            },
            datasets: {
              type: 'array',
              description:
                'chart only. One entry per series. `data` must be the SAME length as ' +
                '`labels`. pie and doughnut render the first series only, so pass exactly ' +
                'one for those.',
              items: {
                type: 'object',
                properties: {
                  label: { type: 'string' },
                  data: { type: 'array', items: { type: 'number' } },
                },
                required: ['label', 'data'],
              },
            },

            // ── table ───────────────────────────────────────────────────────
            headers: {
              type: 'array',
              description: 'table only. Column headings.',
              items: { type: 'string' },
            },
            rows: {
              type: 'array',
              description:
                'table only. Each row is an array of pre-formatted strings, the SAME ' +
                'length as `headers` and in the same order.',
              items: { type: 'array', items: { type: 'string' } },
            },
          },
          required: ['type'],
        },
      },
    },
    required: ['text_response', 'suggested_actions', 'template_type', 'components'],
  },
};

/**
 * The system prompt.
 *
 * `dataContext` carries real aggregates computed by the browser against D365
 * (see `features/chat-reports/services/report-context.service.ts`). Only
 * aggregates, the schema and a handful of sample rows are ever sent — never the
 * raw dataset.
 *
 * The grounding block is deliberately blunt. This contract has the MODEL emit
 * final figures, unlike the AI Analyst's `emit_report` (where the app computes
 * every number and the model cannot state one). That makes "use only these
 * aggregates" the single thing standing between the user and a confident
 * fabrication, so it is stated as a hard rule rather than a preference.
 */
function systemPrompt(dataContext) {
  const grounded = !!dataContext && Number.isFinite(dataContext.rowCount);

  const lines = [
    'You are an analytics assistant inside a Dynamics 365 operations dashboard.',
    'You answer questions about the data by building small visual reports.',
    '',
    'HOW TO REPLY:',
    '- Call the `render_report` tool. That is the normal reply.',
    '- If you cannot call tools, reply with the tool arguments as a single raw JSON',
    '  object and NOTHING else: no markdown code fences, no ```json marker, no',
    '  preamble, no trailing commentary. The first character of your reply must be',
    '  "{" and the last must be "}".',
    '',
    'CHOOSING COMPONENTS:',
    '- `kpi_grid` for headline numbers. Lead with it when the answer has any.',
    '- `chart` with chart_type "bar" for comparison across categories, "line" for',
    '  change over time, "pie"/"doughnut" for parts of a whole (max ~6 slices).',
    '- `table` for row-level detail worth reading.',
    '- Combine them. A good report is often a kpi_grid, then a chart, then a table.',
    '- Every `datasets[].data` array must be exactly as long as `labels`.',
    '- pie and doughnut render the FIRST series only — never send more than one.',
    '',
  ];

  if (grounded) {
    lines.push(
      'GROUNDING — THIS IS THE IMPORTANT PART:',
      `- The dataset below has ${Number(dataContext.rowCount).toLocaleString()} rows.`,
      '- Every figure you state MUST come from the DATA SUMMARY below, or be a',
      '  straightforward arithmetic combination of the values in it (a share, a',
      '  difference, a per-row average).',
      '- If the summary does not support a figure, DO NOT STATE IT. Say what is missing',
      '  in `text_response` and build the report from what you do have.',
      '- Never invent a `change` value. The summary has no prior-period data, so omit',
      '  `change` unless the user supplied a comparison in the conversation.',
      '- The SAMPLE ROWS are illustrative only — never total them or treat them as the',
      '  dataset. They are a handful of rows out of the count above.',
      '',
      'SCHEMA (available fields):',
      JSON.stringify(dataContext.schema ?? [], null, 2),
      '',
      'DATA SUMMARY (real aggregates over the whole dataset):',
      JSON.stringify(dataContext.summary ?? {}, null, 2),
      '',
      'SAMPLE ROWS (illustrative — not the dataset):',
      JSON.stringify(dataContext.sample ?? [], null, 2),
    );
  } else {
    // No context reached us. Say so plainly rather than letting the model fill
    // the silence with plausible-looking numbers.
    lines.push(
      'GROUNDING:',
      '- No dataset is attached to this conversation.',
      '- Do NOT invent business figures. Either ask the user for the numbers, or state',
      '  clearly in `text_response` that the report is illustrative.',
    );
  }

  return lines.join('\n');
}

module.exports = { REPORT_TOOL, TEMPLATE_TYPES, CHART_TYPES, COMPONENT_TYPES, LIMITS, systemPrompt };
