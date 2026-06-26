/**
 * Browser Notification API wrapper with Svelte 5 runes.
 * Only sends notifications when the tab is not focused.
 * Supports optional notification sounds and click-to-focus.
 *
 * v0.4.2 Wave G follow-up [VERIFY-WAVE-G-4]: this module now honors
 * per-channel notification policy on the browser ``Notification`` path,
 * mirroring the App.svelte in-app toast policy gate from Wave G. The
 * gate runs inside ``sendNotification`` itself so any caller benefits;
 * the policy data is supplied via the new ``options.channel``,
 * ``options.mentions``, ``options.muted``, and ``options.userKey``
 * fields (all optional). When no channel context is supplied the gate
 * is bypassed and the legacy (pre-G) "fire if focused-elsewhere"
 * behavior is preserved so the new fields are strictly additive.
 *
 * Resolution priority:
 *   1. If ``options.notificationPolicy`` is passed explicitly
 *      (``{policy, highlightWords}``) we use it directly.
 *   2. Otherwise, if a resolver has been registered via
 *      ``setNotificationPolicyResolver`` AND ``options.channel`` is
 *      supplied, we call ``resolver(options.channel)``. This is how
 *      Sidebar.svelte wires the live ``store.getNotificationPolicy``.
 *   3. Otherwise the gate falls back to ``{policy: 'All',
 *      highlightWords: []}`` (legacy behavior: every message fires).
 *
 * The decision tree mirrors App.svelte:541-573 exactly so the in-app
 * toast and the browser Notification fire/suppress together for any
 * given message.
 */

import { truncateText } from './utils.js';

let permission = $state(typeof Notification !== 'undefined' ? Notification.permission : 'denied');
let enabled = $state(true);
let soundEnabled = $state(false);
let tabFocused = $state(true);

/**
 * Registered resolver for per-channel notification policy. Sidebar.svelte
 * (or any other host) injects ``(channelId) => store.getNotificationPolicy(channelId)``
 * via ``setNotificationPolicyResolver``. Kept as a plain module-level
 * function reference (NOT a ``$state``) because consumers do not need
 * reactivity on the resolver identity itself, only on the values it
 * returns, which the resolver itself reads from a reactive store.
 *
 * @type {((channelId: string) => {policy: string, highlightWords: string[]}) | null}
 */
let policyResolver = null;

/** @type {AudioContext|null} */
let audioCtx = null;

// Track tab focus
if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    tabFocused = !document.hidden;
  });

  window.addEventListener('focus', () => { tabFocused = true; });
  window.addEventListener('blur', () => { tabFocused = false; });
}

/**
 * Play a short placeholder beep sound for notifications.
 * Uses the Web Audio API to synthesize a tone (no audio file needed).
 */
function playNotificationSound() {
  if (!soundEnabled) return;
  try {
    if (!audioCtx) {
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    }
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.connect(gain);
    gain.connect(audioCtx.destination);

    osc.type = 'sine';
    osc.frequency.setValueAtTime(880, audioCtx.currentTime); // A5
    gain.gain.setValueAtTime(0.15, audioCtx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.3);

    osc.start(audioCtx.currentTime);
    osc.stop(audioCtx.currentTime + 0.3);
  } catch {
    // Audio not available — silently ignore
  }
}

/**
 * Request notification permission from the browser.
 * @returns {Promise<string>} The permission result: 'granted', 'denied', or 'default'.
 */
export async function requestPermission() {
  if (typeof Notification === 'undefined') return 'denied';
  const result = await Notification.requestPermission();
  permission = result;
  return result;
}

/**
 * Register the per-channel notification policy resolver used by the
 * browser Notification policy gate. Hosts (Sidebar.svelte mounts the
 * store and registers ``(id) => store.getNotificationPolicy(id)``)
 * should call this once at startup. Passing ``null`` clears the
 * resolver and the gate reverts to the legacy "fire whenever
 * unfocused" behavior (used for tests + non-store hosts).
 *
 * @param {((channelId: string) => {policy: string, highlightWords: string[]}) | null} resolver
 */
export function setNotificationPolicyResolver(resolver) {
  policyResolver = typeof resolver === 'function' ? resolver : null;
}

/**
 * Resolve the active policy + highlight-word list for a given channel,
 * preferring an explicit ``options.notificationPolicy`` over the
 * registered resolver, and falling back to ``{policy: 'All',
 * highlightWords: []}`` when neither is available. Pure helper exported
 * for test-targeting; ``sendNotification`` uses it inline.
 *
 * @param {{notificationPolicy?: {policy: string, highlightWords: string[]}, channel?: string}} opts
 * @returns {{policy: string, highlightWords: string[]}}
 */
export function resolveNotificationPolicy(opts) {
  const o = opts ?? {};
  if (o.notificationPolicy && typeof o.notificationPolicy === 'object') {
    const p = o.notificationPolicy;
    return {
      policy: typeof p.policy === 'string' ? p.policy : 'All',
      highlightWords: Array.isArray(p.highlightWords) ? p.highlightWords : [],
    };
  }
  if (typeof o.channel === 'string' && o.channel && typeof policyResolver === 'function') {
    try {
      const resolved = policyResolver(o.channel);
      if (resolved && typeof resolved === 'object') {
        return {
          policy: typeof resolved.policy === 'string' ? resolved.policy : 'All',
          highlightWords: Array.isArray(resolved.highlightWords) ? resolved.highlightWords : [],
        };
      }
    } catch {
      // Resolver threw. Fall through to defaults.
    }
  }
  return { policy: 'All', highlightWords: [] };
}

/**
 * Apply the Wave G policy + mute decision tree to decide whether a
 * browser Notification should fire for a given (policy, mentions,
 * muted, body) tuple. Mirrors App.svelte:541-573 exactly so the
 * in-app toast and the browser Notification stay in lockstep.
 *
 *   - ``policy='Off'``      → never notify.
 *   - ``policy='Mentions'`` → notify only on @mention or highlight-word match.
 *   - ``policy='All'``      → notify always EXCEPT when channel is muted
 *                             AND the message is not a mention.
 *
 * A formal @mention OR a highlight-word substring hit counts as a
 * mention for both the policy=Mentions short-circuit AND the
 * muted-bypass. Exported for test-targeting.
 *
 * @param {{policy: string, highlightWords: string[]}} policy
 * @param {{mentions?: string[], userKey?: string, muted?: boolean, body?: string}} ctx
 * @returns {boolean} true when the Notification should fire.
 */
export function shouldNotifyForPolicy(policy, ctx) {
  const p = policy ?? { policy: 'All', highlightWords: [] };
  const c = ctx ?? {};
  const isFormalMention =
    Array.isArray(c.mentions) &&
    typeof c.userKey === 'string' &&
    c.userKey.length > 0 &&
    c.mentions.includes(c.userKey);
  const body = typeof c.body === 'string' ? c.body.toLowerCase() : '';
  const isHighlightHit =
    !isFormalMention &&
    Array.isArray(p.highlightWords) &&
    p.highlightWords.length > 0 &&
    body.length > 0 &&
    p.highlightWords.some((w) => typeof w === 'string' && w.length > 0 && body.includes(w.toLowerCase()));
  const msgIsMention = isFormalMention || isHighlightHit;

  let shouldNotify;
  if (p.policy === 'Off') {
    shouldNotify = false;
  } else if (p.policy === 'Mentions') {
    shouldNotify = msgIsMention;
  } else {
    // 'All' (or any legacy unset value; defaults flow through here).
    shouldNotify = true;
  }

  // Legacy mute flag: suppress ordinary notifies, but never override a
  // mention/highlight hit. Matches the App.svelte toast bug fix.
  if (shouldNotify && c.muted === true && !msgIsMention) {
    shouldNotify = false;
  }
  return shouldNotify;
}

/**
 * Send a browser notification (only when tab is not focused).
 * Truncates long message bodies and includes the channel name in the body.
 * Clicking the notification focuses the app window.
 *
 * v0.4.2 Wave G follow-up [VERIFY-WAVE-G-4]: gates the browser
 * Notification through the per-channel notification policy when
 * channel context is supplied. The gate is strictly additive: when
 * neither ``options.notificationPolicy`` is supplied NOR an
 * ``options.channel`` lookup hits a registered resolver, the gate
 * falls back to ``{policy: 'All'}`` and behaves identically to the
 * pre-G implementation.
 *
 * @param {string} title - Notification title (typically the sender name).
 * @param {object} options - Notification options.
 * @param {string} [options.body] - Message body text.
 * @param {string} [options.channel] - Channel id (used to resolve policy
 *   via the registered resolver). Also used cosmetically in the body.
 * @param {string} [options.icon] - URL for the notification icon.
 * @param {string} [options.tag] - Tag for notification deduplication.
 * @param {*} [options.data] - Arbitrary data attached to the notification.
 * @param {string[]} [options.mentions] - User keys @mentioned in this message.
 * @param {string} [options.userKey] - The receiving user's key (compared
 *   against ``mentions`` to detect formal @mentions).
 * @param {boolean} [options.muted] - Whether the receiving user has the
 *   channel muted (legacy ``ch.muted`` flag).
 * @param {{policy: string, highlightWords: string[]}} [options.notificationPolicy] -
 *   Explicit policy override. Takes precedence over the registered resolver.
 * @returns {Notification|null} The created Notification, or null if suppressed.
 */
export function sendNotification(title, options = {}) {
  if (!enabled || tabFocused) return null;
  if (permission !== 'granted') return null;

  // [VERIFY-WAVE-G-4] policy gate. Resolved up-front so the failure
  // case short-circuits before the body string-build below.
  const policy = resolveNotificationPolicy(options);
  const shouldFire = shouldNotifyForPolicy(policy, {
    mentions: options.mentions,
    userKey: options.userKey,
    muted: options.muted === true,
    body: options.body,
  });
  if (!shouldFire) return null;

  // Format body: include channel name and truncate long messages
  let body = options.body || '';
  body = truncateText(body, 200);
  if (options.channel) {
    body = '#' + options.channel + ': ' + body;
  }

  const notification = new Notification(title, {
    body,
    icon: options.icon || undefined,
    tag: options.tag || undefined,
    data: options.data || undefined,
    silent: soundEnabled // suppress default sound when we play our own
  });

  // Click handler: focus the app window
  notification.onclick = () => {
    if (typeof window !== 'undefined') {
      window.focus();
    }
    notification.close();
  };

  // Play notification sound
  playNotificationSound();

  // Auto-close after 5 seconds
  setTimeout(() => notification.close(), 5000);

  return notification;
}

/**
 * Toggle notification enabled state.
 */
export function toggleNotifications() {
  enabled = !enabled;
}

/**
 * Toggle notification sound on/off.
 */
export function toggleSound() {
  soundEnabled = !soundEnabled;
}

/**
 * Get current notification state (reactive getters).
 * @returns {{ permission: string, enabled: boolean, soundEnabled: boolean, tabFocused: boolean }}
 */
export function getNotificationState() {
  return {
    get permission() { return permission; },
    get enabled() { return enabled; },
    get soundEnabled() { return soundEnabled; },
    get tabFocused() { return tabFocused; }
  };
}
