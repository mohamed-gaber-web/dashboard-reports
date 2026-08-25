/**
 * The chat-reports data contract — the shape the AI returns and the renderer
 * binds to.
 *
 * MUST stay in sync with `REPORT_TOOL.input_schema` in
 * `api/_lib/report-contract.js`. That schema is what the model fills in; this is
 * what the components consume. When one changes, change both.
 *
 * Data shape only — no logic lives here (NG-ARCH-02). Parsing an unknown value
 * into these types is `utils/report-payload.parser.ts`.
 */

/** Which layout the report leads with. */
export type TemplateType = 'kpi_overview' | 'detailed_analytics' | 'custom_report';

/** The chart forms the renderer can draw. Each maps to one SVG primitive. */
export type ChartType = 'bar' | 'line' | 'pie' | 'doughnut';

/** Discriminator for the `components[]` union. */
export type ComponentType = 'kpi_grid' | 'chart' | 'table' | 'html_document';

/** One metric tile inside a {@link KpiGridComponentSpec}. */
export interface KpiItem {
  label: string;
  /** Pre-formatted for display, e.g. `"$54,200"`. Rendered verbatim. */
  value: string;
  /** Optional signed delta, e.g. `"+14.5%"`. Absent when there is no basis for one. */
  change?: string;
  /**
   * Whether `change` is GOOD, not whether it is arithmetically positive —
   * falling costs are positive. Only meaningful when `change` is set.
   */
  isPositive?: boolean;
}

export interface KpiGridComponentSpec {
  type: 'kpi_grid';
  items: KpiItem[];
}

/** One series in a chart. `data` is always the same length as the chart's `labels`. */
export interface ChartDataset {
  label: string;
  data: number[];
}

export interface ChartComponentSpec {
  type: 'chart';
  chart_type: ChartType;
  title: string;
  /** The category axis. For pie/doughnut these are the slices. */
  labels: string[];
  /** One entry per series. pie/doughnut carry exactly one. */
  datasets: ChartDataset[];
}

export interface TableComponentSpec {
  type: 'table';
  title: string;
  headers: string[];
  /** Each row has exactly `headers.length` pre-formatted cells, in order. */
  rows: string[][];
}

/**
 * A whole report as one self-contained HTML fragment, authored by the model.
 *
 * ## Why this exists at all
 *
 * The other three components are a closed vocabulary the app renders: the model
 * chooses tiles, series and rows, and the app decides what they look like. The
 * Executive style inverts that — it asks for a designed document, with its own
 * type scale, its own grid, its own inline SVG charts and its own reading
 * direction. None of that can be expressed as `{type:'chart', labels, datasets}`,
 * and adding forty style knobs to the schema to approximate it would be worse
 * than the thing it replaces.
 *
 * ## Why this does NOT break the closed-set rule
 *
 * The rule is that an LLM-authored `type` must never select a component by
 * name — and it still cannot: this is one more arm of a union fixed at compile
 * time. What it carries is markup, and markup is not rendered into the
 * application's DOM. `HtmlDocumentComponent` puts it inside a fully-restricted
 * `<iframe sandbox>` — no scripts, opaque origin, no access to the parent
 * document, its cookies, its storage or its tokens. The frame is the trust
 * boundary; the sanitiser is not, which is why the CSS and the SVG survive.
 */
export interface HtmlDocumentComponentSpec {
  type: 'html_document';
  /**
   * The fragment. Body-level markup with an optional `<style>` and inline
   * `<svg>` — no `<html>`, `<head>`, `<body>` or `<script>`; the renderer
   * supplies the document around it, and the sandbox makes any script inert.
   */
  html: string;
  /** Names the document for the frame's accessible title and the export filename. */
  title?: string;
}

/** A node in the report body. Discriminated on `type` — the renderer switches on it. */
export type ReportComponent =
  | KpiGridComponentSpec
  | ChartComponentSpec
  | TableComponentSpec
  | HtmlDocumentComponentSpec;

/**
 * One complete AI reply.
 *
 * Every field is required and non-null by the time it reaches a component: the
 * parser fills defaults so no template has to guard for `undefined`.
 */
export interface ReportPayload {
  /** The chat bubble's prose. May be empty when the components say it all. */
  text_response: string;
  /** Quick-reply chips. Each is sent verbatim as the next user message. */
  suggested_actions: string[];
  template_type: TemplateType;
  components: ReportComponent[];
  /**
   * Parts of the reply that could not be rendered as sent, and what was done
   * about them — an uneven chart series trimmed, a table capped, an unsupported
   * component skipped.
   *
   * Surfaced in the UI rather than swallowed. Quietly dropping half a reply is
   * how a report ends up confidently wrong; the same reasoning drives
   * `ReportResult.omitted` in the AI Analyst.
   */
  dropped: string[];
}
