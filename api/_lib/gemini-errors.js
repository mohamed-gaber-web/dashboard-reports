/**
 * Turns a `@google/genai` failure into something a user can act on — the Gemini
 * half of what `anthropic-errors.js` does for Claude.
 *
 * Every branch names the CLASS of problem and the setting to check. None echoes
 * a key, a token or a request body (BE-SEC-04 / BE-SEC-08): the real error is
 * logged server-side and the caller gets the summary only.
 *
 * The SDK throws `ApiError` with a numeric `status`, but a network failure
 * surfaces as a bare `TypeError: fetch failed`, so this reads defensively rather
 * than relying on `instanceof`.
 */

function explainGeminiError(err, model) {
  const status = Number(err?.status ?? err?.code);
  const message = String(err?.message || '');
  const named = model ? `“${model}”` : 'that model';

  // The most common first-run failure by a wide margin: Gemini returns 400
  // (not 401) for a bad key, so the status alone would send someone hunting the
  // wrong problem.
  if (/API[ _]?key not valid|API_KEY_INVALID|invalid api key/i.test(message)) {
    return 'The Gemini API key was rejected. Check GEMINI_API_KEY — create one at aistudio.google.com/apikey.';
  }
  if (status === 401 || status === 403) {
    return `The Gemini API key was rejected, or it is not allowed to use ${named}. Check GEMINI_API_KEY and GEMINI_MODEL.`;
  }
  if (status === 404 || /not found|is not supported/i.test(message)) {
    return `Gemini has no model called ${named} on this key. Set GEMINI_MODEL to one it can reach (e.g. gemini-2.5-flash).`;
  }
  if (status === 429 || /quota|RESOURCE_EXHAUSTED/i.test(message)) {
    return 'Gemini is rate-limited, or the free-tier quota for today is spent. Wait a moment, or switch the model picker to Claude.';
  }
  if (status === 400) {
    return `Gemini rejected the request: ${message}`;
  }
  if (status >= 500) {
    return `Gemini API error ${status}. That is Google's side — try again in a moment.`;
  }
  if (/fetch failed|ENOTFOUND|ECONNREFUSED|ETIMEDOUT|network/i.test(message)) {
    return 'Could not reach the Gemini API. Check the network connection.';
  }
  return message || 'Unexpected server error.';
}

module.exports = { explainGeminiError };
