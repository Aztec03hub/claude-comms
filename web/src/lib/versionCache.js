/**
 * lib/versionCache.js — per-artifact-version LRU cache (§2 "Too-large guard").
 *
 * Plain `.js` module (NOT `.svelte.js`): no runes declared here.
 *
 * Avoids re-fetching when the user flips between the same two versions in the
 * diff dropdown. Entries are keyed by `${channel}:${name}:${version}` and hold
 * the full `{ content, meta }` tuple returned by `fetchFullVersion`.
 *
 * LRU semantics: `Map` preserves insertion order, so `get()` re-inserts the
 * entry to mark it as most-recently-used, and when the cache exceeds
 * `MAX_ENTRIES` we drop the first (oldest) entry via `keys().next().value`.
 *
 * Invalidation: `invalidate(channel, name)` drops all entries for a given
 * artifact — called from the panel when `artifactsDirty` ticks for that name.
 */

/** Maximum number of cached versions. Tunable; plan specifies 8. */
export const MAX_ENTRIES = 8;

/** key → { content, meta }. Iteration order = insertion order = LRU age. */
const cache = new Map();

/** Build the stable cache key for a specific artifact version. */
function keyOf(channel, name, version) {
  return `${channel}:${name}:${version}`;
}

/**
 * Retrieve a cached `{ content, meta }` entry, or `undefined` if absent.
 * Touching an entry refreshes its LRU position.
 *
 * @param {string} channel
 * @param {string} name
 * @param {number|string} version
 * @returns {{ content: string, meta: object } | undefined}
 */
export function get(channel, name, version) {
  const k = keyOf(channel, name, version);
  if (!cache.has(k)) return undefined;
  const value = cache.get(k);
  // Refresh LRU position: delete + set pushes to end (most-recent).
  cache.delete(k);
  cache.set(k, value);
  return value;
}

/**
 * Store a `{ content, meta }` entry. Evicts the oldest entry when the cache
 * exceeds `MAX_ENTRIES`.
 *
 * @param {string} channel
 * @param {string} name
 * @param {number|string} version
 * @param {{ content: string, meta: object }} data
 */
export function set(channel, name, version, data) {
  const k = keyOf(channel, name, version);
  // If updating an existing entry, delete first so the re-insertion moves it
  // to the tail (most-recently-used).
  if (cache.has(k)) cache.delete(k);
  cache.set(k, data);
  while (cache.size > MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

/**
 * Drop ALL cached entries for the given `{channel, name}` pair (all versions).
 * Call this when an artifact is updated (new version) so stale entries don't
 * mask the new content.
 *
 * @param {string} channel
 * @param {string} name
 */
export function invalidate(channel, name) {
  const prefix = `${channel}:${name}:`;
  for (const k of Array.from(cache.keys())) {
    if (k.startsWith(prefix)) cache.delete(k);
  }
}

/**
 * Clear the entire cache. Primarily for tests; callers in production should
 * use `invalidate()` per artifact.
 */
export function clear() {
  cache.clear();
}

/** @returns {number} Current number of cached entries (for tests / debug). */
export function size() {
  return cache.size;
}
