import { ReportPayload } from './report-payload.model';

/**
 * One turn in the chat-reports conversation.
 *
 * A user turn is text. An assistant turn is a whole {@link ReportPayload} — the
 * prose AND the report are one reply, so they are one object. Keeping them
 * together is what lets a bubble render its own chips and components without
 * the page correlating two parallel arrays by index.
 */
export type ChatTurn =
  | { role: 'user'; content: string }
  | { role: 'assistant'; payload: ReportPayload };

/** The wire shape `/api/chat-report` expects for conversation history. */
export interface ChatApiMessage {
  role: 'user' | 'assistant';
  content: string;
}
