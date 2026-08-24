import { Injectable } from '@angular/core';
import { AiProviderId } from '../../../core/ai/ai-provider.service';
import { ChatApiMessage } from '../models/chat-turn.model';
import { ReportPayload } from '../models/report-payload.model';
import { parseReportPayload } from '../utils/report-payload.parser';
import { ReportDataContext } from './report-context.service';

/** Either a payload to render, or a message to show the user. Never both. */
export type ChatReportResult =
  | { ok: true; payload: ReportPayload }
  | { ok: false; error: string };

/**
 * Talks to the `/api/chat-report` endpoint, which holds the model API keys. The
 * browser never sees one.
 *
 * One responsibility: perform the request and hand back a parsed result
 * (NG-SOLID-01). It owns no conversation state — that is the ViewModel's job —
 * and it makes no rendering decisions.
 *
 * `fetch` rather than `HttpClient` deliberately: this is not a D365 OData call,
 * so it must not go through `ApiService`, and injecting `HttpClient` anywhere
 * else would break the single-owner rule (NG-ARCH-04). The sibling
 * `ChatApiService` in the AI Analyst feature made the same call.
 */
@Injectable({ providedIn: 'root' })
export class ChatReportApiService {
  /**
   * Send the conversation and get one report payload back.
   *
   * `provider` names which model answers — a value from a closed list, never a
   * key. The backend holds every key and re-validates the name against its own
   * registry, so the worst a tampered value can do is fall back to the server's
   * default provider.
   *
   * Never throws and never rejects — every failure path resolves to
   * `{ ok: false, error }` with something the user can act on. A chat that
   * throws into the console and shows a spinner forever is worse than one that
   * says what went wrong.
   */
  async send(
    messages: ChatApiMessage[],
    dataContext: ReportDataContext | null,
    provider: AiProviderId,
    signal?: AbortSignal,
  ): Promise<ChatReportResult> {
    let response: Response;
    try {
      response = await fetch('/api/chat-report', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages, dataContext, provider }),
        signal,
      });
    } catch (err) {
      // An aborted request is the user pressing Stop, not a failure. The caller
      // already knows; telling them "the network broke" would be a lie.
      if (this.aborted(err, signal)) return { ok: false, error: '' };
      return {
        ok: false,
        error: 'Could not reach the AI service. Is the dev API running (npm run dev:api)?',
      };
    }

    let body: unknown = null;
    try {
      body = await response.json();
    } catch {
      // Left null — a non-JSON body is handled by the checks below rather than
      // being reported as a parse error, because the status says more.
    }

    if (!response.ok) {
      return { ok: false, error: this.errorFrom(body, response.status) };
    }

    // Defensive parse. The body may be a proxy error page, a truncated
    // response, or an older contract — see report-payload.parser.ts.
    const payload = parseReportPayload(body);
    if (!payload) {
      return {
        ok: false,
        error: 'The AI returned a response we could not read. Try asking again.',
      };
    }

    return { ok: true, payload };
  }

  /** Prefer the server's own message; fall back to something status-specific. */
  private errorFrom(body: unknown, status: number): string {
    if (typeof body === 'object' && body !== null) {
      const message = (body as Record<string, unknown>)['error'];
      if (typeof message === 'string' && message.trim()) return message;
    }
    if (status >= 500) {
      return (
        `AI service unavailable (HTTP ${status}). Start the backend with ` +
        `"npm run dev:api", then restart "npm start" so the /api/chat-report proxy loads.`
      );
    }
    return `The AI service rejected the request (HTTP ${status}).`;
  }

  private aborted(err: unknown, signal?: AbortSignal): boolean {
    return signal?.aborted === true || (err instanceof DOMException && err.name === 'AbortError');
  }
}
