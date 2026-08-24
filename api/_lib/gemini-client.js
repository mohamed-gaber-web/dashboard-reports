/**
 * The bits both Gemini callers need: a client, message translation, and the two
 * questions you have to ask about every Gemini response.
 *
 * Kept apart from `gemini-report.js` / `gemini-analyst.js` so those read as the
 * endpoint logic they are, rather than as SDK plumbing.
 */

const { GoogleGenAI } = require('@google/genai');

/**
 * Finish reasons that mean the model declined, as opposed to finished. Mapped
 * onto the same "refusal" outcome Claude reports via `stop_reason`, so the
 * endpoints keep one refusal path instead of one per provider.
 */
const REFUSAL_REASONS = new Set([
  'SAFETY',
  'PROHIBITED_CONTENT',
  'BLOCKLIST',
  'SPII',
  'RECITATION',
  'IMAGE_SAFETY',
  'IMAGE_PROHIBITED_CONTENT',
]);

function createClient(apiKey) {
  return new GoogleGenAI({ apiKey });
}

/**
 * Chat turns → Gemini `contents`.
 *
 * Gemini calls the assistant "model"; everything else about the shape is the
 * same. The system prompt is NOT a turn here — it rides on
 * `config.systemInstruction`, which is Gemini's equivalent of Anthropic's
 * top-level `system` block.
 */
function contentsFrom(messages) {
  return messages.map((message) => ({
    role: message.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: String(message.content ?? '') }],
  }));
}

/**
 * The answer's text, assembled from parts.
 *
 * Thought parts are skipped explicitly rather than trusting the SDK's `.text`
 * convenience getter: on a thinking model they carry the model's reasoning, and
 * the chat surfaces here have nowhere to put it — the same reason
 * `api/chat.js` ignores Anthropic's `thinking_delta`.
 */
function textFrom(parts) {
  return (parts || [])
    .filter((part) => !part.thought && typeof part.text === 'string')
    .map((part) => part.text)
    .join('');
}

/** Did the model refuse, or did the prompt get blocked before it ran? */
function wasRefused(response) {
  if (response?.promptFeedback?.blockReason) return true;
  const reason = response?.candidates?.[0]?.finishReason;
  return typeof reason === 'string' && REFUSAL_REASONS.has(reason);
}

module.exports = { createClient, contentsFrom, textFrom, wasRefused, REFUSAL_REASONS };
