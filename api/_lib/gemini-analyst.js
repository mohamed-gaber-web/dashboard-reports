/**
 * The Gemini path for `POST /api/chat` — the AI Analyst's streaming backend.
 *
 * Emits exactly the SSE event objects the Anthropic path emits, through the
 * `emit` callback, so `chat-api.service.ts` in the browser cannot tell which
 * provider answered. The endpoint keeps ownership of the wire format (it writes
 * the frames); this module only decides what the events ARE.
 *
 * ## Function calls arrive whole
 *
 * Anthropic streams tool arguments as `input_json_delta` fragments, which is why
 * `api/chat.js` accumulates a string and parses it at `content_block_stop`.
 * Gemini does not: a `functionCall` part arrives complete, with `args` already
 * an object. There is nothing to accumulate and nothing to parse, so the
 * truncated-tool-call failure mode simply does not exist on this path.
 *
 * ## The export ordering rule is preserved
 *
 * `export_document` is held back until the turn ends, matching the AI Analyst's
 * documented contract: a report emitted in the same reply has to be rendered
 * before a download of it is requested, or the export ships the PREVIOUS report.
 * The Anthropic path gets this from the browser (`onExport` stores a pending
 * format); it is enforced here as well so the ordering does not depend on which
 * provider is live.
 */

const { toFunctionDeclarations } = require('./gemini-schema');
const { createClient, contentsFrom, wasRefused } = require('./gemini-client');

/**
 * Stream one AI Analyst turn from Gemini.
 *
 * @param {object} options
 * @param {string} options.apiKey
 * @param {string} options.model
 * @param {string} options.system            System instruction (the schema + aggregates).
 * @param {Array}  options.tools             Anthropic-style tool defs; converted here.
 * @param {Array}  options.messages          Conversation turns.
 * @param {Record<string, (args: object) => object>} options.eventFor
 *        Tool name → SSE event object. The same map the Anthropic path uses.
 * @param {string[]} [options.deferTools]    Tools whose event is emitted last.
 * @param {(event: object) => void} emit     Called for each SSE event, in order.
 * @returns {Promise<{refused: boolean}>}
 */
async function streamGeminiAnalyst(
  { apiKey, model, system, tools, messages, eventFor, deferTools = [] },
  emit,
) {
  const ai = createClient(apiKey);
  const deferred = new Set(deferTools);

  const stream = await ai.models.generateContentStream({
    model,
    contents: contentsFrom(messages),
    config: {
      systemInstruction: system,
      tools: [{ functionDeclarations: toFunctionDeclarations(tools) }],
      // Function calling stays AUTO — the prompt tells the model when a report
      // is wanted and when a question deserves prose alone, and forcing a call
      // would make every reply a report.
    },
  });

  let refused = false;
  const held = [];

  for await (const chunk of stream) {
    if (wasRefused(chunk)) refused = true;

    for (const part of chunk?.candidates?.[0]?.content?.parts ?? []) {
      // Thought parts carry the model's reasoning; the chat panel has no surface
      // for it, same as the Anthropic path ignoring `thinking_delta`.
      if (part.thought) continue;

      if (typeof part.text === 'string' && part.text) {
        emit({ type: 'text', text: part.text });
        continue;
      }

      const call = part.functionCall;
      if (!call) continue;

      const build = eventFor[call.name];
      // A call to something we did not declare is not actionable. Dropping it is
      // right: the closed map IS the guard, exactly as on the Anthropic path.
      if (!build) continue;

      const event = build(call.args || {});
      if (deferred.has(call.name)) held.push(event);
      else emit(event);
    }
  }

  for (const event of held) emit(event);

  return { refused };
}

module.exports = { streamGeminiAnalyst };
