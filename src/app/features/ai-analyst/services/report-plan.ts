import { AnalystSource } from '../models/analyst-source.model';
import { FieldMeta, ValueFormat } from '../models/field-meta.model';
import {
  ChartSectionSpec,
  ComparisonSectionSpec,
  KpiSpec,
  ListSectionSpec,
  MetricsSectionSpec,
  RankingSectionSpec,
  ReportChartType,
  ReportSection,
  ReportSpec,
  TableSectionSpec,
  TextSectionSpec,
  TimeGrain,
} from '../models/report-spec.model';
import { isPeriodShorthand, periodBound } from './time-buckets';

/**
 * Turns the LLM's `ReportSpec` into a plan the engine can execute.
 *
 * This is the seam where model output becomes app behaviour, and therefore the
 * seam where it gets **validated** — the same principle `SpecCompilerService`
 * applies to filters, applied to the report's shape. A section naming a field
 * the entity does not have, a chart summing a dimension, a line chart over
 * nominal categories: each is caught here, with a reason the user can read,
 * rather than reaching a template as an empty frame or a confident lie.
 *
 * Two rules govern what happens to a bad clause:
 *
 * - **Drop** when the section cannot mean anything (unknown field, no items).
 * - **Coerce** when the intent is clear but the form is wrong (a line chart
 *   over sites is a bar chart), and SAY SO in `omitted`. Dropping a chart the
 *   user asked for teaches them nothing; drawing it silently reshaped teaches
 *   them something false.
 *
 * Pure and dependency-free, so the whole vocabulary is unit-testable without a
 * TestBed or a cube.
 */

export interface PlannedReport {
  /** Sections that survived validation, in the order the model asked for. */
  sections: ReportSection[];
  /** Reasons for everything that did not. Rendered, never swallowed. */
  omitted: string[];
  /**
   * Whether any section needs the folded cube. Counts alone never do — a
   * `$count` is exact and free at 11M rows, so a count-only report skips the
   * fold entirely.
   */
  needsCube: boolean;
}

const CHART_TYPES: readonly ReportChartType[] = ['bar', 'column', 'line', 'area', 'donut'];
const GRAINS: readonly TimeGrain[] = ['auto', 'day', 'week', 'month', 'quarter', 'year'];
const AGGREGATIONS = ['count', 'sum', 'avg', 'distinctCount'] as const;
const CHART_AGGREGATIONS = ['count', 'sum', 'avg'] as const;
const FORMATS: readonly ValueFormat[] = ['integer', 'quantity', 'currency', 'percent', 'date', 'text'];

/** Charts that plot an ordered axis. Meaningless over nominal categories. */
const TIME_CHARTS: readonly ReportChartType[] = ['line', 'area'];

/** How many rows a ranking shows before it stops being a ranking. */
const MAX_RANK_ROWS = 20;

export function planReport(spec: ReportSpec, source: AnalystSource): PlannedReport {
  const fields = new Map(source.fields.map((f) => [f.key, f]));
  const omitted: string[] = [];
  const sections: ReportSection[] = [];

  for (const raw of sectionsOf(spec)) {
    const planned = planSection(raw, fields, source, omitted);
    if (planned) sections.push(planned);
  }

  return { sections, omitted, needsCube: sections.some(needsCube) };
}

/**
 * The spec's body, whichever shape it arrived in.
 *
 * `sections` is the current contract. The `kpis`/`charts`/`table` triple is the
 * original fixed layout, still honoured so a spec written before this change —
 * or echoed back by a model recalling the older tool schema — still renders. It
 * maps onto exactly the layout it used to produce: stats, then charts, then the
 * detail table.
 */
function sectionsOf(spec: ReportSpec): unknown[] {
  if (Array.isArray(spec.sections) && spec.sections.length) return spec.sections;

  const legacy: ReportSection[] = [];
  if (spec.kpis?.length) legacy.push({ type: 'metrics', items: spec.kpis });
  for (const chart of spec.charts ?? []) {
    legacy.push({
      type: 'chart',
      title: chart.title,
      chartType: chart.type,
      groupBy: chart.groupBy,
      agg: chart.agg,
      valueField: chart.valueField,
      topN: chart.topN,
    });
  }
  if (spec.table?.columns?.length) legacy.push({ type: 'table', columns: spec.table.columns });
  return legacy;
}

function needsCube(section: ReportSection): boolean {
  switch (section.type) {
    case 'metrics':
      // A count reads `@odata.count`; anything else has to be totalled.
      return section.items.some((k) => k.agg !== 'count');
    case 'chart':
    case 'ranking':
      // Even a count chart needs the GROUP BY, which only the cube has.
      return true;
    case 'comparison':
      // Even a count comparison needs the cube's per-day buckets to cut windows.
      return true;
    default:
      return false;
  }
}

// ── Per-section validation ─────────────────────────────────────────────────

function planSection(
  raw: unknown,
  fields: Map<string, FieldMeta>,
  source: AnalystSource,
  omitted: string[],
): ReportSection | null {
  if (!raw || typeof raw !== 'object') return null;
  const section = raw as Record<string, unknown>;

  switch (section['type']) {
    case 'metrics':
      return planMetrics(section, fields, omitted);
    case 'chart':
      return planChart(section, fields, omitted);
    case 'comparison':
      return planComparison(section, fields, source, omitted);
    case 'ranking':
      return planRanking(section, fields, omitted);
    case 'table':
      return planTable(section, fields, omitted);
    case 'text':
      return planText(section);
    case 'insights':
    case 'recommendations':
      return planList(section);
    default:
      omitted.push(`Unsupported section type “${String(section['type'])}”.`);
      return null;
  }
}

function planMetrics(
  section: Record<string, unknown>,
  fields: Map<string, FieldMeta>,
  omitted: string[],
): MetricsSectionSpec | null {
  const items = asArray(section['items'])
    .map((item) => planKpi(item, fields, omitted))
    .filter((k): k is KpiSpec => k !== null);

  if (!items.length) return null;
  return { type: 'metrics', title: str(section['title']), items };
}

/**
 * One headline figure.
 *
 * The aggregation determines what kind of field is legal, and getting it wrong
 * is not a style question: summing a customer account number produces a
 * confident, meaningless total, which is precisely the failure this whole
 * layer exists to prevent.
 */
function planKpi(
  raw: unknown,
  fields: Map<string, FieldMeta>,
  omitted: string[],
): KpiSpec | null {
  if (!raw || typeof raw !== 'object') return null;
  const item = raw as Record<string, unknown>;

  const label = str(item['label']);
  const agg = oneOf(item['agg'], AGGREGATIONS);
  if (!label || !agg) return null;

  if (agg === 'count') {
    return { label, agg, format: format(item['format']) ?? 'integer' };
  }

  const field = str(item['field']);
  const meta = field ? fields.get(field) : undefined;
  if (!meta) {
    omitted.push(`“${label}” asks for ${agg} of an unknown field “${field ?? '—'}”.`);
    return null;
  }

  if ((agg === 'sum' || agg === 'avg') && !meta.measure) {
    omitted.push(`“${label}”: ${meta.label} is not a measure, so it cannot be ${agg === 'sum' ? 'summed' : 'averaged'}.`);
    return null;
  }

  if (agg === 'distinctCount' && !meta.dimension && meta.type !== 'date') {
    omitted.push(`“${label}”: ${meta.label} is not grouped, so its distinct values are not counted.`);
    return null;
  }

  return { label, agg, field, format: format(item['format']) ?? meta.format ?? 'integer' };
}

function planChart(
  section: Record<string, unknown>,
  fields: Map<string, FieldMeta>,
  omitted: string[],
): ChartSectionSpec | null {
  const title = str(section['title']) ?? 'Breakdown';
  const groupBy = str(section['groupBy']);
  const meta = groupBy ? fields.get(groupBy) : undefined;

  if (!groupBy || !meta) {
    omitted.push(`Chart “${title}” groups by an unknown field “${groupBy ?? '—'}”.`);
    return null;
  }

  const isTime = meta.type === 'date';
  if (!isTime && !meta.dimension) {
    omitted.push(`Chart “${title}”: ${meta.label} is not a grouping field.`);
    return null;
  }

  const agg = oneOf(section['agg'], CHART_AGGREGATIONS) ?? 'count';
  const valueField = measureFor(agg, section['valueField'], fields, `Chart “${title}”`, omitted);
  if (valueField === false) return null;

  let chartType = oneOf(section['chartType'], CHART_TYPES) ?? (isTime ? 'line' : 'bar');

  // A line implies "these points are in order and the space between them means
  // something". Over sites or customers it means neither, so it becomes a bar
  // and the swap is declared rather than performed quietly.
  if (!isTime && TIME_CHARTS.includes(chartType)) {
    omitted.push(
      `Chart “${title}” was asked for as a ${chartType} chart, but ${meta.label} has no natural order — drawn as a bar chart instead.`,
    );
    chartType = 'bar';
  }

  // A donut divides a whole into parts. Months are not parts of a whole, they
  // are a sequence, and a 12-slice ring of them is unreadable either way.
  if (isTime && chartType === 'donut') {
    omitted.push(
      `Chart “${title}” was asked for as a donut over ${meta.label}, which is a date — drawn as a line chart instead.`,
    );
    chartType = 'line';
  }

  return {
    type: 'chart',
    title,
    chartType,
    groupBy,
    agg,
    valueField: valueField ?? undefined,
    topN: positiveInt(section['topN']),
    grain: isTime ? (oneOf(section['grain'], GRAINS) ?? 'auto') : undefined,
    note: str(section['note']),
  };
}

function planRanking(
  section: Record<string, unknown>,
  fields: Map<string, FieldMeta>,
  omitted: string[],
): RankingSectionSpec | null {
  const title = str(section['title']) ?? 'Ranking';
  const groupBy = str(section['groupBy']);
  const meta = groupBy ? fields.get(groupBy) : undefined;

  if (!groupBy || !meta?.dimension) {
    omitted.push(`Ranking “${title}” groups by “${groupBy ?? '—'}”, which is not a grouping field.`);
    return null;
  }

  const agg = oneOf(section['agg'], CHART_AGGREGATIONS) ?? 'count';
  const valueField = measureFor(agg, section['valueField'], fields, `Ranking “${title}”`, omitted);
  if (valueField === false) return null;

  const measure = valueField ? fields.get(valueField) : undefined;

  return {
    type: 'ranking',
    title,
    groupBy,
    agg,
    valueField: valueField ?? undefined,
    topN: Math.min(positiveInt(section['topN']) ?? 10, MAX_RANK_ROWS),
    chart: section['chart'] !== false,
    format: format(section['format']) ?? measure?.format ?? 'integer',
    note: str(section['note']),
  };
}

function planComparison(
  section: Record<string, unknown>,
  fields: Map<string, FieldMeta>,
  source: AnalystSource,
  omitted: string[],
): ComparisonSectionSpec | null {
  const title = str(section['title']) ?? 'Comparison';

  const named = str(section['dateField']);
  const dateField = named ?? source.dateField;
  const meta = dateField ? fields.get(dateField) : undefined;
  if (!meta || meta.type !== 'date') {
    omitted.push(`${title}: “${dateField ?? '—'}” is not a date field, so two periods cannot be cut from it.`);
    return null;
  }

  const current = planPeriod(section, 'current');
  const previous = planPeriod(section, 'previous');
  if (!current || !previous) {
    omitted.push(`${title}: both periods need a label and valid from/to dates (YYYY-MM-DD).`);
    return null;
  }

  const metrics = asArray(section['metrics'])
    .map((raw) => {
      const kpi = planKpi(raw, fields, omitted);
      if (!kpi) return null;
      if (kpi.agg === 'distinctCount') {
        // The cube stores per-day counts and sums, not the identity of the
        // values behind them — so a distinct count over an arbitrary window is
        // not something the folded data can answer.
        omitted.push(`${title}: “${kpi.label}” — distinct counts cannot be measured over a period.`);
        return null;
      }
      const higherIsBetter = (raw as Record<string, unknown>)['higherIsBetter'];
      return {
        ...kpi,
        higherIsBetter: typeof higherIsBetter === 'boolean' ? higherIsBetter : undefined,
      };
    })
    .filter((m): m is NonNullable<typeof m> => m !== null);

  if (!metrics.length) return null;

  return {
    type: 'comparison',
    title: str(section['title']),
    dateField,
    current,
    previous,
    metrics,
    note: str(section['note']),
  };
}

/**
 * One end of a comparison, from however the model wrote it.
 *
 * ## Two shapes
 *
 * The tool schema asks for six flat strings (`currentFrom`, `previousTo`, …).
 * That is deliberate: Gemini was observed dropping `from` from a nested
 * `{label, from, to}` object every time, despite the schema requiring it, while
 * flat scalars survive. The nested form is still read as a fallback so a spec
 * echoed back from an earlier session still renders.
 *
 * ## Two forgivenesses
 *
 * Both exist because a comparison is usually the ONLY section in its report, so
 * losing it to a formatting detail leaves the user with a blank sheet:
 *
 * - Partial dates expand. `2025-08` is August, `2025-Q2` is that quarter.
 * - A period given as a single SHORTHAND fills both ends: `from: "2025-08"`
 *   with no `to` is the whole of August. A single full DAY does not — one day
 *   is almost never what "this month" meant, and inventing a month around it
 *   would be a guess presented as a measurement.
 */
function planPeriod(section: Record<string, unknown>, which: 'current' | 'previous') {
  const nested = (
    section[which] && typeof section[which] === 'object' ? section[which] : {}
  ) as Record<string, unknown>;

  const rawFrom = section[`${which}From`] ?? nested['from'];
  const rawTo = section[`${which}To`] ?? nested['to'];

  let from = periodBound(rawFrom, 'start');
  let to = periodBound(rawTo, 'end');

  if (from && !to && isPeriodShorthand(rawFrom)) to = periodBound(rawFrom, 'end');
  if (to && !from && isPeriodShorthand(rawTo)) from = periodBound(rawTo, 'start');

  if (!from || !to) return null;
  // A reversed range matches nothing, and the intent is unambiguous.
  const [lo, hi] = from <= to ? [from, to] : [to, from];
  const label = str(section[`${which}Label`]) ?? str(nested['label']) ?? which;
  return { label, from: lo, to: hi };
}

function planTable(
  section: Record<string, unknown>,
  fields: Map<string, FieldMeta>,
  omitted: string[],
): TableSectionSpec | null {
  const all = asArray(section['columns']).map(String);
  const columns = all.filter((key) => fields.has(key));
  const unknown = all.filter((key) => !fields.has(key));

  if (unknown.length) {
    omitted.push(`Detail table: no such column${unknown.length > 1 ? 's' : ''} ${unknown.map((c) => `“${c}”`).join(', ')}.`);
  }
  if (!columns.length) return null;

  return { type: 'table', title: str(section['title']), columns };
}

function planText(section: Record<string, unknown>): TextSectionSpec | null {
  const body = str(section['body']);
  if (!body) return null;
  return { type: 'text', title: str(section['title']), body };
}

function planList(section: Record<string, unknown>): ListSectionSpec | null {
  // `points` is the contract. `items` is accepted as a fallback because it is
  // the obvious name and a model will occasionally reach for it; non-strings
  // are filtered either way, so a metrics-shaped payload here degrades to
  // nothing rather than to a list of "[object Object]".
  const points = [...asArray(section['points']), ...asArray(section['items'])]
    .map((i) => str(i))
    .filter((i): i is string => !!i);

  if (!points.length) return null;
  return {
    type: section['type'] === 'recommendations' ? 'recommendations' : 'insights',
    title: str(section['title']),
    points,
  };
}

// ── Small validators ───────────────────────────────────────────────────────

/**
 * The measure a non-count aggregation needs.
 *
 * Returns `null` for `count` (which needs none), the field key when it is a
 * real measure, and `false` when the section must be dropped — three outcomes,
 * so the caller cannot confuse "no measure required" with "measure invalid".
 */
function measureFor(
  agg: 'count' | 'sum' | 'avg',
  raw: unknown,
  fields: Map<string, FieldMeta>,
  what: string,
  omitted: string[],
): string | null | false {
  if (agg === 'count') return null;

  const key = str(raw);
  const meta = key ? fields.get(key) : undefined;
  if (!meta) {
    omitted.push(`${what} asks to ${agg} an unknown field “${key ?? '—'}”.`);
    return false;
  }
  if (!meta.measure) {
    omitted.push(`${what}: ${meta.label} is not a measure, so it cannot be totalled.`);
    return false;
  }
  return key!;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function str(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[]): T | undefined {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : undefined;
}

function format(value: unknown): ValueFormat | undefined {
  return oneOf(value, FORMATS);
}

function positiveInt(value: unknown): number | undefined {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : undefined;
}
