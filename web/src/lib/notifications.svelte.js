/**
 * Browser Notification API wrapper with Svelte 5 runes.
 * Only sends notifications when the tab is not focused.
 * Supports optional notification sounds and click-to-focus.
 */

import { truncateText } from './utils.js';

let permission = $state(typeof Notification !== 'undefined' ? Notification.permission : 'denied');
let enabled = $state(true);
let soundEnabled = $state(false);
let tabFocused = $state(true);

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
 * Send a browser notification (only when tab is not focused).
 * Truncates long message bodies and includes the channel name in the body.
 * Clicking the notification focuses the app window.
 *
 * @param {string} title - Notification title (typically the sender name).
 * @param {object} options - Notification options.
 * @param {string} [options.body] - Message body text.
 * @param {string} [options.channel] - Channel name to display (e.g. "#general").
 * @param {string} [options.icon] - URL for the notification icon.
 * @param {string} [options.tag] - Tag for notification deduplication.
 * @param {*} [options.data] - Arbitrary data attached to the notification.
 * @returns {Notification|null} The created Notification, or null if suppressed.
 */
export function sendNotification(title, options = {}) {
  if (!enabled || tabFocused) return null;
  if (permission !== 'granted') return null;

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
