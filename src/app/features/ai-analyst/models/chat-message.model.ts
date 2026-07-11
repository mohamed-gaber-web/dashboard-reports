export type ChatRole = 'user' | 'assistant';

/** One turn in the AI Analyst conversation. */
export interface ChatMessage {
  role: ChatRole;
  content: string;
}

/** Events streamed back from the `/api/chat` endpoint (SSE). */
export type ChatStreamEvent =
  | { type: 'text'; text: string }
  | { type: 'report'; spec: unknown }
  | { type: 'done' }
  | { type: 'error'; message: string };
