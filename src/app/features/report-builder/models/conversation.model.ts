/**
 * The conversation half of the AI Report Builder.
 *
 * A turn carries prose only. The report is NOT part of the transcript: it lives
 * beside the conversation as a single current definition that each reply
 * replaces, which is what makes "remove the chart" mean something. Keeping a
 * report per message would give the model nine subjects and no way to know which
 * one "it" refers to.
 */

export type TurnRole = 'user' | 'assistant';

export interface ConversationTurn {
  role: TurnRole;
  content: string;
  /**
   * Set on an assistant turn that produced or changed the report on screen, so
   * the transcript can show WHICH answer built what is above it. Presentation
   * only — the definition itself is held once, by the page's Model.
   */
  producedReport?: boolean;
}

/** Formats a finished report can be delivered in. */
export type ExportFormat = 'pdf' | 'html' | 'excel';

/**
 * Events streamed back from `/api/report-builder` (SSE).
 *
 * One per tool the model can call, plus prose. `definition` is intentionally
 * `unknown`: it is raw model output and must pass through
 * `validateDefinition()` before anything downstream may treat it as a
 * {@link import('./report-definition.model').ReportDefinition}.
 */
export type BuilderStreamEvent =
  | { type: 'text'; text: string }
  | { type: 'report'; definition: unknown }
  | { type: 'export'; format: ExportFormat }
  | { type: 'done' }
  | { type: 'error'; message: string };

/**
 * What the UI says while the model works.
 *
 * These are UI states, not the model's reasoning — no chain-of-thought is
 * exposed. They exist because a blank pane for eight seconds reads as a hang,
 * and because the stages are genuinely different pieces of work: the request
 * goes out, the answer streams back, then the app spends real time counting and
 * folding D365 rows before a figure can exist.
 */
export type BuildStage = 'idle' | 'understanding' | 'analysing' | 'composing' | 'computing';

export const STAGE_LABEL: Record<Exclude<BuildStage, 'idle'>, string> = {
  understanding: 'Understanding your request…',
  analysing: 'Reading the module’s aggregates…',
  composing: 'Choosing what belongs in this report…',
  computing: 'Computing every figure from Dynamics 365…',
};
