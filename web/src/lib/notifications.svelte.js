/**
 * Browser Notification API wrapper with Svelte 5 runes.
 * Only sends notifications when the tab is not focused.
 */

let permission = $state(typeof Notification !== 'undefined' ? Notification.permission : 'denied');
let enabled = $state(true);
let tabFocused = $state(true);

// Track tab focus
if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    tabFocused = !document.hidden;
  });

  window.addEventListener('focus', () => { tabFocused = true; });
  window.addEventListener('blur', () => { tabFocused = false; });
}

/**
 * Request notification permission from the browser.
 * @returns {Promise<string>}
 */
export async function requestPermission() {
  if (typeof Notification === 'undefined') return 'denied';
  const result = await Notification.requestPermission();
  permission = result;
  return result;
}

/**
 * Send a browser notification (only when tab is not focused).
 * @param {string} title
 * @param {object} options - { body, icon, tag, data }
 * @returns {Notification|null}
 */
export function sendNotification(title, options = {}) {
  if (!enabled || tabFocused) return null;
  if (permission !== 'granted') return null;

  const notification = new Notification(title, {
    body: options.body || '',
    icon: options.icon || undefined,
    tag: options.tag || undefined,
    data: options.data || undefined,
    silent: false
  });

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
 * Get current notification state.
 */
export function getNotificationState() {
  return {
    get permission() { return permission; },
    get enabled() { return enabled; },
    get tabFocused() { return tabFocused; }
  };
}
