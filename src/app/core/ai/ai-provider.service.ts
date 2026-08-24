import { Injectable, computed, signal } from '@angular/core';

/** The providers the backend knows about. Mirrors `PROVIDERS` in `api/_lib/ai-provider.js`. */
export type AiProviderId = 'anthropic' | 'gemini';

/** One row of the model picker, as `/api/ai-providers` reports it. */
export interface AiProviderOption {
  readonly id: AiProviderId;
  readonly label: string;
  /** Second line in the picker — who makes it and what it is good at. */
  readonly detail: string;
  /** The model this deployment would actually call. */
  readonly model: string;
  /** The env var that configures it, so an unavailable option can say what to set. */
  readonly keyEnv: string;
  /** Whether the backend has a key for it. `false` = the option is dead. */
  readonly available: boolean;
}

const STORAGE_KEY = 'rd.ai.provider';

/**
 * What the picker shows before `/api/ai-providers` answers, and what it falls
 * back to if that call fails.
 *
 * Optimistic on `available`: a picker that greys everything out while it waits
 * would flicker on every page load, and a provider that turns out to be
 * unconfigured reports itself clearly on the next question (the backend answers
 * 503 naming the variable to set). Guessing "available" costs one clear error;
 * guessing "unavailable" hides a working provider.
 */
const FALLBACK: readonly AiProviderOption[] = [
  {
    id: 'anthropic',
    label: 'Claude',
    detail: 'Anthropic · tool use + prompt caching',
    model: 'claude-opus-5',
    keyEnv: 'ANTHROPIC_API_KEY',
    available: true,
  },
  {
    id: 'gemini',
    label: 'Gemini',
    detail: 'Google · structured JSON output',
    model: 'gemini-2.5-flash',
    keyEnv: 'GEMINI_API_KEY',
    available: true,
  },
];

/**
 * Which model answers, app-wide.
 *
 * Both AI screens read this, so switching provider on one is switching it on
 * the other — it is a property of the app, not of a conversation. The choice
 * rides on each request body; the KEYS stay on the server and the browser never
 * sees one. All this service sends is a name from a closed list, which the
 * backend re-validates (see `api/_lib/ai-provider.js`).
 *
 * `fetch` rather than `HttpClient` deliberately: this is not a D365 OData call,
 * so it must not go through `ApiService`, and injecting `HttpClient` anywhere
 * else would break the single-owner rule (NG-ARCH-04). The two chat services
 * make the same call for the same reason.
 */
@Injectable({ providedIn: 'root' })
export class AiProviderService {
  private readonly _providers = signal<readonly AiProviderOption[]>(FALLBACK);
  private readonly _selected = signal<AiProviderId>(this.readStored() ?? 'anthropic');

  readonly providers = this._providers.asReadonly();
  readonly selected = this._selected.asReadonly();

  /** The selected provider's row, for anything that wants its label or model. */
  readonly active = computed(
    () => this._providers().find((p) => p.id === this._selected()) ?? this._providers()[0],
  );

  constructor() {
    void this.refresh();
  }

  /** Choose a provider. Ignores an unavailable one — the picker disables those. */
  select(id: AiProviderId): void {
    const option = this._providers().find((p) => p.id === id);
    if (!option || !option.available) return;
    this._selected.set(id);
    try {
      localStorage.setItem(STORAGE_KEY, id);
    } catch {
      // Private mode or a full quota. The choice still holds for this session;
      // failing to remember it is not worth failing the click over.
    }
  }

  /**
   * Ask the backend which providers are actually configured.
   *
   * Only corrects the selection when the stored one turns out to be unusable —
   * a deliberate choice must survive a reload, so this never "helpfully" moves a
   * working selection to the server's preferred default.
   */
  async refresh(): Promise<void> {
    let options: readonly AiProviderOption[];
    let serverDefault: AiProviderId | null;

    try {
      const response = await fetch('/api/ai-providers');
      if (!response.ok) return;
      const body = (await response.json()) as {
        providers?: unknown;
        selected?: unknown;
      };
      options = this.parse(body.providers);
      serverDefault = this.isId(body.selected) ? body.selected : null;
    } catch {
      // Offline, or the dev API is not running. Keep the fallback list: the
      // picker stays usable and the real diagnosis comes from the next question.
      return;
    }

    if (!options.length) return;
    this._providers.set(options);

    const current = options.find((p) => p.id === this._selected());
    if (current?.available) return;

    // The stored choice cannot answer. Prefer the server's own default, then
    // anything that works, so the picker never rests on a dead option.
    const fallback =
      (serverDefault && options.find((p) => p.id === serverDefault && p.available)) ||
      options.find((p) => p.available);
    if (fallback) this._selected.set(fallback.id);
  }

  private parse(value: unknown): AiProviderOption[] {
    if (!Array.isArray(value)) return [];
    return value
      .filter((row): row is Record<string, unknown> => !!row && typeof row === 'object')
      .filter((row) => this.isId(row['id']))
      .map((row) => ({
        id: row['id'] as AiProviderId,
        label: String(row['label'] ?? row['id']),
        detail: String(row['detail'] ?? ''),
        model: String(row['model'] ?? ''),
        keyEnv: String(row['keyEnv'] ?? ''),
        available: row['available'] === true,
      }));
  }

  private isId(value: unknown): value is AiProviderId {
    return value === 'anthropic' || value === 'gemini';
  }

  private readStored(): AiProviderId | null {
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      return this.isId(stored) ? stored : null;
    } catch {
      return null;
    }
  }
}
