/**
 * Turns an Anthropic SDK error into something a user can act on.
 *
 * Extracted from `api/chat.js` so `api/chat-report.js` reports failures with the
 * same words — two endpoints hitting the same API should not disagree about
 * what "no credits" looks like.
 *
 * Every branch returns a message that names the *class* of problem and the
 * setting to check. None of them echoes a key, a token, or a request body
 * (BE-SEC-04 / BE-SEC-08): the real error is logged server-side, and the caller
 * gets the actionable summary only.
 */

const Anthropic = require('@anthropic-ai/sdk');

function explainAnthropicError(err) {
  if (err instanceof Anthropic.AuthenticationError) {
    return 'The Anthropic API key was rejected. Check ANTHROPIC_API_KEY.';
  }
  if (err instanceof Anthropic.PermissionDeniedError) {
    return 'This Anthropic API key is not allowed to use that model.';
  }
  if (err instanceof Anthropic.RateLimitError) {
    return 'Claude is rate-limited right now. Wait a moment and try again.';
  }
  if (err instanceof Anthropic.BadRequestError) {
    // The most common first-run failure: a valid key on an account with no
    // credits. The raw 400 buries that, so name it plainly — an API key and API
    // credits are separate from a claude.ai subscription.
    if (/credit balance is too low/i.test(err.message || '')) {
      return 'The Anthropic account has no API credits. Add credits at console.anthropic.com → Billing (a Claude Pro/Max subscription does not include API credits).';
    }
    return `Claude rejected the request: ${err.message}`;
  }
  if (err instanceof Anthropic.APIConnectionError) {
    return 'Could not reach the Anthropic API. Check the network connection.';
  }
  if (err instanceof Anthropic.APIError) {
    return `Anthropic API error ${err.status}: ${err.message}`;
  }
  return err?.message || 'Unexpected server error.';
}

module.exports = { explainAnthropicError };
