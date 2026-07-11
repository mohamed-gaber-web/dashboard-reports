import { Injectable } from '@angular/core';
import { ChatMessage, ChatStreamEvent } from '../models/chat-message.model';
import { DataContext } from './data-context.service';

interface StreamHandlers {
  onText: (text: string) => void;
  onReport: (spec: unknown) => void;
  onDone: () => void;
  onError: (message: string) => void;
}

/**
 * Talks to the `/api/chat` serverless endpoint (which holds the OpenRouter key)
 * and dispatches the Server-Sent Events it streams back. The browser never sees
 * the API key.
 */
@Injectable({ providedIn: 'root' })
export class ChatApiService {
  /** Send the conversation + data context; stream events to the handlers. */
  async stream(
    messages: ChatMessage[],
    dataContext: DataContext,
    handlers: StreamHandlers,
    signal?: AbortSignal,
  ): Promise<void> {
    let response: Response;
    try {
      response = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages, dataContext }),
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
      case 'error':
        handlers.onError(event.message);
        break;
      // 'done' is signalled when the stream closes.
    }
  }
}
