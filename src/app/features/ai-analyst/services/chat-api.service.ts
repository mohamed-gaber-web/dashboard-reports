import { Injectable } from '@angular/core';
import { AiProviderId } from '../../../core/ai/ai-provider.service';
import { Analysis, DocumentFormat } from '../models/analysis.model';
import { ChatMessage, ChatStreamEvent } from '../models/chat-message.model';
import { DataContext } from './data-context.service';

interface StreamHandlers {
  onText: (text: string) => void;
  onReport: (spec: unknown) => void;
  onAnalysis: (analysis: Analysis) => void;
  onExport: (format: DocumentFormat) => void;
  onDone: () => void;
  onError: (message: string) => void;
}

/** Everything the endpoint needs beyond the conversation itself. */
interface StreamOptions {
  /**
   * Which model answers. A NAME from a closed list — never a key. The backend
   * holds every key and re-validates this against its own registry, so the worst
   * a tampered value can do is fall back to the server's default provider.
   */
  provider: AiProviderId;
  /**
   * The spec of the report currently on screen, when there is one. Without it
   * the model is blind to its own output — the conversation carries prose only,
   * so "make that chart a donut" or "make it compact" had nothing to modify and
   * the model had to guess the whole report again from memory of what it said.
   * It travels with the MESSAGES, deliberately, not in the system prompt: the
   * system block is prompt-cached and identical across turns, and threading a
   * value that changes every turn through it would invalidate that cache on
   * every reply.
   */
  currentReport?: unknown;
  signal?: AbortSignal;
}

/**
 * Talks to the `/api/chat` serverless endpoint (which holds the model API keys)
 * and dispatches the Server-Sent Events it streams back. The browser never sees
 * an API key.
 */
@Injectable({ providedIn: 'root' })
export class ChatApiService {
  /**
   * Send the conversation + data context; stream events to the handlers.
   *
   * The options were positional (`signal`, then `currentReport`) and grew a
   * third that no caller could pass without also passing the two before it, so
   * they are one object now — see {@link StreamOptions} for what each does.
   */
  async stream(
    messages: ChatMessage[],
    dataContext: DataContext,
    handlers: StreamHandlers,
    options: StreamOptions,
  ): Promise<void> {
    const { provider, currentReport, signal } = options;

    let response: Response;
    try {
      response = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages, dataContext, currentReport, provider }),
        signal,
      });
    } catch {
      handlers.onError('Could not reach the AI service. Is the dev API running (npm run dev:api)?');
      return;
    }

    if (!response.ok || !response.body) {
      // A 5xx here is almost always the dev proxy failing to reach the AI backend.
      const hint =
        response.status >= 500
          ? ' Start the AI backend with "npm run dev:api", then restart "npm start" so the /api/chat proxy loads.'
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
      handlers.onError('The AI response was interrupted.');
      return;
    }

    handlers.onDone();
  }

  private dispatch(frame: string, handlers: StreamHandlers): void {
    const line = frame.split('\n').find((l) => l.startsWith('data:'));
    if (!line) return;
    let event: ChatStreamEvent;
    try {
      event = JSON.parse(line.slice(5).trim());
    } catch {
      return;
    }
    switch (event.type) {
      case 'text':
        handlers.onText(event.text);
        break;
      case 'report':
        handlers.onReport(event.spec);
        break;
      case 'analysis':
        handlers.onAnalysis(event.analysis);
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
