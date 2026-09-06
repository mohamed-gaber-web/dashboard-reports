import { Injectable } from '@angular/core';
import { AiProviderId } from '../../../core/ai/ai-provider.service';
import { GeneratedReportArtifact, LabStreamEvent, LabTurn } from '../models/report-artifact.model';

interface StreamHandlers {
  onText: (text: string) => void;
  /** How much of the document has arrived, in characters. UI feedback only. */
  onProgress: (chars: number) => void;
  /** RAW model output. MUST go through `parseArtifact()` before use. */
  onArtifact: (artifact: unknown) => void;
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
  /** The Markdown context block. See `lab-context.builder.ts`. */
  context: string;
  /** Which module the question is about, so the prompt can name it. */
  moduleLabel: string;
  /**
   * The document currently on screen. Without it "remove the table" has no
   * subject: the transcript carries prose only, so the model would rebuild the
   * whole report from the memory of its own covering notes.
   *
   * Only `title` and `html` are sent — the metadata is the app's, not the
   * model's, and re-sending it would invite the model to treat a timestamp it
   * did not produce as a figure it may quote.
   */
  currentArtifact?: Pick<GeneratedReportArtifact, 'title' | 'html'>;
  signal?: AbortSignal;
}

/**
 * Talks to `/api/ai-report-lab`, which holds the model API keys, and dispatches
 * the Server-Sent Events it streams back.
 *
 * **The browser never sees an API key.** It sends a provider NAME from a closed
 * enum; the endpoint resolves it to a key server-side. Same principle as
 * `/api/token`, `/api/chat` and `/api/report-builder`.
 *
 * Deliberately separate from `ChatApiService` and `BuilderApiService`: those
 * speak event contracts that carry a `ReportSpec` and a `ReportDefinition`. This
 * one carries a finished HTML document and a byte-progress event neither of them
 * has. Sharing a client would mean a union of three contracts and a runtime check
 * for which third of it arrived — and this prototype is meant to be deletable in
 * one directory.
 */
@Injectable({ providedIn: 'root' })
export class LabApiService {
  async stream(messages: LabTurn[], handlers: StreamHandlers, options: StreamOptions): Promise<void> {
    const { provider, context, moduleLabel, currentArtifact, signal } = options;

    let response: Response;
    try {
      response = await fetch('/api/ai-report-lab', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          // Prose only. The document rides separately as `currentArtifact`.
          messages: messages.map((m) => ({ role: m.role, content: m.content })),
          context,
          moduleLabel,
          currentArtifact,
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
          ? ' Start the AI backend with “npm run dev:api”, then restart “npm start” so the ' +
            '/api/ai-report-lab proxy entry loads.'
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
    // A document runs to tens of kilobytes and arrives in one frame, so the
    // payload can contain no newline of its own — SSE would have framed it. It
    // does not: the server writes `JSON.stringify`, which escapes every newline.
    const line = frame.split('\n').find((l) => l.startsWith('data:'));
    if (!line) return;

    let event: LabStreamEvent;
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
      case 'progress':
        handlers.onProgress(event.chars);
        break;
      case 'artifact':
        handlers.onArtifact(event.artifact);
        break;
      case 'error':
        handlers.onError(event.message);
        break;
      // 'done' is signalled when the stream closes.
    }
  }
}
