// /dm slash-command parser.
//
// Pure function — no side effects, no Svelte runes. Lives in its own module
// (separate from `mentions.js`) so the autocomplete state machine and the
// slash-command grammar stay orthogonal and individually testable.
//
// See plans/mentions-vs-whisper-separation.md §6.2-A for the locked grammar.

/**
 * Parse a `/dm @user[, @user2, ...] body` slash command.
 *
 * Grammar (locked plan §6.2-A):
 *  1. Trigger: `^/dm\s+` after whitespace-trimming the input.
 *  2. Recipient tokens: `@<name>` separated by whitespace, comma, or
 *     comma+whitespace. The recipient list ends at the first token that is
 *     NOT a `@<name>`.
 *  3. Each `@name` resolves via `participants` (a key->participant map) to a
 *     participant key. The wire-format `recipients` array always carries
 *     keys, never names. This bypasses the `comms_update_name` rename race
 *     entirely — once parsed, the recipient is locked to a stable key.
 *  4. Sender-key dedup at parse-time: drop the sender's own key silently
 *     from the resolved set. (Server-side dedup is also applied as defense
 *     in depth.)
 *  5. Body: everything after the recipient list, with leading whitespace
 *     trimmed. Step 7 (below) prepends body-side `@name` tokens.
 *  6. Validation rejections — return `{ recipients: [], body: '', error: '...' }`:
 *       - empty body after recipients (`/dm @ember`) → "Empty message body"
 *       - no recipients (`/dm hi`) → "No recipients specified"
 *       - unknown name (`/dm @notanyone hi`) → "Unknown recipient: @notanyone"
 *       - all recipients are sender (after dedup, recipients empty)
 *         → "Cannot DM yourself"
 *  7. Body composition: when stripping the recipient list, inject `@name`
 *     body tokens for each RESOLVED recipient (in order, deduped). So
 *     `/dm @ember hi` → body `"@ember hi"`. The injected tokens drive
 *     client-side mention classification (the server's bracket prefix is
 *     stripped wholesale by `parseMentions`; the body-side tokens are what
 *     reach the render loop).
 *  8. On send (caller's job): `recipients = [resolved keys]`, `mentions = null`.
 *
 * @param {string} input - raw composer input (un-trimmed)
 * @param {Record<string, {key: string, name: string}>} participants
 *        Store participants keyed by participant key.
 * @param {string} senderKey - store.userProfile.key (for sender-key dedup)
 * @returns {{ recipients: string[], body: string, error: string | null }}
 */
export function parseDM(input, participants, senderKey) {
  const failure = (error) => ({ recipients: [], body: '', error });

  if (typeof input !== 'string') return failure('Empty message body');

  // Step 1: trigger detection. Whitespace-trim left then require `/dm `.
  // We work against the trimmed-left view so leading whitespace doesn't
  // reject otherwise-valid input.
  const ltrimmed = input.replace(/^\s+/, '');
  if (!/^\/dm\s+/.test(ltrimmed)) {
    return failure('Missing /dm trigger');
  }
  // Slice past the trigger.
  const afterTrigger = ltrimmed.replace(/^\/dm\s+/, '');

  // Build a name->key index from `participants` (keyed by key).
  // Case-sensitive match (per plan §6.2-A bullet 3 — names resolve directly).
  /** @type {Map<string, string>} */
  const nameToKey = new Map();
  if (participants && typeof participants === 'object') {
    for (const [k, p] of Object.entries(participants)) {
      if (p && typeof p.name === 'string') {
        nameToKey.set(p.name, k);
      }
    }
  }

  // Step 2: peel recipient tokens off the front of `afterTrigger`.
  //
  // Token shape: `@<name>` where `<name>` matches `[\w.-]+` (same character
  // class as the autocomplete parser in mentions.js — keeps the grammars
  // consistent for hyphens, dots, and underscores in names).
  //
  // Separators between tokens: whitespace OR comma OR comma+whitespace.
  // Walk character-by-character: greedily peel `@name` then optional
  // separator. Stop at first failure.
  /** @type {string[]} */
  const resolvedKeys = [];
  /** @type {Set<string>} */
  const resolvedKeysSeen = new Set();
  let pos = 0;

  while (pos < afterTrigger.length) {
    // Token must start with `@`.
    if (afterTrigger.charCodeAt(pos) !== 0x40 /* @ */) break;
    // Read `@name` greedily. Name char class: [A-Za-z0-9_-] — matches the
    // server-authoritative grammar (NAME_PATTERN `^[\w-]{1,64}$` in
    // src/claude_comms/mention.py). A dot is not a valid name char.
    let nameEnd = pos + 1;
    while (
      nameEnd < afterTrigger.length
      && /[\w-]/.test(afterTrigger[nameEnd])
    ) {
      nameEnd++;
    }
    if (nameEnd === pos + 1) {
      // `@` not followed by any name char — not a recipient token.
      break;
    }
    const name = afterTrigger.slice(pos + 1, nameEnd);

    // Resolve this name. On miss, reject the whole input.
    const key = nameToKey.get(name);
    if (!key) {
      return failure(`Unknown recipient: @${name}`);
    }

    // Sender-key dedup at parse-time: silently drop sender's own key.
    // Per-name dedup also: don't double-list the same recipient.
    if (key !== senderKey && !resolvedKeysSeen.has(key)) {
      resolvedKeysSeen.add(key);
      resolvedKeys.push(key);
    }

    // Advance past the token. Separator: whitespace, OR comma + optional
    // whitespace. After consuming the separator we loop to peel the next
    // token. If there's no separator, we treat the body as starting here.
    pos = nameEnd;

    // Try to consume a separator.
    let separatorConsumed = false;
    // Optional comma.
    if (pos < afterTrigger.length && afterTrigger.charCodeAt(pos) === 0x2c /* , */) {
      pos++;
      separatorConsumed = true;
    }
    // Trailing whitespace (after comma OR standalone separator).
    while (
      pos < afterTrigger.length
      && (afterTrigger.charCodeAt(pos) === 0x20 || afterTrigger.charCodeAt(pos) === 0x09)
    ) {
      pos++;
      separatorConsumed = true;
    }
    if (!separatorConsumed) {
      // No separator after token. The next character (if any) is body.
      break;
    }
    // Loop continues: try to read another `@name` at the new pos. If it
    // fails the `@`-check, `pos` is left at the start of the body.
  }

  // Recipient list resolved. Body is everything remaining, with leading
  // whitespace trimmed (the separator loop already swallowed trailing
  // whitespace before exit, but a comma-only separator could leave the
  // body un-trimmed; trim here for safety).
  const body = afterTrigger.slice(pos).replace(/^\s+/, '');

  // Step 6: validation.
  // Order matters — "all recipients are self" is reachable only when there
  // were name tokens to begin with. We surface the more specific error
  // first when both apply (no recipients AND body present hits "no
  // recipients"; recipients-but-all-self hits "cannot DM yourself").
  if (resolvedKeysSeen.size === 0) {
    // Zero resolved tokens. Distinguish "user wrote names but they were all
    // self" (cannot DM yourself) from "user wrote no names" (no recipients).
    // We can't tell the two apart purely from `resolvedKeys` because dedup
    // discards self silently. Re-scan the trigger output for any `@name`
    // tokens that resolved to senderKey.
    //
    // Cheap re-check: walk the prefix again counting tokens that resolve to
    // senderKey. If any, it's a "cannot DM yourself"; else "no recipients".
    let selfTokens = 0;
    let totalTokens = 0;
    let p2 = 0;
    while (p2 < afterTrigger.length) {
      if (afterTrigger.charCodeAt(p2) !== 0x40) break;
      let ne = p2 + 1;
      while (ne < afterTrigger.length && /[\w-]/.test(afterTrigger[ne])) ne++;
      if (ne === p2 + 1) break;
      const nm = afterTrigger.slice(p2 + 1, ne);
      const k = nameToKey.get(nm);
      if (!k) break; // unknown name would have already errored above
      totalTokens++;
      if (k === senderKey) selfTokens++;
      p2 = ne;
      let consumed = false;
      if (p2 < afterTrigger.length && afterTrigger.charCodeAt(p2) === 0x2c) { p2++; consumed = true; }
      while (
        p2 < afterTrigger.length
        && (afterTrigger.charCodeAt(p2) === 0x20 || afterTrigger.charCodeAt(p2) === 0x09)
      ) { p2++; consumed = true; }
      if (!consumed) break;
    }
    if (totalTokens > 0 && selfTokens === totalTokens) {
      return failure('Cannot DM yourself');
    }
    return failure('No recipients specified');
  }

  if (body.length === 0) {
    return failure('Empty message body');
  }

  // Step 7: body composition. Prepend `@name` tokens for each resolved
  // recipient (in resolved order), space-separated, then a single space,
  // then the user-typed body. This drives client-side mention classification
  // (the server's bracket prefix is stripped wholesale by parseMentions; the
  // body-side tokens are what reach the render loop).
  //
  // Map resolvedKeys back to participant names so the body reads as
  // `@<displayName>` rather than `@<key>`.
  /** @type {string[]} */
  const recipientBodyTokens = [];
  // Build reverse index key->name from participants (already iterated above,
  // but we don't have it cached as an object).
  for (const k of resolvedKeys) {
    const p = participants?.[k];
    const nm = p?.name;
    if (typeof nm === 'string' && nm.length > 0) {
      recipientBodyTokens.push(`@${nm}`);
    }
  }
  const composedBody = recipientBodyTokens.length > 0
    ? recipientBodyTokens.join(' ') + ' ' + body
    : body;

  return {
    recipients: resolvedKeys,
    body: composedBody,
    error: null,
  };
}
