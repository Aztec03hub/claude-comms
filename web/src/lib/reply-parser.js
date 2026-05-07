// /reply slash-command parser.
//
// Pure function — no side effects, no Svelte runes. Lives in its own module
// (separate from dm-parser.js) so the threading grammar stays orthogonal to
// the whisper grammar and is individually testable.
//
// See plans/threaded-replies-plan.md (artifact) §6 for the locked grammar.

/**
 * Parse a `/reply <message_id> <body>` slash command.
 *
 * Grammar (locked plan §6, mirroring the shape of dm-parser.js):
 *  1. Trigger: `^/reply\s+` after whitespace-trimming the input.
 *  2. Message id token: a single whitespace-delimited token immediately
 *     following the trigger. Must match the message UUID v4 shape (8-4-4-4-12
 *     lowercase hex with hyphens). The server validates existence + same-conv
 *     + depth-2 + non-system; this parser only screens the surface shape so
 *     malformed ids surface to the user before round-tripping.
 *  3. Body: everything after the message id token, with leading whitespace
 *     trimmed. Must be non-empty.
 *  4. Validation rejections — return `{ replyTo: null, body: '', error: '...' }`:
 *       - missing trigger → "Missing /reply trigger"
 *       - missing message id (`/reply`) → "Missing message id"
 *       - malformed message id (`/reply abc hi`) → "Invalid message id: <token>"
 *       - empty body (`/reply <id>`) → "Empty message body"
 *  5. On send (caller's job): pass `replyTo` to `MQTTStore.sendMessage(body,
 *     replyTo)`. The composer's existing /dm dispatcher pattern at
 *     MessageInput.svelte:879 is the model — a single trigger check, a parser
 *     call, then forward to the store.
 *
 * @param {string} input - raw composer input (un-trimmed)
 * @returns {{ replyTo: string | null, body: string, error: string | null }}
 */
export function parseReply(input) {
  const failure = (error) => ({ replyTo: null, body: '', error });

  if (typeof input !== 'string') return failure('Empty message body');

  // Step 1: trigger detection. Whitespace-trim left then require `/reply `.
  // Working against the trimmed-left view so leading whitespace doesn't
  // reject otherwise-valid input — same convention as dm-parser.js.
  const ltrimmed = input.replace(/^\s+/, '');
  if (!/^\/reply(\s|$)/.test(ltrimmed)) {
    return failure('Missing /reply trigger');
  }
  // Slice past the trigger. We require at least one whitespace char after
  // `/reply` for the id token to be present. Bare `/reply` with no
  // whitespace falls through to "Missing message id".
  const afterTrigger = ltrimmed.replace(/^\/reply\s*/, '');

  if (afterTrigger.length === 0) {
    return failure('Missing message id');
  }

  // Step 2: peel the message-id token off the front. A token is a maximal
  // run of non-whitespace characters. (No `@` prefix — message ids are bare
  // UUIDs, not participant references.)
  let idEnd = 0;
  while (
    idEnd < afterTrigger.length
    && afterTrigger.charCodeAt(idEnd) !== 0x20 /* space */
    && afterTrigger.charCodeAt(idEnd) !== 0x09 /* tab */
  ) {
    idEnd++;
  }
  const idToken = afterTrigger.slice(0, idEnd);

  // Surface-shape check: UUID v4 8-4-4-4-12 lowercase hex with hyphens.
  // Server is the authority on existence/same-conv/depth-2/non-system; this
  // is a cheap typo-screen so the user gets immediate feedback.
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
  if (!UUID_RE.test(idToken)) {
    return failure(`Invalid message id: ${idToken}`);
  }

  // Step 3: body is everything after the id token, with leading whitespace
  // trimmed.
  const body = afterTrigger.slice(idEnd).replace(/^\s+/, '');

  if (body.length === 0) {
    return failure('Empty message body');
  }

  return {
    replyTo: idToken,
    body,
    error: null,
  };
}
