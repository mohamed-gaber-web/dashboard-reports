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
  | { role: 'assistant'; payload: ReportPayload }
  /**
   * A marker the app writes, not a message anyone sent.
   *
   * It exists because the slice can change mid-conversation: every figure above
   * the marker was computed for a different set of rows. Wiping the transcript
   * instead would be data loss over a date change, and leaving it unmarked would
   * put two incompatible sets of numbers in one scroll with nothing between them.
   * Never sent on the wire — see `ChatReportsModel.history()`.
   */
  | { role: 'notice'; content: string };

/** The wire shape `/api/chat-report` expects for conversation history. */
export interface ChatApiMessage {
  role: 'user' | 'assistant';
  content: string;
}
