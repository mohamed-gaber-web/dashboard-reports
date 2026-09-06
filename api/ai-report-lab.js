/**
 * POST /api/ai-report-lab — the AI Report Lab backend.
 *
 * An ISOLATED prototype endpoint. It does not touch, import from, or change the
 * behaviour of `/api/chat`, `/api/chat-report` or `/api/report-builder`; it only
 * shares the provider registry and the error explainer, which are cross-cutting
 * by design and hold no contract of their own.
 *
 * ## What is different here
 *
 * The other three endpoints ask the model for a DESCRIPTION of a report that the
 * Angular app then renders with its own components. This one asks for the
 * finished DOCUMENT — layout, type, colour and inline-SVG charts included — as a
 * self-contained HTML fragment, which the browser renders inside a sandboxed
 * iframe without interpreting it at all. That is the whole experiment: whether a
 * model given the design freedom produces a better report than a fixed renderer.
 *
 * The safety property that makes it acceptable is NOT a sanitiser. It is that the
 * markup never enters the application's DOM: the frame has no `allow-scripts` and
 * no `allow-same-origin`, so script is inert and the origin is opaque, and the
 * document carries its own `default-src 'none'` CSP so it cannot even fetch an
 * image. See `features/ai-report-lab/components/artifact-frame`.
 *
 * Written against raw Node req/res so it runs unchanged as a Vercel function and
 * under the local dev server (`dev-api/server.js`).
 *
 * Env: ANTHROPIC_API_KEY / GEMINI_API_KEY (at least one)
 *      ANTHROPIC_MODEL        (optional, default claude-opus-5)
 *      REPORT_LAB_EFFORT      (optional, default high — see below)
 *      REPORT_LAB_MAX_TOKENS  (optional, default 32000)
 *      GEMINI_MODEL           (optional, default gemini-2.5-flash)
 */

const Anthropic = require('@anthropic-ai/sdk');
const { resolveProvider } = require('./_lib/ai-provider');
const { streamGeminiAnalyst } = require('./_lib/gemini-analyst');
const { explainAiError } = require('./_lib/ai-errors');
const { ARTIFACT_TOOL, systemPrompt } = require('./_lib/report-lab-contract');

/**
 * Reasoning depth. `high`, where the other screens use `medium`.
 *
 * They are interactive chat, where felt latency beats the last increment of
 * quality. This screen exists to answer "can a model design a genuinely good
 * report", the answer is judged on the artifact, and a report is read for minutes
 * after waiting seconds for it. Overridable per deployment.
 */
const DEFAULT_EFFORT = 'high';

/**
 * A designed document with its own CSS and several inline SVG charts runs to
 * thousands of tokens. At 16k it stops mid-document — and a truncated HTML
 * fragment is not a shorter report, it is an unclosed tag and half a chart.
 */
const DEFAULT_MAX_TOKENS = 32000;

/**
 * Which SSE event each tool's arguments become. A CLOSED map, and that IS the
 * guard: a call to anything not named here never reaches the browser.
 *
 * `artifact` carries RAW model output. The browser must put it through
 * `artifact.parser.ts` before treating it as a document.
 */
const EVENT_FOR_TOOL = {
  [ARTIFACT_TOOL.name]: (input) => ({ type: 'artifact', artifact: input }),
};

const TOOLS = [ARTIFACT_TOOL];

/**
 * How often to tell the browser how much of the document has arrived.
 *
 * The document is streamed as tool-call JSON, which is never shown to the user,
 * so without this the UI has nothing to say for the ten to forty seconds a large
 * report takes — and a still screen for forty seconds reads as a hang. Throttled
 * by size rather than by time so the traffic is proportional to the work.
 */
const PROGRESS_EVERY = 2_000;

function sse(res, obj) {
  res.write(`data: ${JSON.stringify(obj)}\n\n`);
}

async function readBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? JSON.parse(raw) : {};
}

/** Keep only the roles the APIs accept, and drop empty turns they reject. */
function sanitizeMessages(messages) {
  return (Array.isArray(messages) ? messages : [])
    .filter((m) => (m?.role === 'user' || m?.role === 'assistant') && String(m.content || '').trim())
    .map((m) => ({ role: m.role, content: String(m.content) }));
}

/**
 * Append the document currently on screen to the final user turn.
 *
 * Without it "remove the table" has no subject: the transcript carries prose
 * only, so the model would rebuild the whole report from the memory of its own
 * covering notes and quietly change everything the user did not mention.
 *
 * It rides on the MESSAGES, never the system prompt. The system block is
 * prompt-cached and identical across turns; a value that changes with every
 * report would invalidate that cache on every single reply.
 *
 * It is genuinely expensive — a designed document is tens of kilobytes and it is
 * re-sent on each refinement — and that cost is accepted here because refinement
 * IS the feature. See the prototype's known limitations.
 */
function withCurrentArtifact(turns, current) {
  const html = typeof current?.html === 'string' ? current.html : '';
  if (!html || !turns.length) return turns;

  const last = turns[turns.length - 1];
  if (last.role !== 'user') return turns;

  const note = [
    '',
    '',
    '[Context, not part of my message: this is the report document currently on screen —',
    'the exact `html` you last emitted. If I am asking you to change, trim, restyle or',
    'extend THIS report, call emit_report_artifact again with the FULL updated document:',
    'every part that stays copied across verbatim, plus my change. Judge how much my',
    'request actually asks you to alter, and leave the rest alone.',
    '',
    `TITLE: ${String(current.title || '').slice(0, 200)}`,
    '',
    'HTML:',
    html,
    ']',
  ].join('\n');

  return [...turns.slice(0, -1), { ...last, content: last.content + note }];
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.statusCode = 405;
    res.end('Method Not Allowed');
    return;
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');

  // Resolved first, needed last — so the catch can explain a failure in the
  // right provider's terms.
  let provider = null;

  try {
    const {
      messages = [],
      // The Markdown context block, built in the browser. See lab-context.builder.ts.
      context,
      currentArtifact,
      moduleLabel,
      provider: requested,
    } = await readBody(req);

    const turns = withCurrentArtifact(sanitizeMessages(messages), currentArtifact);
    if (!turns.length) {
      sse(res, { type: 'error', message: 'No message to send.' });
      res.end();
      return;
    }

    // `requested` comes from the picker in the UI and is re-checked against a
    // closed enum inside resolveProvider — an unknown value falls back to the
    // server's default rather than failing the request.
    const decision = resolveProvider(requested);
    if (!decision.ok) {
      sse(res, { type: 'error', message: decision.error });
      res.end();
      return;
    }
    provider = decision.provider;

    const system = systemPrompt(context, moduleLabel);

    if (provider.id === 'gemini') {
      // Gemini delivers a function call whole, with `args` already an object, so
      // there is nothing to accumulate and no progress to report on this path.
      const { refused } = await streamGeminiAnalyst(
        {
          apiKey: provider.apiKey,
          model: provider.model,
          system,
          tools: TOOLS,
          messages: turns,
          eventFor: EVENT_FOR_TOOL,
        },
        (event) => sse(res, event),
      );
      if (refused) {
        sse(res, { type: 'error', message: `${provider.label} declined to answer that request.` });
      }
      sse(res, { type: 'done' });
      res.end();
      return;
    }

    const client = new Anthropic({ apiKey: provider.apiKey });

    const stream = client.messages.stream({
      model: provider.model,
      max_tokens: Number(process.env.REPORT_LAB_MAX_TOKENS) || DEFAULT_MAX_TOKENS,
      // Designing a report against a live schema is a reasoning task before it is
      // a writing one; adaptive lets Claude spend where the turn needs it.
      thinking: { type: 'adaptive' },
      output_config: { effort: process.env.REPORT_LAB_EFFORT || DEFAULT_EFFORT },
      // The system prompt carries the brief plus the module's schema and
      // aggregates — large and identical across every turn of a conversation.
      // Caching it makes refinements markedly cheaper, and it re-caches when the
      // user changes module or slice, which is exactly when it should.
      system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
      tools: TOOLS,
      messages: turns,
    });

    let toolJson = null;
    let toolName = null;
    let announced = 0;

    for await (const event of stream) {
      switch (event.type) {
        case 'content_block_start':
          if (event.content_block.type === 'tool_use' && EVENT_FOR_TOOL[event.content_block.name]) {
            toolName = event.content_block.name;
            toolJson = '';
            announced = 0;
            sse(res, { type: 'progress', chars: 0 });
          }
          break;

        case 'content_block_delta':
          if (event.delta.type === 'text_delta') {
            if (event.delta.text) sse(res, { type: 'text', text: event.delta.text });
          } else if (event.delta.type === 'input_json_delta' && toolJson !== null) {
            toolJson += event.delta.partial_json;
            if (toolJson.length - announced >= PROGRESS_EVERY) {
              announced = toolJson.length;
              sse(res, { type: 'progress', chars: announced });
            }
          }
          // thinking_delta is ignored on purpose — no chain-of-thought reaches
          // the browser, and the UI has no surface for it.
          break;

        case 'content_block_stop':
          if (toolJson !== null) {
            try {
              sse(res, EVENT_FOR_TOOL[toolName](JSON.parse(toolJson)));
            } catch {
              // A truncated tool call. The document is unrecoverable, but the
              // covering note already reached the user, so say what happened
              // rather than failing the whole turn silently.
              sse(res, {
                type: 'error',
                message:
                  'The report was cut off before it finished. Ask again, or ask for a shorter ' +
                  'report — a very long document can exceed the reply limit.',
              });
            }
            toolJson = null;
            toolName = null;
          }
          break;
      }
    }

    const final = await stream.finalMessage();
    if (final.stop_reason === 'refusal') {
      sse(res, { type: 'error', message: `${provider.label} declined to answer that request.` });
    } else if (final.stop_reason === 'max_tokens' && toolName === null && !final.content.length) {
      sse(res, { type: 'error', message: 'The reply hit the length limit before producing anything.' });
    }

    sse(res, { type: 'done' });
    res.end();
  } catch (err) {
    console.error(`[api/ai-report-lab] ${provider?.id ?? 'unresolved'} error:`, err);
    sse(res, { type: 'error', message: explainAiError(err, provider) });
    res.end();
  }
};
