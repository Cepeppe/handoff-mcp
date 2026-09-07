/**
 * Identifier generation and shapes (TECHNICAL-DESIGN §4.1).
 *
 * Every identifier of the system is a short prefix plus lowercase Crockford base32, five
 * random bits per character: `hf_` for a handoff (and for a user-opened request, which
 * keeps its id when the spec arrives, DD-13), `ses_` for a channel registration, `call_`
 * for one blocking call, `rb_` for a runbook. The alphabet drops `i`, `l`, `o` and `u`,
 * so an id read aloud or copied out of a chat cannot turn into a different id.
 *
 * The `hf_` prefix is deliberately shared with Hugging Face access tokens, whose certain
 * pattern requires thirty-four characters after the prefix: ten can never reach it, and
 * `test/contract/patterns.test.ts` asserts that no generated id of any shape matches any
 * certain-secret pattern.
 */
import { randomBytes } from 'node:crypto';

/** Crockford base32, lowercase: the ten digits and the twenty-two letters that are left. */
export const ID_ALPHABET = '0123456789abcdefghjkmnpqrstvwxyz';

export const HANDOFF_ID_RE = /^hf_[0-9a-hjkmnp-tv-z]{10}$/u;
export const REQUEST_ID_RE = HANDOFF_ID_RE;
export const SESSION_REF_RE = /^ses_[0-9a-hjkmnp-tv-z]{8}$/u;
export const CALL_ID_RE = /^call_[0-9a-hjkmnp-tv-z]{8}$/u;
export const RUNBOOK_ID_RE = /^rb_[0-9a-hjkmnp-tv-z]{10}$/u;

/**
 * `length` characters of the alphabet after `prefix`. The alphabet has 32 entries and 32
 * divides 256, so masking the low five bits of a random byte leaves every character
 * equally likely: no rejection loop and no modulo bias.
 */
function randomId(prefix: string, length: number): string {
  let out = prefix;
  for (const byte of randomBytes(length)) {
    out += ID_ALPHABET.charAt(byte & 31);
  }
  return out;
}

/** A handoff id: `hf_` plus ten characters, fifty random bits. */
export function newHandoffId(): string {
  return randomId('hf_', 10);
}

/**
 * The id of a user-opened request. Same shape as a handoff id on purpose: when the agent
 * sends a spec carrying this `request_id`, the handoff takes the id over (DD-13).
 */
export function newRequestId(): string {
  return newHandoffId();
}

/** A channel session reference: `ses_` plus eight characters. Never shown to an agent. */
export function newSessionRef(): string {
  return randomId('ses_', 8);
}

/** The id of one blocking call: `call_` plus eight characters. Internal to the channel. */
export function newCallId(): string {
  return randomId('call_', 8);
}

/** A runbook id: `rb_` plus ten characters. Part of the runbook file name. */
export function newRunbookId(): string {
  return randomId('rb_', 10);
}
