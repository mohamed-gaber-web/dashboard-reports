import {
  ChartComponentSpec,
  ChartDataset,
  ChartType,
  KpiGridComponentSpec,
  KpiItem,
  ReportComponent,
  ReportPayload,
  TableComponentSpec,
  TemplateType,
} from '../models/report-payload.model';

/**
 * Turns an untrusted, arbitrarily-shaped value into a renderable
 * {@link ReportPayload}. Pure functions — no Angular, no I/O, no state.
 *
 * ## Why this exists when the backend already normalises
 *
 * It is not redundancy, it is a second trust boundary. `api/_lib/report-payload.js`
 * validates what the MODEL produced; this validates what came back over HTTP —
 * which may also be a proxy error page, a truncated body, a cached response from
 * an older contract, or a double-encoded string. The browser is the layer that
 * must never crash, so it re-checks rather than trusting a header.
 *
 * Nothing here throws and nothing returns `undefined` for a required field: a
 * template that has to guard every binding is a template that will eventually
 * miss one.
 */

const TEMPLATE_TYPES: readonly TemplateType[] = [
  'kpi_overview',
  'detailed_analytics',
  'custom_report',
];

const CHART_TYPES: readonly ChartType[] = ['bar', 'line', 'pie', 'doughnut'];

/** Matches the server's caps. Re-applied here because the body may not be ours. */
const LIMITS = {
  suggestedActions: 6,
  components: 8,
  kpiItems: 12,
  chartLabels: 60,
  chartDatasets: 6,
  tableHeaders: 12,
  tableRows: 200,
  text: 2000,
} as const;

type Dict = Record<string, unknown>;

function isDict(value: unknown): value is Dict {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function str(value: unknown, max: number = LIMITS.text): string {
  if (typeof value === 'string') return value.trim().slice(0, max);
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return '';
}

function num(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    // Tolerate "1,240" / "$54,200" — a formatted string where a number belongs
    // is a near-miss worth recovering rather than silently plotting as zero.
    const parsed = Number(value.replace(/[^0-9.eE+-]/g, ''));
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}

function list(value: unknown, max: number): unknown[] {
  return Array.isArray(value) ? value.slice(0, max) : [];
}

function stringList(value: unknown, max: number, maxLen = 120): string[] {
  return list(value, max)
    .map((v) => str(v, maxLen))
    .filter((v) => v.length > 0);
}

// ── Component parsers ───────────────────────────────────────────────────────

function parseKpiGrid(raw: Dict): KpiGridComponentSpec | null {
  const items = list(raw['items'], LIMITS.kpiItems)
    .map((entry): KpiItem | null => {
      if (!isDict(entry)) return null;
      const label = str(entry['label'], 120);
      const value = str(entry['value'], 60);
      if (!label || !value) return null;

      const change = str(entry['change'], 40);
      if (!change) return { label, value };

      const flag = entry['isPositive'];
      return {
        label,
        value,
        change,
        // "Good", not "greater than zero". Trust the model when it states it;
        // otherwise read the sign, which is right far more often than not.
        isPositive: typeof flag === 'boolean' ? flag : !change.startsWith('-'),
      };
    })
    .filter((item): item is KpiItem => item !== null);

  return items.length ? { type: 'kpi_grid', items } : null;
}

function parseChart(raw: Dict): ChartComponentSpec | null {
  const rawType = raw['chart_type'];
  const chartType: ChartType =
    typeof rawType === 'string' && (CHART_TYPES as readonly string[]).includes(rawType)
      ? (rawType as ChartType)
      : 'bar';

  let labels = stringList(raw['labels'], LIMITS.chartLabels);
  if (!labels.length) return null;

  let datasets = list(raw['datasets'], LIMITS.chartDatasets)
    .map((entry, i): ChartDataset | null => {
      if (!isDict(entry)) return null;
      const data = list(entry['data'], LIMITS.chartLabels).map(num);
      if (!data.length) return null;
      return { label: str(entry['label'], 120) || `Series ${i + 1}`, data };
    })
    .filter((set): set is ChartDataset => set !== null);

  if (!datasets.length) return null;

  // A pie or doughnut encodes parts of ONE whole; extra series have nowhere to
  // go. The backend already trims and reports this — repeated here because this
  // parser must hold on its own for any body that did not come from our backend.
  if (chartType === 'pie' || chartType === 'doughnut') datasets = [datasets[0]];

  // Align labels and data. A series shorter than the axis would plot against
  // the wrong categories, which is worse than plotting fewer points.
  const width = Math.min(labels.length, ...datasets.map((d) => d.data.length));
  if (width < 1) return null;

  labels = labels.slice(0, width);
  datasets = datasets.map((d) => ({ label: d.label, data: d.data.slice(0, width) }));

  return { type: 'chart', chart_type: chartType, title: str(raw['title'], 160), labels, datasets };
}

function parseTable(raw: Dict): TableComponentSpec | null {
  const headers = stringList(raw['headers'], LIMITS.tableHeaders);
  if (!headers.length) return null;

  const rows = list(raw['rows'], LIMITS.tableRows)
    .map((row): string[] | null => {
      if (!Array.isArray(row)) return null;
      const cells = row.slice(0, headers.length).map((c) => str(c, 300));
      // Pad rather than drop — a row missing its last cell is still a row, and
      // a blank cell is honest about what came back.
      while (cells.length < headers.length) cells.push('');
      return cells;
    })
    .filter((row): row is string[] => row !== null);

  return rows.length ? { type: 'table', title: str(raw['title'], 160), headers, rows } : null;
}

function parseComponent(raw: unknown): ReportComponent | null {
  if (!isDict(raw)) return null;
  switch (raw['type']) {
    case 'kpi_grid':
      return parseKpiGrid(raw);
    case 'chart':
      return parseChart(raw);
    case 'table':
      return parseTable(raw);
    default:
      return null;
  }
}

// ── Entry points ────────────────────────────────────────────────────────────

/**
 * Recover a JSON object from text that may wrap it in a code fence or a
 * sentence. Brace-matching is string-aware, so a `}` inside a value does not
 * end the scan early.
 *
 * Exported for the parser's own use and for tests; callers normally want
 * {@link parseReportPayload}.
 */
export function extractJsonObject(text: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
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
          return JSON.parse(source.slice(start, i + 1)) as unknown;
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

/**
 * Parse any value into a renderable payload.
 *
 * Accepts the object the API returns, a JSON string, a double-encoded string,
 * or prose with JSON embedded in it. Returns `null` only when there is nothing
 * renderable at all — no prose and no components — which the caller surfaces as
 * an error rather than an empty bubble.
 */
export function parseReportPayload(raw: unknown): ReportPayload | null {
  // A body that arrived as a string: either JSON, or prose wrapping JSON.
  let value: unknown = raw;
  if (typeof value === 'string') {
    value = extractJsonObject(value);
  }
  if (!isDict(value)) return null;

  const components = list(value['components'], LIMITS.components)
    .map(parseComponent)
    .filter((c): c is ReportComponent => c !== null);

  const rawTemplate = value['template_type'];
  const templateType: TemplateType =
    typeof rawTemplate === 'string' && (TEMPLATE_TYPES as readonly string[]).includes(rawTemplate)
      ? (rawTemplate as TemplateType)
      : 'custom_report';

  const textResponse = str(value['text_response']);

  // Neither prose nor components is not a reply.
  if (!textResponse && !components.length) return null;

  return {
    text_response: textResponse,
    suggested_actions: stringList(value['suggested_actions'], LIMITS.suggestedActions, 60),
    template_type: templateType,
    components,
    dropped: stringList(value['dropped'], LIMITS.components * 2, 300),
  };
}
