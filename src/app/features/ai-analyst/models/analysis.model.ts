/**
 * The written half of a report.
 *
 * `ReportSpec` describes what to compute; this describes what it means. The model
 * writes it (via the `write_analysis` tool), the app renders it above the report
 * and uses it to open an exported document.
 *
 * Prose only, by construction — there is no field here that could carry a figure
 * the app did not compute itself. That is the point: the narrative can be wrong
 * about emphasis, but it cannot invent a total.
 */
export interface AnalysisFinding {
  title: string;
  detail: string;
}

export interface Analysis {
  /** One-line takeaway; becomes the exported document's title. */
  headline: string;
  /** Two to four sentences of executive summary. */
  summary: string;
  /** The things worth knowing, most important first. */
  findings: AnalysisFinding[];
  /** Optional suggested actions. */
  recommendations?: string[];
}

/** Formats an exported document can take. */
export type DocumentFormat = 'pdf' | 'html';
