import { AnalystFilter } from '../../ai-analyst/models/analyst-source.model';
import { ModuleContext, ModuleField } from '../../ai-analyst/models/module-context.model';
import { DataContext } from '../../ai-analyst/services/data-context.service';

/**
 * Builds the Markdown context the model reasons over — the whole of what it is
 * told about the module and its data.
 *
 * ## Why Markdown, and why it is built HERE
 *
 * **Markdown** because a human has to be able to check it. The one thing this
 * prototype cannot verify automatically is whether a figure in a generated report
 * is real, so the next best thing is making "what was Claude actually given?"
 * legible at a glance. The Lab's inspector panel renders this exact string, so
 * the answer is one click away rather than reconstructed from a JSON blob in the
 * network tab.
 *
 * **Here** — in the browser, next to the data — because building it server-side
 * would mean two constructions of "what the model was told", and the day they
 * disagree is the day the prompt describes a filter that is no longer applied.
 * `api/_lib/report-lab-contract.js` embeds this string verbatim and adds nothing
 * to it.
 *
 * ## What is deliberately NOT in it
 *
 * The raw dataset. Only the schema, real aggregates over the current slice, and
 * at most five sample rows ever leave the browser — the same privacy property
 * every other AI screen in this app holds, and the reason an 11M-row module is
 * safe to point at a model at all. Also absent, by construction: the OData
 * entity, the host, the auth config and the base `$filter`, because
 * `ModuleContext` never carries them (see `module-context.adapter.ts`).
 *
 * Pure functions — no Angular, no I/O, no state. This is a boundary, and a
 * boundary is worth testing without a TestBed.
 */

/** Sections that would be empty are omitted rather than sent as headings with nothing under them. */
function section(heading: string, body: string | string[]): string[] {
  const lines = Array.isArray(body) ? body : [body];
  const content = lines.filter((l) => l.trim().length).join('\n');
  return content ? [`## ${heading}`, '', content, ''] : [];
}

function fence(label: string, value: unknown): string {
  return ['```' + label, JSON.stringify(value, null, 2), '```'].join('\n');
}

/**
 * One field, as one bullet.
 *
 * Role and aggregations are the load-bearing part: they are the difference
 * between "this column is numeric" and "this column may legitimately be
 * totalled". A record id is numeric and summing it is meaningless, which is why
 * the registry marks roles explicitly and this never infers one from the type.
 */
function describeField(field: ModuleField): string {
  const facts: string[] = [field.type, field.role];
  if (field.aggregations.length) facts.push(field.aggregations.join('/'));
  if (field.timeAxis) facts.push('time axis');
  if (field.currency) facts.push('currency code');

  const values = field.enumValues?.length
    ? ` Allowed values: ${field.enumValues.map((v) => `\`${v}\``).join(', ')}.`
    : '';

  return `- \`${field.name}\` — ${field.label} (${facts.join('; ')}).${values}`;
}

/**
 * The user's narrowing, as a sentence.
 *
 * Exported because the document footer says the same thing: a report that covers
 * three weeks must not be filed away as a report on the whole module, and the
 * exported copy is the one most likely to be read by someone who never saw the
 * screen.
 *
 * The upper bound is described as INCLUSIVE because that is what the date input
 * means to the person who typed it; `AnalystDataService` compiles it to the
 * shared `dateRange` helper's half-open `lt`, so the sentence is written to
 * match the user's intent rather than the operator.
 */
export function describeSlice(filter: AnalystFilter, module: ModuleContext | null): string {
  const parts: string[] = [];

  if (filter.from || filter.to) {
    const field = module?.timeAxis ? ` on \`${module.timeAxis}\`` : '';
    if (filter.from && filter.to) parts.push(`dates${field} from ${filter.from} to ${filter.to}`);
    else if (filter.from) parts.push(`dates${field} from ${filter.from} onwards`);
    else parts.push(`dates${field} up to ${filter.to}`);
  }

  if (filter.search) parts.push(`text search “${filter.search}”`);

  return parts.length ? parts.join(', ') : '';
}

export interface LabContextInput {
  /** What the module IS — fields, roles, how it can be narrowed, what it can compute. */
  module: ModuleContext;
  /** The real figures for the current slice. Aggregates, schema and ≤5 sample rows. */
  data: DataContext;
  /** What the user has narrowed to. */
  filter: AnalystFilter;
  /** Earliest and latest value of the module's date field, when it has one. */
  dateRange?: { field: string; min?: string; max?: string };
}

/**
 * Everything the model is told, as one Markdown document.
 *
 * The order is the order it should be read in: what the module is, what has been
 * filtered out, what can and cannot be computed over what is left, then the
 * figures themselves. The coverage section sits BEFORE the aggregates
 * deliberately — "there are no sums in what follows" has to be read before the
 * summary, not after it.
 */
export function buildLabContext(input: LabContextInput): string {
  const { module, data, filter, dateRange } = input;

  const dimensions = module.fields.filter((f) => f.role === 'dimension');
  const measures = module.fields.filter((f) => f.role === 'measure');
  const attributes = module.fields.filter((f) => f.role === 'attribute');

  const slice = describeSlice(filter, module);
  const exact = data.coverage === 'exact';

  const coverage = [
    `- **${data.rowCount.toLocaleString()} rows** match the current filter. This count is exact.`,
    exact
      ? '- Totals are **exact**: every matching row was read and folded, so the sums, averages,' +
        ' distinct counts and per-group figures below cover the whole slice.'
      : '- Totals are **NOT AVAILABLE**: this slice is too large to total, so the summary below' +
        ' contains counts and date bounds only. There are no sums, no averages, no per-group' +
        ' figures. Do not produce any — build the report from counts, and say in it that a' +
        ' narrower slice (a date range, or a search term) is needed for totals.',
    dateRange?.min || dateRange?.max
      ? `- The data’s own date range on \`${dateRange.field}\` runs ${dateRange.min ?? '?'} → ${dateRange.max ?? '?'}.`
      : '',
    // Observed live: given an `Amount` column and no currency, a model labelled
    // every figure "KWD" — a plausible-looking unit that appears nowhere in the
    // data. A monetary total with the wrong currency on it is worse than one with
    // none, so the module's actual answer is stated rather than left to inference.
    module.currencyField
      ? `- Amounts carry a currency code in \`${module.currencyField}\`. Use the codes that appear` +
        ' in the aggregates and the sample rows; never substitute a different one.'
      : '- This module has NO currency column. Write monetary figures as bare numbers with the' +
        ' field’s label. Do NOT attach a currency name, code or symbol to any figure — you have' +
        ' not been told what currency this is, and guessing one is inventing data.',
    module.capabilities.join
      ? ''
      : '- This module is a SINGLE entity and cannot be joined to another. A question needing a' +
        ' column that is not listed above cannot be answered from here — say so rather than' +
        ' approximating it.',
  ];

  return [
    '# AI Report Context',
    '',
    ...section('Module', module.moduleName),
    ...section('Description', module.description ?? 'No description was registered for this module.'),
    ...section('Available Fields', [
      measures.length ? '**Measures** — these may be summed or averaged:' : '',
      ...measures.map(describeField),
      measures.length ? '' : '',
      dimensions.length ? '**Dimensions** — these may be grouped by:' : '',
      ...dimensions.map(describeField),
      dimensions.length ? '' : '',
      attributes.length ? '**Attributes** — readable, but too high-cardinality to group and meaningless to total:' : '',
      ...attributes.map(describeField),
    ]),
    ...section(
      'Current Filters',
      slice
        ? [
            `The user has narrowed the data to: **${slice}**.`,
            '',
            'Every figure below covers ONLY those rows. Say so when you state a total — “in the' +
              ' selected period”, “for the matching rows”. Never describe these figures as the' +
              ' whole module. Earlier turns in this conversation may have been answered under a' +
              ' different filter; never reuse a figure from the history.',
          ]
        : 'None — the figures below cover the whole module.',
    ),
    ...section('Data Coverage', coverage),
    ...section(
      'Aggregates',
      [
        'Real figures, computed in the browser from Dynamics 365 over the rows described above.',
        'Keys read: `sum_<field>` and `avg_<field>` are totals over the whole slice;' +
          ' `distinct_<field>` is the number of distinct values; `top_<field>` are the largest' +
          ' groups of a dimension BY ROW COUNT (not by any measure); `monthly_<date field>` is' +
          ' the month-by-month shape, which is where to look for when something changed.',
        '',
        fence('json', data.summary),
      ].join('\n'),
    ),
    ...section(
      'Sample Rows',
      [
        `Illustrative only — ${data.sample.length} rows out of ${data.rowCount.toLocaleString()}.`,
        'Never total them, never rank from them, never present them as the dataset. They are here' +
          ' so you can see the SHAPE and the formatting of real values.',
        '',
        fence('json', data.sample),
      ].join('\n'),
    ),
  ]
    .join('\n')
    .trimEnd();
}
