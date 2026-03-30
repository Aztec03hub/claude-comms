/**
 * Format a timestamp for display.
 * @param {string} isoString - ISO 8601 timestamp
 * @param {'full'|'time'|'short'|'relative'} mode
 * @returns {string}
 */
export function formatTime(isoString, mode = 'full') {
  const date = new Date(isoString);
  const now = new Date();

  if (mode === 'relative') {
    const diffMs = now - date;
    const diffMin = Math.floor(diffMs / 60000);
    const diffHr = Math.floor(diffMs / 3600000);
    const diffDay = Math.floor(diffMs / 86400000);

    if (diffMin < 1) return 'now';
    if (diffMin < 60) return `${diffMin}m`;
    if (diffHr < 24) return `${diffHr}h`;
    if (diffDay < 7) return `${diffDay}d`;
    return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  }

  if (mode === 'time') {
    return date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
  }

  if (mode === 'short') {
    return date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
  }

  // full
  const isToday = date.toDateString() === now.toDateString();
  const prefix = isToday ? 'Today' : date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  const time = date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
  return `${prefix} at ${time}`;
}

/**
 * Format a date for the date separator pill.
 * @param {string} isoString
 * @returns {string}
 */
export function formatDateSeparator(isoString) {
  const date = new Date(isoString);
  const now = new Date();
  const isToday = date.toDateString() === now.toDateString();
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  const isYesterday = date.toDateString() === yesterday.toDateString();

  if (isToday) {
    return 'Today \u2014 ' + date.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
  }
  if (isYesterday) {
    return 'Yesterday \u2014 ' + date.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
  }
  return date.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
}

/**
 * Parse @mentions from message body text.
 * Returns segments of {type: 'text'|'mention', value: string}.
 *
 * Handles edge cases:
 * - Mentions at start/end of string ("@phil hello", "hello @phil")
 * - Adjacent mentions ("@phil@claude" becomes two separate mentions)
 * - Mentions after newlines
 * - Empty/null input returns empty array
 *
 * @param {string} body - The raw message text.
 * @returns {Array<{type: string, value: string}>}
 */
export function parseMentions(body) {
  if (!body) return [];

  // First, strip the MCP-generated [@name1, @name2] prefix since it duplicates
  // the recipients metadata.  The bracket prefix is for human readability in
  // raw payloads; the web UI shows a "targeted" indicator instead.
  const stripped = body.replace(/^\[(@[\w-]+(?:\s*,\s*@[\w-]+)*)\]\s*/, '');

  // Match @mention preceded by start-of-string, whitespace, or another @
  // This ensures "@foo@bar" is parsed as two mentions, and "email@host" is not
  const mentionRegex = /(?:^|(?<=[\s@]))@[\w-]+/g;
  const segments = [];
  let lastIndex = 0;
  let match;

  while ((match = mentionRegex.exec(stripped)) !== null) {
    if (match.index > lastIndex) {
      segments.push({ type: 'text', value: stripped.slice(lastIndex, match.index) });
    }
    segments.push({ type: 'mention', value: match[0] });
    lastIndex = match.index + match[0].length;
  }

  if (lastIndex < stripped.length) {
    segments.push({ type: 'text', value: stripped.slice(lastIndex) });
  }

  // Filter out empty text segments that can occur with adjacent mentions
  return segments.filter(s => s.value.length > 0);
}

/**
 * Parse inline code from message body text.
 * Returns segments of {type: 'text'|'code', value: string}.
 * @param {string} text
 * @returns {Array<{type: string, value: string}>}
 */
export function parseInlineCode(text) {
  const codeRegex = /`([^`]+)`/g;
  const segments = [];
  let lastIndex = 0;
  let match;

  while ((match = codeRegex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      segments.push({ type: 'text', value: text.slice(lastIndex, match.index) });
    }
    segments.push({ type: 'code', value: match[1] });
    lastIndex = match.index + match[0].length;
  }

  if (lastIndex < text.length) {
    segments.push({ type: 'text', value: text.slice(lastIndex) });
  }

  return segments;
}

/**
 * Color palette for participant avatars.
 * Each entry: [gradientStart, gradientEnd, textColor]
 */
const AVATAR_COLORS = [
  ['#059669', '#34d399', '#34d399'],   // green (veridian)
  ['#b45309', '#f59e0b', '#f59e0b'],   // amber (human/phil)
  ['#92700c', '#fbbf24', '#fbbf24'],   // gold (MasterSensei)
  ['#be123c', '#fb7185', '#fb7185'],   // rose (nebula)
  ['#7c3aed', '#a78bfa', '#a78bfa'],   // violet
  ['#0369a1', '#38bdf8', '#38bdf8'],   // sky
  ['#b91c1c', '#f87171', '#f87171'],   // red
  ['#4338ca', '#818cf8', '#818cf8'],   // indigo
];

/**
 * Get a consistent color for a participant based on their key.
 * @param {string} key - Participant key (8 hex chars)
 * @returns {{ gradient: string, textColor: string }}
 */
export function getParticipantColor(key) {
  let hash = 0;
  for (let i = 0; i < key.length; i++) {
    hash = ((hash << 5) - hash) + key.charCodeAt(i);
    hash |= 0;
  }
  const idx = Math.abs(hash) % AVATAR_COLORS.length;
  const [start, end, textColor] = AVATAR_COLORS[idx];
  return {
    gradient: 'linear-gradient(135deg, ' + start + ', ' + end + ')',
    textColor
  };
}

/**
 * Get initials from a display name.
 * @param {string} name
 * @returns {string}
 */
export function getInitials(name) {
  if (!name) return '?';
  // For claude-style names, take first letter of each part
  const parts = name.replace(/^claude-/i, 'C-').split(/[-\s]+/);
  if (parts.length >= 2) {
    return (parts[0][0] + parts[1][0]).toUpperCase();
  }
  return name.slice(0, 2).toUpperCase();
}

/**
 * Generate a random 8-char hex key.
 * @returns {string}
 */
export function generateKey() {
  const arr = new Uint8Array(4);
  crypto.getRandomValues(arr);
  return Array.from(arr, function(b) { return b.toString(16).padStart(2, '0'); }).join('');
}

/**
 * Generate a UUID v4.
 * @returns {string}
 */
export function generateUUID() {
  return crypto.randomUUID();
}

/**
 * Check if two dates are the same calendar day.
 */
export function isSameDay(a, b) {
  const da = new Date(a);
  const db = new Date(b);
  return da.getFullYear() === db.getFullYear()
    && da.getMonth() === db.getMonth()
    && da.getDate() === db.getDate();
}

/**
 * Format a timestamp as a human-readable relative time string.
 * Examples: "just now", "2 min ago", "1 hour ago", "yesterday", "3 days ago".
 * @param {string|Date} timestamp - ISO 8601 string or Date object.
 * @returns {string}
 */
export function formatRelativeTime(timestamp) {
  const date = timestamp instanceof Date ? timestamp : new Date(timestamp);
  const now = new Date();
  const diffMs = now - date;

  if (diffMs < 0) return 'just now'; // future dates treated as "now"

  const diffSec = Math.floor(diffMs / 1000);
  const diffMin = Math.floor(diffMs / 60000);
  const diffHr = Math.floor(diffMs / 3600000);
  const diffDay = Math.floor(diffMs / 86400000);

  if (diffSec < 60) return 'just now';
  if (diffMin === 1) return '1 min ago';
  if (diffMin < 60) return diffMin + ' min ago';
  if (diffHr === 1) return '1 hour ago';
  if (diffHr < 24) return diffHr + ' hours ago';

  // Check for "yesterday" by calendar day
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  if (date.toDateString() === yesterday.toDateString()) return 'yesterday';

  if (diffDay === 1) return 'yesterday';
  if (diffDay < 7) return diffDay + ' days ago';
  if (diffDay < 30) {
    const weeks = Math.floor(diffDay / 7);
    return weeks === 1 ? '1 week ago' : weeks + ' weeks ago';
  }

  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

/**
 * Truncate text to a maximum length, appending an ellipsis if truncated.
 * Tries to break at a word boundary when possible.
 * @param {string} text - The text to truncate.
 * @param {number} maxLength - Maximum character length (default 100).
 * @returns {string}
 */
export function truncateText(text, maxLength = 100) {
  if (!text || text.length <= maxLength) return text || '';

  // Try to break at a word boundary within the last 20% of maxLength
  const truncated = text.slice(0, maxLength);
  const lastSpace = truncated.lastIndexOf(' ', maxLength);
  if (lastSpace > maxLength * 0.8) {
    return truncated.slice(0, lastSpace) + '\u2026';
  }
  return truncated + '\u2026';
}

/**
 * Basic HTML sanitization to prevent XSS in rendered message text.
 * Escapes dangerous characters: &, <, >, ", ', and backtick.
 * @param {string} text - Raw text that may contain HTML.
 * @returns {string} Sanitized text safe for innerHTML rendering.
 */
export function sanitizeHtml(text) {
  if (!text) return '';
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
    .replace(/`/g, '&#96;');
}
