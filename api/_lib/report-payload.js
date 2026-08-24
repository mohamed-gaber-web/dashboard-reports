/**
 * Normalises an untrusted, arbitrarily-shaped value into the strict chat-reports
 * contract. Pure — no I/O, no framework, no req/res (BE-ARCH-03).
 *
 * ## Why this exists even though the tool schema already constrains the model
 *
 * `tool_use.input` is well-formed JSON, but "well-formed" is not "valid": the
 * schema is deliberately permissive (most fields optional) so the model is never
 * forced to emit an empty placeholder to satisfy a `required` list. That leaves
 * real failure modes — a chart whose `data` is shorter than its `labels`, a
 * table row with a missing cell, a 4,000-row table — which reach the browser as
 * a broken render unless something between here and there fixes them.
 *
 * ## Repair, don't reject
 *
 * A report with one bad chart is still a useful report. Every fixable problem is
 * repaired and NAMED in `dropped[]`, which the UI shows to the user. Silently
 * discarding half a request is how a report ends up confidently wrong — the same
 * reasoning behind `ReportResult.omitted` in the AI Analyst.
 *
 * Nothing here throws. Callers get a renderable payload or an explicit `null`.
 */

const { TEMPLATE_TYPES, CHART_TYPES, LIMITS } = require('./report-contract');

/** Coerce to a bounded, trimmed string. Non-strings become ''. */
function str(value, max = LIMITS.text) {
  if (typeof value === 'string') return value.trim().slice(0, max);
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return '';
}

/** Coerce to a finite number. Anything else becomes 0 — charts cannot plot NaN. */
function num(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    // Tolerate "1,240" and "$54,200" — the model is told to send numbers here,
    // but a formatted string is a near-miss worth recovering rather than zeroing.
    const parsed = Number(value.replace(/[^0-9.eE+-]/g, ''));
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}

function arr(value, max) {
  return Array.isArray(value) ? value.slice(0, max) : [];
}

/** A non-empty, bounded list of short strings. Used for headers and labels. */
function stringList(value, max, maxLen = 120) {
  return arr(value, max)
    .map((v) => str(v, maxLen))
    .filter((v) => v.length > 0);
}

// ── Component normalisers ───────────────────────────────────────────────────

function normalizeKpiGrid(raw, dropped) {
  const items = arr(raw.items, LIMITS.kpiItems)
    .map((item) => {
      if (!item || typeof item !== 'object') return null;
      const label = str(item.label, 120);
      const value = str(item.value, 60);
      // A tile with no label or no value is not a tile.
      if (!label || !value) return null;

      const change = str(item.change, 40);
      const tile = { label, value };
      if (change) {
        tile.change = change;
        // `isPositive` means "good for the business", which is not always the
        // sign of the number. Trust the model when it says; otherwise read the
        // sign, which is right far more often than it is wrong.
        tile.isPositive =
          typeof item.isPositive === 'boolean' ? item.isPositive : !change.startsWith('-');
      }
      return tile;
    })
    .filter(Boolean);

  if (!items.length) {
    dropped.push('A KPI section was dropped: it had no tile with both a label and a value.');
    return null;
  }
  return { type: 'kpi_grid', items };
}

function normalizeChart(raw, dropped) {
  const title = str(raw.title, 160);
  const chartType = CHART_TYPES.includes(raw.chart_type) ? raw.chart_type : 'bar';
  if (raw.chart_type && !CHART_TYPES.includes(raw.chart_type)) {
    dropped.push(`Chart type “${str(raw.chart_type, 40)}” is not supported — drawn as a bar chart.`);
  }

  let labels = stringList(raw.labels, LIMITS.chartLabels);
  if (!labels.length) {
    dropped.push(`Chart “${title || 'untitled'}” was dropped: it had no category labels.`);
    return null;
  }

  let datasets = arr(raw.datasets, LIMITS.chartDatasets)
    .map((set, i) => {
      if (!set || typeof set !== 'object') return null;
      const data = arr(set.data, LIMITS.chartLabels).map(num);
      if (!data.length) return null;
      return { label: str(set.label, 120) || `Series ${i + 1}`, data };
    })
    .filter(Boolean);

  if (!datasets.length) {
    dropped.push(`Chart “${title || 'untitled'}” was dropped: it had no numeric series.`);
    return null;
  }

  // A pie or doughnut encodes parts of ONE whole. Extra series have nowhere to
  // go, so they are cut here and named, rather than silently ignored downstream.
  if ((chartType === 'pie' || chartType === 'doughnut') && datasets.length > 1) {
    dropped.push(
      `Chart “${title || 'untitled'}” is a ${chartType} and can only show one series — ` +
        `“${datasets[0].label}” was kept and ${datasets.length - 1} other(s) omitted.`,
    );
    datasets = [datasets[0]];
  }

  // Align labels and data. A series shorter than the axis would otherwise plot
  // against the wrong categories, which is worse than plotting fewer points.
  const width = Math.min(labels.length, ...datasets.map((d) => d.data.length));
  if (width < labels.length || datasets.some((d) => d.data.length !== width)) {
    dropped.push(
      `Chart “${title || 'untitled'}” had series of uneven length — trimmed to the ` +
        `first ${width} point(s) so every value lines up with its label.`,
    );
  }
  if (width < 1) {
    dropped.push(`Chart “${title || 'untitled'}” was dropped: no label had a value for it.`);
    return null;
  }

  labels = labels.slice(0, width);
  datasets = datasets.map((d) => ({ label: d.label, data: d.data.slice(0, width) }));

  return { type: 'chart', chart_type: chartType, title, labels, datasets };
}

function normalizeTable(raw, dropped) {
  const title = str(raw.title, 160);
  const headers = stringList(raw.headers, LIMITS.tableHeaders);
  if (!headers.length) {
    dropped.push(`Table “${title || 'untitled'}” was dropped: it had no column headings.`);
    return null;
  }

  const source = arr(raw.rows, LIMITS.tableRows);
  // Ragged rows are padded rather than dropped — a row missing its last cell is
  // still a row, and blanking the cell is honest about what came back.
  let ragged = false;
  const rows = source
    .map((row) => {
      if (!Array.isArray(row)) return null;
      const cells = row.slice(0, headers.length).map((c) => str(c, 300));
      if (cells.length !== headers.length) ragged = true;
      while (cells.length < headers.length) cells.push('');
      return cells;
    })
    .filter(Boolean);

  if (ragged) {
    dropped.push(
      `Table “${title || 'untitled'}” had rows that did not match its ${headers.length} ` +
        `columns — short rows were padded with blanks.`,
    );
  }
  if (Array.isArray(raw.rows) && raw.rows.length > LIMITS.tableRows) {
    dropped.push(
      `Table “${title || 'untitled'}” was capped at ${LIMITS.tableRows} rows ` +
        `(${raw.rows.length} were sent).`,
    );
  }
  if (!rows.length) {
    dropped.push(`Table “${title || 'untitled'}” was dropped: it had no readable rows.`);
    return null;
  }

  return { type: 'table', title, headers, rows };
}

function normalizeComponent(raw, dropped) {
  if (!raw || typeof raw !== 'object') return null;
  switch (raw.type) {
    case 'kpi_grid':
      return normalizeKpiGrid(raw, dropped);
    case 'chart':
      return normalizeChart(raw, dropped);
    case 'table':
      return normalizeTable(raw, dropped);
    default:
      dropped.push(`Unsupported component type “${str(raw.type, 40) || '(missing)'}” was skipped.`);
      return null;
  }
}

// ── Entry points ────────────────────────────────────────────────────────────

/**
 * Normalise an unknown value into a renderable payload.
 *
 * @returns {{payload: object, dropped: string[]}|null} `null` only when `raw` is
 *   not an object at all — i.e. there is nothing to repair.
 */
function normalizePayload(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;

  const dropped = [];

  const components = arr(raw.components, LIMITS.components)
    .map((c) => normalizeComponent(c, dropped))
    .filter(Boolean);

  const templateType = TEMPLATE_TYPES.includes(raw.template_type)
    ? raw.template_type
    : 'custom_report';

  const suggestedActions = stringList(raw.suggested_actions, LIMITS.suggestedActions, 60);

  const textResponse = str(raw.text_response);

  // A reply with neither prose nor components is not a reply.
  if (!textResponse && !components.length) return null;

  return {
    payload: {
      text_response: textResponse,
      suggested_actions: suggestedActions,
      template_type: templateType,
      components,
    },
    dropped,
  };
}

/**
 * Recover a JSON object from a prose reply — the fallback path for a model that
 * answers in text instead of calling the tool.
 *
 * Handles the three things models actually do: wrap the object in a ```json
 * fence, prefix it with a sentence, or both. Brace-matching is string-aware, so
 * a `}` inside a value does not end the scan early.
 *
 * @returns {object|null}
 */
function extractJson(text) {
  if (typeof text !== 'string' || !text.trim()) return null;

  // Strip a fenced block first — its contents are the whole candidate.
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const source = fenced ? fenced[1] : text;

  const start = source.indexOf('{');
  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < source.length; i++) {
    const ch = source[i];

    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === '\\') {
      if (inString) escaped = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;

    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(source.slice(start, i + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

module.exports = { normalizePayload, extractJson };
