/**
 * Which model provider serves a request — the ONE place that decision is made.
 *
 * Both AI endpoints (`/api/chat` and `/api/chat-report`) ask this module and get
 * back a resolved `{id, label, apiKey, model}`. Neither reads `process.env` for a
 * key itself any more, so "how do I point this at a different provider" has a
 * single answer instead of two that can drift.
 *
 * ## Claude is the provider; Gemini is the switch
 *
 * The prompts, the tool contracts and the prompt-caching strategy in this repo
 * were designed against Claude, and it stays first in {@link PROVIDER_ORDER}: if
 * both keys are present and nothing asks for anything, Claude answers. Gemini
 * exists so the whole app can be flipped to a second provider — from the UI, per
 * request — and flipped back without editing code or re-deploying.
 *
 * ## Why the BROWSER may choose
 *
 * The provider arrives on the request body, from a toggle in the UI. That is
 * safe because it is a CLOSED enum validated here (`isProviderId`) and because
 * what it selects is a *key that never leaves the server*. The client picks a
 * name from a list; it can neither supply a key nor reach one. An unknown value
 * is not an error — it falls through to the server's own default, so a stale tab
 * or an older client keeps working.
 *
 * Env, per provider:
 *   ANTHROPIC_API_KEY / ANTHROPIC_MODEL  (default claude-opus-5)
 *   GEMINI_API_KEY    / GEMINI_MODEL     (default gemini-2.5-flash)
 *   AI_PROVIDER — optional, forces the server-side default to one of the ids
 *                 below. A request that names a provider still wins over it.
 */

/**
 * The closed registry. Adding a provider means an entry here, a `_lib` module
 * that speaks its API, and one branch in each endpoint — nothing else.
 *
 * `keyEnv` is published to the browser by `/api/ai-providers` so the UI can say
 * *which variable to set* when a provider is unavailable. That is the NAME of an
 * environment variable, documented in `.env.example` and in this file — never
 * its value.
 */
const PROVIDERS = {
  anthropic: {
    id: 'anthropic',
    label: 'Claude',
    detail: 'Anthropic · tool use + prompt caching',
    keyEnv: 'ANTHROPIC_API_KEY',
    modelEnv: 'ANTHROPIC_MODEL',
    defaultModel: 'claude-opus-5',
  },
  gemini: {
    id: 'gemini',
    label: 'Gemini',
    detail: 'Google · structured JSON output',
    keyEnv: 'GEMINI_API_KEY',
    modelEnv: 'GEMINI_MODEL',
    // Matches the model the integration was written and smoke-tested against.
    // Override per-deployment rather than editing this — a model id that the
    // key cannot reach is a 404 at request time, not a startup failure.
    defaultModel: 'gemini-2.5-flash',
  },
};

/**
 * Preference order when nothing named a provider. Claude leads deliberately —
 * see the header. Also the order the picker renders in.
 */
const PROVIDER_ORDER = ['anthropic', 'gemini'];

/**
 * Is this one of our ids? `Object.hasOwn` rather than `in` so a request body
 * carrying `"__proto__"` or `"constructor"` cannot pass for a provider.
 */
function isProviderId(value) {
  return typeof value === 'string' && Object.hasOwn(PROVIDERS, value);
}

/** The configured key, or '' — never partially echoed, never logged. */
function keyFor(def) {
  const value = process.env[def.keyEnv];
  return typeof value === 'string' && value.trim() ? value.trim() : '';
}

function modelFor(def) {
  const value = process.env[def.modelEnv];
  return typeof value === 'string' && value.trim() ? value.trim() : def.defaultModel;
}

/**
 * What the picker in the UI renders: every provider, whether it is usable, and
 * which model it would use. Contains no secret — `available` is a boolean
 * derived from a key, not the key.
 */
function providerStatus() {
  return PROVIDER_ORDER.map((id) => {
    const def = PROVIDERS[id];
    return {
      id: def.id,
      label: def.label,
      detail: def.detail,
      model: modelFor(def),
      keyEnv: def.keyEnv,
      available: keyFor(def) !== '',
    };
  });
}

/**
 * The server's own choice: `AI_PROVIDER` when it names a real provider,
 * otherwise the first one that actually has a key. Falls back to the head of the
 * order so this always returns an id — "nothing is configured" is reported by
 * `resolveProvider`, with the variable to set, rather than by returning null
 * here and making every caller re-derive the message.
 */
function defaultProviderId() {
  const forced = process.env.AI_PROVIDER;
  if (isProviderId(forced)) return forced;
  return PROVIDER_ORDER.find((id) => keyFor(PROVIDERS[id])) || PROVIDER_ORDER[0];
}

/**
 * Resolve the provider for one request.
 *
 * @param {unknown} requested What the client asked for. Anything that is not a
 *   known id is ignored in favour of the server default — a client cannot cause
 *   an error here, only express a preference.
 * @returns {{ok: true, provider: {id: string, label: string, apiKey: string, model: string}}
 *          | {ok: false, status: number, error: string}}
 */
function resolveProvider(requested) {
  const id = isProviderId(requested) ? requested : defaultProviderId();
  const def = PROVIDERS[id];
  const apiKey = keyFor(def);

  if (!apiKey) {
    // Name the variable to set, and the way out. A user who flipped the toggle
    // to a provider with no key needs to know both.
    const alternatives = PROVIDER_ORDER.filter((other) => other !== id && keyFor(PROVIDERS[other])).map(
      (other) => PROVIDERS[other].label,
    );
    const escape = alternatives.length
      ? ` Or switch the model picker back to ${alternatives.join(' or ')}.`
      : '';
    return {
      ok: false,
      status: 503,
      error: `${def.label} is not configured. Set ${def.keyEnv} and restart the API.${escape}`,
    };
  }

  return { ok: true, provider: { id: def.id, label: def.label, apiKey, model: modelFor(def) } };
}

module.exports = { PROVIDER_ORDER, isProviderId, providerStatus, defaultProviderId, resolveProvider };
