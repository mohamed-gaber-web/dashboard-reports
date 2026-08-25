import { AnalystSource } from '../../ai-analyst/models/analyst-source.model';
import { FieldMeta } from '../../ai-analyst/models/field-meta.model';
import { isPeriodShorthand, periodBound } from '../../ai-analyst/services/time-buckets';
import {
  ChartKind,
  ChartSection,
  ClaimKind,
  ComparisonSection,
  DEFAULT_DENSITY,
  DEFAULT_LAYOUT,
  FilterClause,
  FilterOperator,
  InsightPoint,
  InsightsSection,
  MetricDefinition,
  MetricsSection,
  Period,
  RankingSection,
  RecommendationPoint,
  RecommendationPriority,
  RecommendationsSection,
  ReportDefinition,
  ReportDensity,
  ReportLayout,
  ReportSection,
  SeriesAggregation,
  TableSection,
  TextSection,
  TimeGrain,
  TimelineSection,
  ValueFormatName,
} from '../models/report-definition.model';

/**
 * Validates raw model output into a {@link ReportDefinition} the composer can
 * execute.
 *
 * **This is the trust boundary.** Everything upstream of it is text produced by
 * a language model; everything downstream of it is treated as app behaviour. A
 * section naming a field the module does not have, a chart summing a customer
 * account number, a line chart over site names, a timeline over a text column —
 * each is caught here, with a reason a human can read, rather than reaching a
 * renderer as an empty frame or a confident lie.
 *
 * Two rules decide what happens to a bad clause:
 *
 * - **Drop** it when the section cannot mean anything (unknown field, no items,
 *   a measure that is not a measure).
 * - **Coerce** it when the intent is unmistakable but the form is wrong (a line
 *   chart over sites is a bar chart), and SAY SO.
 *
 * Either way it lands in `issues`, which the report renders. Silently dropping a
 * requested chart teaches the user nothing; silently drawing a reshaped one
 * teaches them something false.
 *
 * Pure and dependency-free on purpose: the whole vocabulary is unit-testable
 * without a TestBed, an HTTP call or a folded cube.
 */

export interface ValidationResult {
  /** Null when there is nothing renderable at all — no title, or no section survived. */
  definition: ReportDefinition | null;
  /** Everything dropped or rewritten, in the order it was found. */
  issues: string[];
  /**
   * Whether any surviving section needs the folded cube. Counts alone never do:
   * `$count` is exact and free even at 11M rows, so a count-only report skips
   * the fold entirely and answers instantly.
   */
  needsTotals: boolean;
}

const DENSITIES: readonly ReportDensity[] = ['minimal', 'standard', 'detailed'];
const LAYOUTS: readonly ReportLayout[] = ['executive', 'analytical', 'operational'];
const CHART_KINDS: readonly ChartKind[] = ['line', 'area', 'bar', 'column', 'pie', 'donut'];
const GRAINS: readonly TimeGrain[] = ['auto', 'day', 'week', 'month', 'quarter', 'year'];
const METRIC_AGGS = ['count', 'sum', 'avg', 'distinctCount'] as const;
const SERIES_AGGS: readonly SeriesAggregation[] = ['count', 'sum', 'avg'];
const FORMATS: readonly ValueFormatName[] = ['integer', 'quantity', 'currency', 'percent'];
const OPERATORS: readonly FilterOperator[] = ['eq', 'neq', 'gt', 'lt', 'gte', 'lte', 'contains'];
const PRIORITIES: readonly RecommendationPriority[] = ['high', 'medium', 'low'];

/** Marks that plot an ordered axis. Meaningless over nominal categories. */
const ORDERED_MARKS: readonly ChartKind[] = ['line', 'area'];
/** Marks that divide one whole into parts. Meaningless over a date sequence. */
const PART_MARKS: readonly ChartKind[] = ['pie', 'donut'];

/** Past this a pie is a ring of unreadable slivers and a legend nobody reads. */
const MAX_SLICES = 6;
/** Past this a ranking has stopped being a ranking and become a table. */
const MAX_RANK_ROWS = 25;

export function validateDefinition(raw: unknown, source: AnalystSource): ValidationResult {
  const issues: string[] = [];
  const fields = new Map(source.fields.map((f) => [f.key, f]));

  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { definition: null, issues: ['The model did not return a report.'], needsTotals: false };
  }
  const input = raw as Record<string, unknown>;

  const title = str(input['title']);
  if (!title) {
    return {
      definition: null,
      issues: ['The report had no title, so there was nothing to render.'],
      needsTotals: false,
    };
  }

  const sections: ReportSection[] = [];
  for (const candidate of asArray(input['sections'])) {
    const section = validateSection(candidate, fields, source, issues);
    if (section) sections.push(section);
  }

  // Top-level insights/recommendations become trailing sections. A model that
  // puts them here rather than in `sections` is not wrong about the report — it
  // is wrong about where the field lives — and normalising keeps exactly one
  // render path instead of two that have to be kept in step.
  const topInsights = validateInsightPoints(input['insights']);
  if (topInsights.length && !sections.some((s) => s.type === 'insights')) {
    sections.push({ type: 'insights', points: topInsights });
  }
  const topActions = validateRecommendationPoints(input['recommendations']);
  if (topActions.length && !sections.some((s) => s.type === 'recommendations')) {
    sections.push({ type: 'recommendations', points: topActions });
  }

  if (!sections.length) {
    issues.push('No section of this report could be built from the module’s fields.');
  }

  return {
    definition: {
      title,
      subtitle: str(input['subtitle']),
      summary: str(input['summary']),
      density: oneOf(input['density'], DENSITIES) ?? DEFAULT_DENSITY,
      layout: oneOf(input['layout'], LAYOUTS) ?? DEFAULT_LAYOUT,
      filters: validateFilters(input['filters']),
      sections,
    },
    issues,
    needsTotals: sections.some(needsTotals),
  };
}

/**
 * Whether a section can only be answered from the folded cube.
 *
 * A count reads `@odata.count`, which D365 gives us exactly and for free at any
 * scale. Everything else — a sum, a group-by, a period window — requires having
 * read every matching row.
 */
function needsTotals(section: ReportSection): boolean {
  switch (section.type) {
    case 'metrics':
      return section.items.some((m) => m.agg !== 'count');
    case 'chart':
    case 'ranking':
      // Even a count chart needs the GROUP BY, which only the cube holds.
      return true;
    case 'comparison':
    case 'timeline':
      // Even a count needs the cube's per-day buckets to cut windows from.
      return true;
    default:
      return false;
  }
}

// ── Sections ────────────────────────────────────────────────────────────────

function validateSection(
  raw: unknown,
  fields: Map<string, FieldMeta>,
  source: AnalystSource,
  issues: string[],
): ReportSection | null {
  if (!raw || typeof raw !== 'object') return null;
  const s = raw as Record<string, unknown>;

  switch (s['type']) {
    case 'metrics':
      return validateMetrics(s, fields, issues);
    case 'chart':
      return validateChart(s, fields, issues);
    case 'table':
      return validateTable(s, fields, issues);
    case 'ranking':
      return validateRanking(s, fields, issues);
    case 'comparison':
      return validateComparison(s, fields, source, issues);
    case 'timeline':
      return validateTimeline(s, fields, source, issues);
    case 'text':
      return validateText(s);
    case 'insights':
      return validateInsights(s);
    case 'recommendations':
      return validateRecommendations(s);
    default:
      issues.push(`Unsupported section type “${String(s['type'])}” — left out.`);
      return null;
  }
}

function validateMetrics(
  s: Record<string, unknown>,
  fields: Map<string, FieldMeta>,
  issues: string[],
): MetricsSection | null {
  const items = asArray(s['items'])
    .map((item) => validateMetric(item, fields, issues))
    .filter((m): m is MetricDefinition => m !== null);

  if (!items.length) return null;
  return { type: 'metrics', title: str(s['title']), note: str(s['note']), items };
}

/**
 * One figure.
 *
 * The aggregation decides what kind of field is legal, and getting it wrong is
 * not a matter of taste: summing a customer account number produces a confident,
 * meaningless total, which is precisely the failure this layer exists to stop.
 */
function validateMetric(
  raw: unknown,
  fields: Map<string, FieldMeta>,
  issues: string[],
): MetricDefinition | null {
  if (!raw || typeof raw !== 'object') return null;
  const m = raw as Record<string, unknown>;

  const label = str(m['label']);
  const agg = oneOf(m['agg'], METRIC_AGGS);
  if (!label || !agg) return null;

  const goodDirection = m['goodDirection'] === 'up' || m['goodDirection'] === 'down'
    ? (m['goodDirection'] as 'up' | 'down')
    : undefined;
  const note = str(m['note']);

  if (agg === 'count') {
    return { label, agg, format: oneOf(m['format'], FORMATS) ?? 'integer', goodDirection, note };
  }

  const field = str(m['field']);
  const meta = field ? fields.get(field) : undefined;
  if (!meta) {
    issues.push(`“${label}” asks for the ${agg} of an unknown field “${field ?? '—'}”.`);
    return null;
  }

  if ((agg === 'sum' || agg === 'avg') && !meta.measure) {
    issues.push(
      `“${label}”: ${meta.label} is not a measure, so it cannot be ${agg === 'sum' ? 'summed' : 'averaged'}.`,
    );
    return null;
  }

  if (agg === 'distinctCount' && !meta.dimension && meta.type !== 'date') {
    issues.push(`“${label}”: ${meta.label} is not grouped, so its distinct values are not counted.`);
    return null;
  }

  return {
    label,
    agg,
    field,
    format: oneOf(m['format'], FORMATS) ?? asFormat(meta.format) ?? 'integer',
    goodDirection,
    note,
  };
}

function validateChart(
  s: Record<string, unknown>,
  fields: Map<string, FieldMeta>,
  issues: string[],
): ChartSection | null {
  const title = str(s['title']) ?? 'Breakdown';
  const groupBy = str(s['groupBy']);
  const meta = groupBy ? fields.get(groupBy) : undefined;

  if (!groupBy || !meta) {
    issues.push(`Chart “${title}” groups by an unknown field “${groupBy ?? '—'}”.`);
    return null;
  }

  const isTime = meta.type === 'date';
  if (!isTime && !meta.dimension) {
    issues.push(`Chart “${title}”: ${meta.label} is not a grouping field, so it cannot be charted.`);
    return null;
  }

  const agg = oneOf(s['agg'], SERIES_AGGS) ?? 'count';
  const valueField = measureFor(agg, s['valueField'], fields, `Chart “${title}”`, issues);
  if (valueField === false) return null;

  let chartType = oneOf(s['chartType'], CHART_KINDS) ?? (isTime ? 'line' : 'bar');

  // A line says "these points are in order and the gaps between them mean
  // something". Over customers it says neither, so it becomes a bar — and the
  // swap is declared rather than performed quietly.
  if (!isTime && ORDERED_MARKS.includes(chartType)) {
    issues.push(
      `Chart “${title}” was asked for as a ${chartType} chart, but ${meta.label} has no natural order — drawn as a bar chart instead.`,
    );
    chartType = 'bar';
  }

  // A pie divides a whole into parts. Months are not parts of a whole, they are
  // a sequence, and a 12-slice ring of them is unreadable either way.
  if (isTime && PART_MARKS.includes(chartType)) {
    issues.push(
      `Chart “${title}” was asked for as a ${chartType} over ${meta.label}, which is a date — drawn as a line chart instead.`,
    );
    chartType = 'line';
  }

  return {
    type: 'chart',
    title,
    note: str(s['note']),
    chartType,
    groupBy,
    agg,
    valueField: valueField ?? undefined,
    topN: positiveInt(s['topN']),
    grain: isTime ? (oneOf(s['grain'], GRAINS) ?? 'auto') : undefined,
  };
}

function validateTable(
  s: Record<string, unknown>,
  fields: Map<string, FieldMeta>,
  issues: string[],
): TableSection | null {
  const asked = asArray(s['columns']).map(String);
  const columns = asked.filter((key) => fields.has(key));
  const unknown = asked.filter((key) => !fields.has(key));

  if (unknown.length) {
    issues.push(
      `Detail table: no such column${unknown.length > 1 ? 's' : ''} ${unknown.map((c) => `“${c}”`).join(', ')}.`,
    );
  }
  if (!columns.length) return null;

  return { type: 'table', title: str(s['title']), note: str(s['note']), columns };
}

function validateRanking(
  s: Record<string, unknown>,
  fields: Map<string, FieldMeta>,
  issues: string[],
): RankingSection | null {
  const title = str(s['title']) ?? 'Ranking';
  const groupBy = str(s['groupBy']);
  const meta = groupBy ? fields.get(groupBy) : undefined;

  if (!groupBy || !meta?.dimension) {
    issues.push(`Ranking “${title}” groups by “${groupBy ?? '—'}”, which is not a grouping field.`);
    return null;
  }

  const agg = oneOf(s['agg'], SERIES_AGGS) ?? 'count';
  const valueField = measureFor(agg, s['valueField'], fields, `Ranking “${title}”`, issues);
  if (valueField === false) return null;

  const measure = valueField ? fields.get(valueField) : undefined;

  return {
    type: 'ranking',
    title,
    note: str(s['note']),
    groupBy,
    agg,
    valueField: valueField ?? undefined,
    topN: Math.min(positiveInt(s['topN']) ?? 10, MAX_RANK_ROWS),
    format: oneOf(s['format'], FORMATS) ?? asFormat(measure?.format) ?? 'integer',
    showBars: s['showBars'] !== false,
  };
}

function validateComparison(
  s: Record<string, unknown>,
  fields: Map<string, FieldMeta>,
  source: AnalystSource,
  issues: string[],
): ComparisonSection | null {
  const title = str(s['title']) ?? 'Comparison';

  const dateField = str(s['dateField']) ?? source.dateField;
  const meta = dateField ? fields.get(dateField) : undefined;
  if (!meta || meta.type !== 'date') {
    issues.push(
      `${title}: “${dateField ?? '—'}” is not a date field, so two periods cannot be cut from it.`,
    );
    return null;
  }

  const current = readPeriod(s, 'current');
  const previous = readPeriod(s, 'previous');
  if (!current || !previous) {
    issues.push(`${title}: both periods need a label and valid from/to dates (YYYY-MM-DD).`);
    return null;
  }

  const metrics = asArray(s['metrics'])
    .map((raw) => {
      const metric = validateMetric(raw, fields, issues);
      if (!metric) return null;
      if (metric.agg === 'distinctCount') {
        // The cube stores per-day counts and sums, not the identity of the values
        // behind them, so a distinct count over an arbitrary window is not
        // something the folded data can answer.
        issues.push(`${title}: “${metric.label}” — distinct counts cannot be measured over a period.`);
        return null;
      }
      return metric;
    })
    .filter((m): m is MetricDefinition => m !== null);

  if (!metrics.length) return null;

  return {
    type: 'comparison',
    title: str(s['title']),
    note: str(s['note']),
    dateField,
    current,
    previous,
    metrics,
  };
}

/**
 * One end of a comparison, from however the model wrote it.
 *
 * The tool schema asks for six flat strings (`currentFrom`, `previousTo`, …)
 * because a nested `{label, from, to}` loses `from` on Gemini — measured, not
 * assumed. The nested form is still read as a fallback so a definition echoed
 * back from an older session keeps working.
 *
 * Two forgivenesses, both because a comparison is usually the ONLY section in
 * its report, so losing it to a formatting detail leaves a blank sheet:
 * partial dates expand (`2025-08` is August, `2025-Q2` is that quarter), and a
 * period given as a single SHORTHAND fills both ends. A single full DAY does
 * not — one day is almost never what "this month" meant, and inventing a month
 * around it would be a guess presented as a measurement.
 */
function readPeriod(s: Record<string, unknown>, which: 'current' | 'previous'): Period | null {
  const nested = (s[which] && typeof s[which] === 'object' ? s[which] : {}) as Record<string, unknown>;

  const rawFrom = s[`${which}From`] ?? nested['from'];
  const rawTo = s[`${which}To`] ?? nested['to'];

  let from = periodBound(rawFrom, 'start');
  let to = periodBound(rawTo, 'end');

  if (from && !to && isPeriodShorthand(rawFrom)) to = periodBound(rawFrom, 'end');
  if (to && !from && isPeriodShorthand(rawTo)) from = periodBound(rawTo, 'start');

  if (!from || !to) return null;
  // A reversed range matches nothing and the intent is unambiguous.
  const [lo, hi] = from <= to ? [from, to] : [to, from];
  return { label: str(s[`${which}Label`]) ?? str(nested['label']) ?? which, from: lo, to: hi };
}

function validateTimeline(
  s: Record<string, unknown>,
  fields: Map<string, FieldMeta>,
  source: AnalystSource,
  issues: string[],
): TimelineSection | null {
  const title = str(s['title']) ?? 'Timeline';
  // `dateField` is the contract, but `groupBy` is the obvious name if you have
  // just written three charts, so it is accepted too.
  const dateField = str(s['dateField']) ?? str(s['groupBy']) ?? source.dateField;
  const meta = dateField ? fields.get(dateField) : undefined;

  if (!meta || meta.type !== 'date') {
    issues.push(
      `Timeline “${title}”: “${dateField ?? '—'}” is not a date field, so there are no periods to walk.`,
    );
    return null;
  }

  const agg = oneOf(s['agg'], SERIES_AGGS) ?? 'count';
  const valueField = measureFor(agg, s['valueField'], fields, `Timeline “${title}”`, issues);
  if (valueField === false) return null;

  const measure = valueField ? fields.get(valueField) : undefined;

  return {
    type: 'timeline',
    title,
    note: str(s['note']),
    dateField: dateField!,
    agg,
    valueField: valueField ?? undefined,
    grain: oneOf(s['grain'], GRAINS) ?? 'auto',
    format: oneOf(s['format'], FORMATS) ?? asFormat(measure?.format) ?? 'integer',
  };
}

function validateText(s: Record<string, unknown>): TextSection | null {
  const body = str(s['body']) ?? str(s['text']);
  if (!body) return null;
  return { type: 'text', title: str(s['title']), body };
}

function validateInsights(s: Record<string, unknown>): InsightsSection | null {
  const points = validateInsightPoints(s['points'] ?? s['items']);
  if (!points.length) return null;
  return { type: 'insights', title: str(s['title']), points };
}

function validateRecommendations(s: Record<string, unknown>): RecommendationsSection | null {
  const points = validateRecommendationPoints(s['points'] ?? s['items']);
  if (!points.length) return null;
  return { type: 'recommendations', title: str(s['title']), points };
}

/**
 * Insight bullets.
 *
 * A bare string is accepted and lands as an OBSERVATION, because that is the
 * weaker of the two claims — defaulting an unlabelled bullet to
 * "interpretation" would understate real findings, and defaulting it to
 * observation only risks a model's opinion being shown one notch too plainly,
 * which the recommendation caveat and the section heading both temper.
 */
function validateInsightPoints(raw: unknown): InsightPoint[] {
  return asArray(raw)
    .map((item): InsightPoint | null => {
      if (typeof item === 'string') {
        const text = str(item);
        return text ? { text, kind: 'observation' } : null;
      }
      if (!item || typeof item !== 'object') return null;
      const o = item as Record<string, unknown>;
      const text = str(o['text']) ?? str(o['point']) ?? str(o['detail']);
      if (!text) return null;
      const kind: ClaimKind = o['kind'] === 'interpretation' ? 'interpretation' : 'observation';
      return { text, kind };
    })
    .filter((p): p is InsightPoint => p !== null);
}

function validateRecommendationPoints(raw: unknown): RecommendationPoint[] {
  return asArray(raw)
    .map((item): RecommendationPoint | null => {
      if (typeof item === 'string') {
        const text = str(item);
        return text ? { text } : null;
      }
      if (!item || typeof item !== 'object') return null;
      const o = item as Record<string, unknown>;
      const text = str(o['text']) ?? str(o['point']) ?? str(o['action']);
      if (!text) return null;
      return {
        text,
        priority: oneOf(o['priority'], PRIORITIES),
        rationale: str(o['rationale']),
      };
    })
    .filter((p): p is RecommendationPoint => p !== null);
}

/**
 * Filter clauses, shape-checked only.
 *
 * Whether a field exists, whether an enum member is real and how to spell the
 * literal for D365 is `SpecCompilerService`'s job — it already owns that
 * knowledge for the AI Analyst and rejects with reasons. Re-implementing it
 * here would be a second, divergent copy of the same rules.
 */
function validateFilters(raw: unknown): FilterClause[] | undefined {
  const clauses = asArray(raw)
    .map((item): FilterClause | null => {
      if (!item || typeof item !== 'object') return null;
      const c = item as Record<string, unknown>;
      const field = str(c['field']);
      const op = oneOf(c['op'], OPERATORS);
      const value = c['value'];
      if (!field || !op) return null;
      if (typeof value !== 'string' && typeof value !== 'number') return null;
      return { field, op, value };
    })
    .filter((c): c is FilterClause => c !== null);

  return clauses.length ? clauses : undefined;
}

// ── Small validators ────────────────────────────────────────────────────────

/**
 * The measure a non-count aggregation needs.
 *
 * Three outcomes, so a caller cannot confuse "no measure required" with "measure
 * invalid": `null` for `count`, the field key when it is a real measure, and
 * `false` when the section has to be dropped.
 */
function measureFor(
  agg: SeriesAggregation,
  raw: unknown,
  fields: Map<string, FieldMeta>,
  what: string,
  issues: string[],
): string | null | false {
  if (agg === 'count') return null;

  const key = str(raw);
  const meta = key ? fields.get(key) : undefined;
  if (!meta) {
    issues.push(`${what} asks to ${agg} an unknown field “${key ?? '—'}”.`);
    return false;
  }
  if (!meta.measure) {
    issues.push(`${what}: ${meta.label} is not a measure, so it cannot be totalled.`);
    return false;
  }
  return key!;
}

/** How many slices a part-of-whole chart may show before it stops being readable. */
export function sliceCapFor(kind: ChartKind): number {
  return PART_MARKS.includes(kind) ? MAX_SLICES : 12;
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

/**
 * A `FieldMeta.format` narrowed to the four a figure can be written in.
 *
 * `FieldMeta` also carries `date` and `text`, which are cell formats — a KPI
 * rendered as a date is not a thing, so those fall through to the caller's
 * default rather than being passed on.
 */
function asFormat(value: unknown): ValueFormatName | undefined {
  return oneOf(value, FORMATS);
}

function positiveInt(value: unknown): number | undefined {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : undefined;
}
