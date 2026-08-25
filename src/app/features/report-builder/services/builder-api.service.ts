import { Injectable } from '@angular/core';
import { AiProviderId } from '../../../core/ai/ai-provider.service';
import { DataContext } from '../../ai-analyst/services/data-context.service';
import {
  BuilderStreamEvent,
  ConversationTurn,
  ExportFormat,
} from '../models/conversation.model';

interface StreamHandlers {
  onText: (text: string) => void;
  /** Raw model output. MUST be validated before anything treats it as a definition. */
  onReport: (definition: unknown) => void;
  onExport: (format: ExportFormat) => void;
  onDone: () => void;
  onError: (message: string) => void;
}

interface StreamOptions {
  /**
   * Which model answers. A NAME from a closed list — never a key. The backend
   * holds every key and re-validates this against its own registry, so the worst
   * a tampered value can do is fall back to the server's default provider.
   */
  provider: AiProviderId;
  /** Which module the question is about, so the prompt can name it. */
  sourceLabel: string;
  /**
   * The definition of the report currently on screen. Without it the model is
   * blind to its own output — the conversation carries prose only, so "remove
   * the chart" or "change it to a bar chart" would have no subject and the model
   * would rebuild the whole report from the memory of its own sentences.
   */
  currentReport?: unknown;
  signal?: AbortSignal;
}

/**
 * Talks to `/api/report-builder`, which holds the model API keys, and dispatches
 * the Server-Sent Events it streams back.
 *
 * **The browser never sees an API key.** It sends a provider NAME from a closed
 * enum; the endpoint resolves it to a key server-side. Same principle as
 * `/api/token` and `/api/chat`.
 *
 * Deliberately separate from `ChatApiService`: that one speaks the AI Analyst's
 * event contract (`report` carries a `ReportSpec`, plus an `analysis` event this
 * screen has no equivalent of). Sharing a client would mean a union of two
 * contracts and a runtime check for which half arrived.
 */
@Injectable({ providedIn: 'root' })
export class BuilderApiService {
  async stream(
    messages: ConversationTurn[],
    dataContext: DataContext,
    handlers: StreamHandlers,
    options: StreamOptions,
  ): Promise<void> {
    const { provider, sourceLabel, currentReport, signal } = options;

    let response: Response;
    try {
      response = await fetch('/api/report-builder', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          // Prose only. The report rides separately as `currentReport`.
          messages: messages.map((m) => ({ role: m.role, content: m.content })),
          dataContext,
          currentReport,
          sourceLabel,
          provider,
        }),
        signal,
      });
    } catch {
      // An abort lands here too, and it is not a failure the user needs told
      // about — they pressed Stop.
      if (signal?.aborted) return;
      handlers.onError(
        'Could not reach the AI service. Is the dev API running? Start it with “npm run dev:api”.',
      );
      return;
    }

    if (!response.ok || !response.body) {
      // A 5xx here is almost always the dev proxy failing to reach the backend.
      const hint =
        response.status >= 500
          ? ' Start the AI backend with “npm run dev:api”, then restart “npm start” so the /api/report-builder proxy loads.'
          : '';
      handlers.onError(`AI service unavailable (HTTP ${response.status}).${hint}`);
      return;
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        // SSE frames are separated by a blank line.
        let sep: number;
        while ((sep = buffer.indexOf('\n\n')) !== -1) {
          const frame = buffer.slice(0, sep);
          buffer = buffer.slice(sep + 2);
          this.dispatch(frame, handlers);
        }
      }
    } catch {
      if (signal?.aborted) return;
      handlers.onError('The AI response was interrupted.');
      return;
    }

    handlers.onDone();
  }

  private dispatch(frame: string, handlers: StreamHandlers): void {
    const line = frame.split('\n').find((l) => l.startsWith('data:'));
    if (!line) return;

    let event: BuilderStreamEvent;
    try {
      event = JSON.parse(line.slice(5).trim());
    } catch {
      // A malformed frame is not worth failing the whole turn over — the rest of
      // the stream is still well-formed and still useful.
      return;
    }

    switch (event.type) {
      case 'text':
        handlers.onText(event.text);
        break;
      case 'report':
        handlers.onReport(event.definition);
        break;
      case 'export':
        handlers.onExport(event.format);
        break;
      case 'error':
        handlers.onError(event.message);
        break;
      // 'done' is signalled when the stream closes.
    }
  }
}
