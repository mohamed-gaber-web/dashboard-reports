/**
 * Request validation for `POST /api/chat-report`.
 *
 * Everything crossing the trust boundary is checked against an explicit shape
 * before any business logic runs (BE-VAL-01/02/03). There is no Zod in this
 * tree, so the schema is expressed as code — but the contract is the same:
 * coerce, bound, and reject with a clean 4xx rather than letting a malformed
 * body reach the Anthropic client and surface as a 500.
 *
 * The caps matter beyond tidiness. This endpoint spends money per token, so an
 * unbounded `messages` array is a billing amplification vector, not just a
 * correctness problem.
 */

const { isProviderId } = require('./ai-provider');
const { REPORT_STYLES } = require('./report-contract');

const LIMITS = {
  /** Conversation turns kept. Older turns are dropped from the front. */
  messages: 40,
  /** Characters per turn. */
  content: 8000,
  /** Serialised `dataContext` bytes. Roughly 25k tokens of JSON. */
  dataContext: 100_000,
};

const ROLES = ['user', 'assistant'];

/**
 * @returns {{ok: true, value: {messages: Array, dataContext: object|null,
 *            provider: string|null, style: string}}
 *          | {ok: false, error: string}}
 */
function validateChatRequest(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, error: 'Request body must be a JSON object.' };
  }

  if (!Array.isArray(body.messages)) {
    return { ok: false, error: '“messages” must be an array.' };
  }

  const messages = body.messages
    .filter((m) => m && typeof m === 'object' && ROLES.includes(m.role))
    .map((m) => ({ role: m.role, content: String(m.content ?? '').slice(0, LIMITS.content) }))
    .filter((m) => m.content.trim().length > 0)
    // Keep the most RECENT turns — the tail is the live conversation. Trimming
    // the head is what every chat UI does when it hits a context budget.
    .slice(-LIMITS.messages);

  if (!messages.length) {
    return { ok: false, error: 'No usable message was supplied.' };
  }
  if (messages[messages.length - 1].role !== 'user') {
    return { ok: false, error: 'The last message must be from the user.' };
  }

  // dataContext is optional. When present it must be an object and must fit —
  // it is interpolated into the system prompt, so an oversized one is a cost
  // and latency problem before it is a correctness one.
  let dataContext = null;
  if (body.dataContext != null) {
    if (typeof body.dataContext !== 'object' || Array.isArray(body.dataContext)) {
      return { ok: false, error: '“dataContext” must be an object when supplied.' };
    }
    let serialised;
    try {
      serialised = JSON.stringify(body.dataContext);
    } catch {
      return { ok: false, error: '“dataContext” could not be serialised.' };
    }
    if (serialised.length > LIMITS.dataContext) {
      return {
        ok: false,
        error: `“dataContext” is too large (${serialised.length} bytes, max ${LIMITS.dataContext}).`,
      };
    }
    dataContext = body.dataContext;
  }

  // Which model answers, chosen by the picker in the UI. Deliberately NOT a
  // rejection when it is unrecognised: it is a preference, not a requirement,
  // and an older client or a stale tab sending a name this deployment does not
  // know should still get an answer from the server's default provider.
  // `isProviderId` is the closed-enum check, so nothing else can reach through.
  const provider = isProviderId(body.provider) ? body.provider : null;

  // Which shape of reply to ask for. Same rule as `provider`, for the same
  // reason: a closed enum, and an unrecognised value degrades to the default
  // rather than failing a request that is otherwise perfectly valid.
  const style = REPORT_STYLES.includes(body.style) ? body.style : 'standard';

  return { ok: true, value: { messages, dataContext, provider, style } };
}

module.exports = { validateChatRequest, LIMITS };
