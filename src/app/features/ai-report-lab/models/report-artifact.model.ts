/**
 * The AI Report Lab's data shapes.
 *
 * ## What this prototype is
 *
 * An ISOLATED experiment, reachable at `/admin/ai-report-lab`, testing one idea:
 * that letting the model generate the finished report as HTML/SVG — and rendering
 * it in a sandboxed iframe — produces a better and more flexible report than a
 * fixed Angular renderer. It shares the app's DATA layer (`AnalystDataService`,
 * `DataContextService`, `ModuleContextService`, `ANALYST_SOURCES`) and nothing
 * else. No existing report screen, service, model or export path is touched.
 *
 * ## Where it sits against the three existing patterns
 *
 * | Screen              | Model emits            | App does                     |
 * |---------------------|------------------------|------------------------------|
 * | AI Analyst          | a ReportSpec           | computes + renders every part|
 * | AI Report Builder   | a ReportDefinition     | computes + renders every part|
 * | Chat Reports        | a payload with figures | renders a closed component set|
 * | **AI Report Lab**   | **the document itself**| **renders it in a sandbox**  |
 *
 * Each row moves more authorship to the model and less verification to the app.
 * This row moves all of it, which is exactly what makes the design freedom
 * possible and exactly what makes the grounding rules in the system prompt the
 * only thing standing behind the figures. The provenance line the app adds to
 * every document (see `artifact-document.ts`) is not decoration — it is the
 * honest label on that trade.
 *
 * Data shapes only — no logic. Parsing lives in `services/artifact.parser.ts`.
 */

/**
 * A report as the model produced it, after validation.
 *
 * `html` is a self-contained BODY-LEVEL FRAGMENT, not a whole document: no
 * `<html>`, `<head>` or `<body>`. The wrapper — doctype, charset, viewport, the
 * content-security policy and the provenance footer — is added in exactly one
 * place, `artifact-document.ts`, so the preview, the HTML export and the PDF are
 * byte-for-byte the same document.
 */
export interface GeneratedReportArtifact {
  title: string;
  html: string;
  /** The model's two-or-three-sentence read on what the report shows. */
  summary?: string;
  metadata: {
    /** The module id the report was built from, e.g. `sales-order`. */
    module: string;
    /** Its human label, for the document footer. */
    moduleLabel: string;
    /** ISO timestamp, set by the app — never by the model. */
    generatedAt: string;
    /** Which model answered, for the footer. A NAME, never a key. */
    provider?: string;
    /** How the slice was narrowed when this was generated, as a sentence. */
    slice?: string;
  };
}

/**
 * The result of putting raw model output through the parser.
 *
 * `issues` follows the house rule used by `report-plan.ts` and
 * `report-payload.parser.ts`: **repair and report**, never silently reject. A
 * document that had a `<script>` block stripped still renders, and the user is
 * told it was stripped — because a repair the user cannot see is a repair they
 * cannot judge.
 */
export interface ArtifactValidation {
  artifact: GeneratedReportArtifact | null;
  issues: string[];
}

export type LabTurnRole = 'user' | 'assistant';

/**
 * One turn of the conversation. Prose only.
 *
 * The document is NOT part of the transcript: it is held once, beside the
 * conversation, and each successful reply replaces it. That is what makes
 * "remove the table" mean something — keeping one document per message would
 * give the model nine subjects and no way to know which one "it" refers to.
 */
export interface LabTurn {
  role: LabTurnRole;
  content: string;
  /** Set on an assistant turn that produced or changed the document on screen. */
  producedArtifact?: boolean;
  /** Repairs the parser made to that turn's document, shown under the message. */
  issues?: string[];
}

/**
 * Events streamed back from `/api/ai-report-lab` (SSE).
 *
 * `artifact` is intentionally `unknown`: it is raw model output and MUST pass
 * through `parseArtifact()` before anything treats it as a document.
 */
export type LabStreamEvent =
  | { type: 'text'; text: string }
  | { type: 'progress'; chars: number }
  | { type: 'artifact'; artifact: unknown }
  | { type: 'done' }
  | { type: 'error'; message: string };

/**
 * What the UI says while the model works.
 *
 * UI states, not the model's reasoning — no chain-of-thought is exposed. They
 * exist because the document arrives as tool-call JSON that is never shown, so
 * without them the screen is motionless for the twenty-odd seconds a designed
 * report takes, which is indistinguishable from a hang.
 */
export type LabStage = 'idle' | 'reading' | 'analysing' | 'designing' | 'rendering';

export const LAB_STAGE_LABEL: Record<Exclude<LabStage, 'idle'>, string> = {
  reading: 'Reading your data…',
  analysing: 'Analysing the figures…',
  designing: 'Designing your report…',
  rendering: 'Building the visualisation…',
};

/** What the lab can hand back as a file. Both come from the same HTML. */
export type LabExportFormat = 'html' | 'pdf';

/**
 * Preview viewport. The generated document is required to be responsive, and
 * this is how that requirement is actually checked rather than assumed — the
 * frame is constrained to a real device width and the document reflows inside
 * it, because it is a genuine nested browsing context.
 */
export type PreviewWidth = 'desktop' | 'tablet' | 'mobile';

export const PREVIEW_WIDTHS: readonly { id: PreviewWidth; label: string; px: number | null }[] = [
  { id: 'desktop', label: 'Desktop', px: null },
  { id: 'tablet', label: 'Tablet', px: 834 },
  { id: 'mobile', label: 'Mobile', px: 390 },
];
