/**
 * lib/fetchFullVersion.js — bounded chunked-read helper for artifact content.
 *
 * Plain `.js` module (NOT `.svelte.js`): no runes declared here. Safe to import
 * from both rune modules and components.
 *
 * `comms_artifact_get` returns content in 50 KB chunks with `has_more` and
 * `next_offset`. The diff view needs the FULL content of two versions. The
 * v1 plan had a latent bug of diffing only the first chunk, and an unbounded
 * `while (has_more)` loop would hang the UI forever if a misbehaving daemon
 * returned a non-advancing `next_offset` (R2-9).
 *
 * Guards:
 *   - MAX_CHUNKS ceiling (20 × 50 KB = 1 MB hard stop).
 *   - MAX_TOTAL_CHARS running-total abort (250K char ceiling).
 *   - Non-advancing `next_offset` assertion throws immediately.
 *   - AbortSignal checked BEFORE each request and propagated into `apiGet`
 *     so the in-flight fetch is cancelled on component unmount.
 */

import { apiGet } from './api.js';

/** Hard cap on chunk count. 20 × 50 KB chunks = 1 MB ceiling. */
export const MAX_CHUNKS = 20;

/** Hard cap on assembled content length. Diffs beyond this are refused upstream. */
export const MAX_TOTAL_CHARS = 250_000;

/**
 * Fetch the full content of an artifact version by iterating `has_more` /
 * `next_offset` chunks. Bounded by `MAX_CHUNKS` and `MAX_TOTAL_CHARS`.
 *
 * @param {string} channel - Conversation / channel name.
 * @param {string} name    - Artifact name.
 * @param {number} version - Artifact version number.
 * @param {object} [opts]
 * @param {AbortSignal} [opts.signal] - Cancels in-flight fetch on component unmount.
 * @returns {Promise<{ content: string, meta: object }>} Assembled content and
 *   the metadata from the FINAL chunk response (includes `total_chars`, etc).
 * @throws {DOMException} `AbortError` if the signal aborts.
 * @throws {Error} If `next_offset` fails to advance (server bug / malicious).
 * @throws {Error} If assembled content exceeds `MAX_TOTAL_CHARS`.
 * @throws {Error} If the chunk count exceeds `MAX_CHUNKS`.
 */
export async function fetchFullVersion(channel, name, version, { signal } = {}) {
  let content = '';
  let offset = 0;
  for (let i = 0; i < MAX_CHUNKS; i++) {
    if (signal?.aborted) {
      throw new DOMException('Aborted', 'AbortError');
    }
    const path =
      `/api/artifacts/${encodeURIComponent(channel)}/${encodeURIComponent(name)}` +
      `?version=${version}&offset=${offset}`;
    const data = await apiGet(path, { signal });

    // R2-9: strict non-advancing guard — if the server reports has_more but
    // next_offset didn't move past our current offset, bail out immediately.
    if (data.has_more && (data.next_offset == null || data.next_offset <= offset)) {
      throw new Error('Chunked read failed: non-advancing next_offset');
    }

    content += data.content ?? '';

    if (content.length > MAX_TOTAL_CHARS) {
      throw new Error(
        `Artifact exceeds ${MAX_TOTAL_CHARS} char limit for diff view`,
      );
    }

    if (!data.has_more) {
      return { content, meta: data };
    }
    offset = data.next_offset;
  }
  throw new Error('Chunked read exceeded MAX_CHUNKS');
}
