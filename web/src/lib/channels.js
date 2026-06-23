/**
 * Shared channel constants for the web client.
 *
 * Mirrors the backend ``RESERVED_CONVERSATION_NAMES`` frozenset in
 * ``src/claude_comms/conversation.py``. These channels are structural
 * (the system lobby + system bus) and the daemon hard-refuses
 * delete/archive on them regardless of caller role. The client uses this
 * set to avoid offering a Delete/Close/Archive affordance that would
 * always be refused server-side.
 *
 * Keep this in lockstep with the Python source of truth.
 */
export const RESERVED_CHANNELS = Object.freeze(['general', 'system']);

/**
 * True when ``channelId`` is a reserved channel that cannot be
 * deleted or archived by anyone.
 *
 * @param {string | null | undefined} channelId
 * @returns {boolean}
 */
export function isReservedChannel(channelId) {
  return typeof channelId === 'string' && RESERVED_CHANNELS.includes(channelId);
}
