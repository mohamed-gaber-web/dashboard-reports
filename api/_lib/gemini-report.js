/**
 * The Gemini path for `POST /api/chat-report`.
 *
 * ## It returns a Claude-shaped message on purpose
 *
 * `api/chat-report.js` already owns the hard part: a three-tier recovery chain
 * (`payloadFrom`) that turns whatever the model produced into a renderable
 * payload, plus the two-sided validation in `report-payload.js`. None of that is
 * Anthropic-specific — it is about untrusted model output — so this module
 * ADAPTS to it rather than duplicating it: it hands back
 * `{content: [...blocks], stop_reason}` in Anthropic's shape and the endpoint
 * runs unchanged for both providers.
 *
 * That means Gemini gets tiers 1–3 for free, including the "plain prose, no
 * report" tier that makes the endpoint's strict-JSON contract total.
 *
 * ## Structured output, not function calling
 *
 * Claude is asked for a tool call because tool arguments are assembled by the
 * API from a schema. Gemini's equivalent guarantee is `responseMimeType:
 * 'application/json'` + `responseSchema`, which constrains DECODING itself —
 * a stronger guarantee than a tool the model may decline to call, and the
 * reason the Anthropic side needs three tiers while this one usually needs one.
 */

const { REPORT_TOOL } = require('./report-contract');
const { toGeminiSchema } = require('./gemini-schema');
const { createClient, contentsFrom, textFrom, wasRefused } = require('./gemini-client');

// Converted once at module load. The contract is a constant, so a per-request
// conversion would be pure waste on a serverless cold path.
const RESPONSE_SCHEMA = toGeminiSchema(REPORT_TOOL.input_schema);

/**
 * @param {{apiKey: string, model: string, system: string, messages: Array}} options
 * @returns {Promise<{content: Array, stop_reason: string}>} An Anthropic-shaped
 *   message, ready for `payloadFrom` in `api/chat-report.js`.
 */
async function runGeminiReport({ apiKey, model, system, messages }) {
  const ai = createClient(apiKey);

  const response = await ai.models.generateContent({
    model,
    contents: contentsFrom(messages),
    config: {
      systemInstruction: system,
      responseMimeType: 'application/json',
      responseSchema: RESPONSE_SCHEMA,
      // maxOutputTokens is deliberately NOT set. On a thinking model the budget
      // is shared with the reasoning tokens, so a figure chosen for the answer
      // truncates it into invalid JSON — and any figure would also have to be
      // valid for whatever GEMINI_MODEL is pointed at. The model's own ceiling
      // is the bound; the request side is already capped in `chat-request.js`.
    },
  });

  if (wasRefused(response)) {
    return { content: [], stop_reason: 'refusal' };
  }

  const text = textFrom(response?.candidates?.[0]?.content?.parts).trim();

  // Decoding was schema-constrained, so this is the path that fires. Present it
  // as the tool call the endpoint's tier 1 expects.
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return {
        content: [{ type: 'tool_use', name: REPORT_TOOL.name, input: parsed }],
        stop_reason: 'tool_use',
      };
    }
  } catch {
    // Fall through — a reply that is not JSON is still a reply. Tiers 2 and 3
    // in the endpoint recover an embedded object, or wrap the prose as a
    // component-less payload.
  }

  return { content: [{ type: 'text', text }], stop_reason: 'end_turn' };
}

module.exports = { runGeminiReport };
