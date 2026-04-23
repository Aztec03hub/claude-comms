/**
 * Scoped localStorage helpers for starred artifacts.
 *
 * Storage layout (per plan §10 + "Scoped localStorage" R2-8 fix):
 *   key   = `claude-comms:${identityKey}:starred-artifacts`
 *   value = JSON-encoded object: `{ [conversation]: [name, ...] }`
 *
 * Scoping by identity ensures that two different users who share the same
 * browser profile do not see each other's stars. A 500-entry-per-conversation
 * cap (FIFO drop) protects against unbounded growth, and reconcile() prunes
 * entries whose backing artifact no longer exists.
 */

const STAR_CAP_PER_CONVERSATION = 500;

/** Build the localStorage key for a given identity. */
function storageKey(identityKey) {
  return `claude-comms:${identityKey}:starred-artifacts`;
}

/**
 * safeStorage — silently tolerates unavailable localStorage
 * (private-browsing modes, quota exceeded, disabled storage APIs).
 */
const safeStorage = {
  getItem(key) {
    try {
      return typeof localStorage !== 'undefined' ? localStorage.getItem(key) : null;
    } catch {
      return null;
    }
  },
  setItem(key, value) {
    try {
      if (typeof localStorage !== 'undefined') localStorage.setItem(key, value);
    } catch {
      // ignore: storage unavailable or quota exceeded
    }
  },
};

/**
 * Read the full `{ conversation: [name, ...] }` map for an identity.
 * Returns `{}` if no entry exists or the JSON is corrupt.
 * @param {string} identityKey
 * @returns {Record<string, string[]>}
 */
function loadAll(identityKey) {
  if (!identityKey) return {};
  const raw = safeStorage.getItem(storageKey(identityKey));
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
    return {};
  } catch {
    return {};
  }
}

/**
 * Persist the full `{ conversation: [name, ...] }` map for an identity.
 * @param {string} identityKey
 * @param {Record<string, string[]>} map
 */
function saveAll(identityKey, map) {
  if (!identityKey) return;
  safeStorage.setItem(storageKey(identityKey), JSON.stringify(map));
}

/**
 * Load the starred-artifact names for a (identity, conversation) pair.
 * Returns a fresh array copy — safe to mutate without affecting storage.
 * @param {string} identityKey - Current user identity key (8 hex chars).
 * @param {string} conversation - Conversation/channel id.
 * @returns {string[]}
 */
export function loadStarred(identityKey, conversation) {
  if (!identityKey || !conversation) return [];
  const all = loadAll(identityKey);
  const list = all[conversation];
  return Array.isArray(list) ? [...list] : [];
}

/**
 * Toggle the star state for an artifact name. Returns the NEW state
 * (true = now starred, false = now unstarred). Enforces the 500 cap
 * by FIFO-dropping the oldest entry when adding would exceed it.
 *
 * @param {string} identityKey
 * @param {string} conversation
 * @param {string} name - Artifact name.
 * @returns {boolean} true if now starred, false if now unstarred.
 */
export function toggleStar(identityKey, conversation, name) {
  if (!identityKey || !conversation || !name) return false;
  const all = loadAll(identityKey);
  const list = Array.isArray(all[conversation]) ? [...all[conversation]] : [];
  const idx = list.indexOf(name);
  let nowStarred;
  if (idx >= 0) {
    list.splice(idx, 1);
    nowStarred = false;
  } else {
    list.push(name);
    // FIFO cap
    while (list.length > STAR_CAP_PER_CONVERSATION) list.shift();
    nowStarred = true;
  }
  all[conversation] = list;
  saveAll(identityKey, all);
  return nowStarred;
}

/**
 * Reconcile stored stars against the current artifact names list for a
 * conversation. Drops entries that no longer exist, enforces the 500 cap,
 * and persists the cleaned list back to storage. Returns the cleaned list.
 *
 * @param {string} identityKey
 * @param {string} conversation
 * @param {Iterable<string>} existingNames - Names currently present in the conversation.
 * @returns {string[]} The cleaned list of starred names.
 */
export function reconcile(identityKey, conversation, existingNames) {
  if (!identityKey || !conversation) return [];
  const existingSet = new Set(existingNames || []);
  const all = loadAll(identityKey);
  const prior = Array.isArray(all[conversation]) ? all[conversation] : [];
  let cleaned = prior.filter((name) => existingSet.has(name));
  // Enforce cap (FIFO drop from the front)
  if (cleaned.length > STAR_CAP_PER_CONVERSATION) {
    cleaned = cleaned.slice(cleaned.length - STAR_CAP_PER_CONVERSATION);
  }
  // Only persist if we actually changed something to avoid storage churn
  if (cleaned.length !== prior.length || cleaned.some((v, i) => v !== prior[i])) {
    all[conversation] = cleaned;
    saveAll(identityKey, all);
  }
  return [...cleaned];
}

export const __STAR_CAP_PER_CONVERSATION = STAR_CAP_PER_CONVERSATION;
