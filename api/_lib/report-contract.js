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

/**
 * Allowed `components[].type` values.
 *
 * `html_document` is the Executive style's whole report in one component — a
 * designed HTML fragment rather than a vocabulary the app re-renders. The set is
 * still CLOSED, which is the property that matters: an invented type still
 * selects nothing. See `report-payload.model.ts` for why the markup is safe.
 */
const COMPONENT_TYPES = ['kpi_grid', 'chart', 'table', 'html_document'];

/** The reply shapes the browser can ask for. Mirrors `ReportStyle`. */
const REPORT_STYLES = ['standard', 'executive'];

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
  /**
   * The Executive style's document, which carries its own CSS and its own SVG
   * and so is two orders of magnitude larger than any other string here. Still
   * bounded — this is the resource guard, not a style rule.
   */
  htmlDocument: 200000,
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

            // ── html_document ───────────────────────────────────────────────
            html: {
              type: 'string',
              description:
                'html_document only. One self-contained HTML fragment: the ENTIRE ' +
                'designed report. Body-level markup with one inline <style> block and ' +
                'inline <svg> for charts. No <html>, <head>, <body> or <script>, no ' +
                'external stylesheets, fonts, images or scripts, and no markdown fences. ' +
                'Only use this component when the system prompt asks for a designed ' +
                'document; it replaces the other components rather than joining them.',
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
 * The Executive style's brief.
 *
 * ## Why this is a prompt and not a renderer
 *
 * Everything below — the eight sections, the type scale, the yellow accent, the
 * RTL wrapper — is a DESIGN, and a design is the one thing the structured
 * contract cannot carry. Expressing it as `{type:'chart', labels, datasets}`
 * plus forty style knobs would be a worse version of a stylesheet. So the model
 * writes the document and the app renders it in a sandbox where markup cannot
 * do harm. See `report-payload.model.ts` for why that is safe.
 *
 * ## What is NOT relaxed
 *
 * The grounding block still applies in full, and this brief repeats its hardest
 * rule in the report's own language: a figure that is not in the summary is not
 * written, it is `غير متاح`. A designed document is more persuasive than a bare
 * table, which makes an invented number in one more dangerous, not less.
 */
const EXECUTIVE_BRIEF = [
  'YOU ARE PRODUCING AN EXECUTIVE-GRADE FINANCIAL REPORT.',
  'Act as a senior financial controller writing for a board audience.',
  '',
  'HOW TO REPLY IN THIS STYLE:',
  '- Call `render_report` with EXACTLY ONE component: {"type": "html_document", "html": "..."}.',
  '- Do NOT also send kpi_grid, chart or table components — the document contains them.',
  '- `text_response` is the chat bubble above the document: two sentences in ARABIC',
  '  saying what the report shows. `suggested_actions` are in ARABIC too.',
  '',
  'SECTIONS — build ALL of these, in this order, and do not skip any:',
  '1. KPI dashboard: a grid of 6–8 large cards with the headline figures. Each card',
  '   shows an uppercase label, the value with thousand separators, and a small ▲/▼',
  '   trend mark ONLY where the data supports a comparison.',
  '2. Executive summary: one paragraph, 3–4 sentences, the takeaways that matter.',
  '3. Visual insights: 2–3 charts as pure inline <svg> — a comparison bar chart, a',
  '   composition donut, and a top-5 horizontal bar chart. Draw them from the real',
  '   figures; a chart whose numbers you do not have is omitted, not invented.',
  '4. Condensed profit & loss: ONE grouped table. Group related accounts under',
  '   category headers — never list every line item.',
  '5. Condensed balance sheet: ONE grouped table, organised Assets / Liabilities / Equity.',
  '6. Key ratios: a card grid (current ratio, quick ratio, debt-to-equity, gross',
  '   margin, net margin, ROA). Each card carries the name, the value, and a',
  '   one-line reading of it (good / concern / warning).',
  '7. Red flags and anomalies: up to 8 bullets, each with a severity pill (high/medium/low).',
  '8. Recommended actions: 3–5 numbered, prioritised, each with a one-line rationale.',
  '',
  'WHEN THE DATA IS NOT A GENERAL LEDGER:',
  '- This style can be pointed at any module. Keep the DESIGN and the section RHYTHM,',
  '  and map the sections onto what the dataset actually holds: the headline measures',
  '  become the KPI cards, the dimensions become the grouped tables and the charts.',
  '- A section the data cannot support is written with its heading and the single',
  '  word غير متاح — never with a plausible-looking number. Do not silently drop it:',
  '  a reader who asked for a balance sheet must see that there was not one.',
  '',
  'VISUAL DESIGN — match this exactly:',
  '- Clean, modern, executive — a premium SaaS analytics dashboard.',
  '- Colours: primary #FFE600 (accents, KPI borders), dark #1A1A1A (text, table heads),',
  '  backgrounds #FFFFFF and #F8F8F6, success #00C48C, warning #FF6B35, danger #E63946,',
  '  muted #6B6B6B. Use these exact values.',
  '- Type: h1 ≥32px, h2 24px, h3 18px, body 15–16px / line-height 1.6. Font stack:',
  '  -apple-system, "Segoe UI", Tahoma, Arial, sans-serif.',
  '- Layout: max-width 1200px container, 24–32px padding, cards 12–16px radius,',
  '  box-shadow 0 2px 8px rgba(0,0,0,0.06).',
  '- KPI cards: value 28–32px bold, label above it 12px uppercase letter-spacing 1px',
  '  in grey, and a 4px solid #FFE600 accent border on the leading edge.',
  '- Tables: no harsh borders — 1px solid #EEE row separators, bold first column,',
  '  numeric columns aligned to the end, header row #1A1A1A with white text.',
  '- CSS Grid for the KPI dashboard (4 columns on desktop, responsive). Flexbox for ratios.',
  '- Section headings: bold, on white, with a 4px #FFE600 underline accent.',
  '- Severity badges: rounded pills, white text on green / orange / red.',
  '',
  'OUTPUT RULES:',
  '- Write the ENTIRE document in ARABIC — headings, labels, prose, table headers.',
  '  Numbers stay in Western digits with thousand separators (1,234,567).',
  '- The outermost element is exactly: <div dir="rtl" lang="ar" class="report">.',
  '- Because it is RTL, use logical CSS properties (padding-inline, border-inline-start,',
  '  text-align: start/end) so the accent borders and number alignment land on the',
  '  correct side.',
  '- ONE inline <style> block at the top of the fragment implements the design above.',
  '- Inline <svg> only. No external stylesheet, font, image, script or chart library.',
  '- No <html>, <head>, <body> or <script>. No markdown fences. No commentary outside',
  '  the HTML — the `html` field is the document and nothing else.',
];

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
function systemPrompt(dataContext, style) {
  // Re-validated against the closed list rather than trusted: the value comes
  // from the browser, and an unrecognised one means a stale tab, not an attack.
  const executive = style === 'executive';
  const grounded = !!dataContext && Number.isFinite(dataContext.rowCount);
  // The browser gates the fold at a row limit, so a large module arrives with
  // exact counts and NO sums. The model has to be told which world it is in, or
  // it will confidently total a column it was never given.
  const countsOnly = grounded && dataContext.coverage === 'pending';
  // The user can narrow the module to a date range or a search term. When they
  // have, the aggregates cover THAT slice — and describing them as the whole
  // dataset, which this prompt otherwise does, would be false in exactly the way
  // this contract cannot afford: the model is the thing stating the figures.
  const slice = grounded && typeof dataContext.slice === 'string' ? dataContext.slice.trim() : '';

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
  ];

  // The two styles differ in WHAT to build, never in what may be claimed — the
  // grounding block below is appended to both, unchanged.
  if (executive) {
    lines.push(...EXECUTIVE_BRIEF, '');
  } else {
    lines.push(
      'CHOOSING COMPONENTS:',
      '- `kpi_grid` for headline numbers. Lead with it when the answer has any.',
      '- `chart` with chart_type "bar" for comparison across categories, "line" for',
      '  change over time, "pie"/"doughnut" for parts of a whole (max ~6 slices).',
      '- `table` for row-level detail worth reading.',
      '- Combine them. A good report is often a kpi_grid, then a chart, then a table.',
      '- Every `datasets[].data` array must be exactly as long as `labels`.',
      '- pie and doughnut render the FIRST series only — never send more than one.',
      '- Do NOT use `html_document` in this style.',
      '',
    );
  }

  if (grounded) {
    lines.push(
      'GROUNDING — THIS IS THE IMPORTANT PART:',
      dataContext.dataset
        ? `- THE DATASET: ${dataContext.dataset}`
        : '- The dataset is described by the schema below.',
      `- It has ${Number(dataContext.rowCount).toLocaleString()} rows.`,
      '- Every figure you state MUST come from the DATA SUMMARY below, or be a',
      '  straightforward arithmetic combination of the values in it (a share, a',
      '  difference, a per-row average).',
      '- If the summary does not support a figure, DO NOT STATE IT. Say what is missing',
      '  in `text_response` and build the report from what you do have.',
      '- Never invent a `change` value. The summary has no prior-period data, so omit',
      '  `change` unless the user supplied a comparison in the conversation.',
      '- The SAMPLE ROWS are illustrative only — never total them or treat them as the',
      '  dataset. They are a handful of rows out of the count above.',
      '- Answer about THIS dataset only. If the user asks about something it does not',
      '  cover, say so and name what this one holds instead of improvising.',
      '',
    );

    if (slice) {
      // Stated as its own block rather than a clause, because the failure it
      // prevents is silent: a total that is right for the slice and presented as
      // the figure for the whole module reads exactly like a correct answer.
      lines.push(
        'THE USER HAS FILTERED THE DATA:',
        `- ${slice}`,
        '- Every figure in the summary below covers ONLY those rows. The row count is the',
        '  count for the filter, not for the module.',
        '- Say so when you state a total — "in the selected period", "for the matching',
        '  rows". Never describe these figures as the whole dataset.',
        '- Earlier turns in this conversation may have been answered under a DIFFERENT',
        '  filter. Never reuse a figure from the history: recompute from the summary',
        '  below, which is always the current one.',
        '',
      );
    }

    if (countsOnly) {
      // Not a soft warning: on this contract the model writes the figures, so a
      // fabricated total here reaches the user as a real number.
      lines.push(
        'THIS DATASET IS TOO LARGE TO TOTAL:',
        '- The row COUNT above and any date ranges are exact.',
        '- There are NO sums, averages or per-category totals in the summary, and you',
        '  MUST NOT produce any. Do not add them up yourself, and do not estimate.',
        '- Build the report from counts and the schema, and say plainly in',
        '  `text_response` that totals need a narrower slice of this dataset.',
        '',
      );
    }

    lines.push(
      'SCHEMA (available fields):',
      JSON.stringify(dataContext.schema ?? [], null, 2),
      '',
      slice
        ? 'DATA SUMMARY (real aggregates over the FILTERED ROWS described above):'
        : 'DATA SUMMARY (real aggregates over the whole dataset):',
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

module.exports = {
  REPORT_TOOL,
  TEMPLATE_TYPES,
  CHART_TYPES,
  COMPONENT_TYPES,
  REPORT_STYLES,
  LIMITS,
  systemPrompt,
};
