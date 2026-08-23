import { Analysis, DocumentFormat } from './analysis.model';

export type ChatRole = 'user' | 'assistant';

/** One turn in the AI Analyst conversation. */
export interface ChatMessage {
  role: ChatRole;
  content: string;
}

/**
 * Events streamed back from the `/api/chat` endpoint (SSE).
 *
 * One per tool the model can call, plus prose. `report` and `analysis` are the
 * two halves of a report — what to compute, and what it means. `export` is a
 * request for a download, which the browser fulfils from data it already holds.
 */
export type ChatStreamEvent =
  | { type: 'text'; text: string }
  | { type: 'report'; spec: unknown }
  | { type: 'analysis'; analysis: Analysis }
  | { type: 'export'; format: DocumentFormat }
  | { type: 'done' }
  | { type: 'error'; message: string };
