/**
 * One entry point for "why did the model call fail", whichever provider was in
 * play. Both AI endpoints call this so a failure reads the same on `/api/chat`
 * and `/api/chat-report`.
 *
 * The per-provider wording lives in `anthropic-errors.js` and `gemini-errors.js`;
 * this only routes. Anything unrecognised falls back to Anthropic's explainer,
 * which ends in a plain message string for a non-SDK error.
 */

const { explainAnthropicError } = require('./anthropic-errors');
const { explainGeminiError } = require('./gemini-errors');

/**
 * @param {unknown} err The thrown error.
 * @param {{id: string, model: string}} [provider] The resolved provider, so the
 *   message can name the model that was actually used.
 */
function explainAiError(err, provider) {
  if (provider?.id === 'gemini') return explainGeminiError(err, provider.model);
  return explainAnthropicError(err);
}

module.exports = { explainAiError };
