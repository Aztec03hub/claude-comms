// toast-coalesce.js — pure core of App.svelte's toast cap/coalesce (UX G-14).
//
// Extracted from App.svelte's addToast() so the (previously untested)
// coalesce algorithm can be unit-tested directly. App owns the reactive
// `toasts` $state + the per-toast expiry timers; this function owns only
// the array transformation + text generation, returning which timer to
// (re)schedule and which (if any) was evicted so the caller manages timers.
//
// Rules (mirrors the App.svelte comment):
//   1. Same-channel toast present -> coalesce into it: "<sender> and N
//      other(s) sent messages" (coalescedCount tracks total folded events).
//   2. At >= pillAt coalesced events -> collapse to a pill "+N new in #ch".
//   3. No same-channel toast and already at cap -> evict the OLDEST (FIFO),
//      then append the fresh toast.

/**
 * @param {Array<object>} toasts   Current visible toasts.
 * @param {object} incoming        New toast ({ id, channel, sender, messageId, ... }).
 * @param {{cap?: number, pillAt?: number}} [opts]
 * @returns {{ toasts: Array<object>, resetTimerId: string, evictedId: string|null }}
 */
export function applyToast(toasts, incoming, { cap = 3, pillAt = 5 } = {}) {
  const sameChannelIdx = toasts.findIndex((t) => t.channel === incoming.channel);

  if (sameChannelIdx >= 0) {
    const existing = toasts[sameChannelIdx];
    const coalescedCount = (existing.coalescedCount ?? 1) + 1;

    let updated;
    if (coalescedCount >= pillAt) {
      updated = {
        ...existing,
        pill: true,
        coalescedCount,
        sender: existing.sender, // keep for color/initials fallback
        text: `+${coalescedCount} new in #${incoming.channel}`,
        messageId: incoming.messageId ?? existing.messageId,
      };
    } else {
      const others = coalescedCount - 1;
      updated = {
        ...existing,
        pill: false,
        coalescedCount,
        sender: incoming.sender, // freshest sender for name/color
        text: `${incoming.sender?.name ?? 'someone'} and ${others} other${others === 1 ? '' : 's'} sent messages`,
        messageId: incoming.messageId ?? existing.messageId,
      };
    }

    // Coalesce keeps the existing toast's id so its timer stays attached;
    // the caller resets that timer so the merged toast stays visible.
    return {
      toasts: toasts.map((t, i) => (i === sameChannelIdx ? updated : t)),
      resetTimerId: existing.id,
      evictedId: null,
    };
  }

  // No same-channel match. Evict the oldest (FIFO) if we're at the cap.
  let next = toasts;
  let evictedId = null;
  if (next.length >= cap) {
    evictedId = next[0].id;
    next = next.slice(1);
  }
  const fresh = { ...incoming, coalescedCount: 1, pill: false };
  return {
    toasts: [...next, fresh],
    resetTimerId: fresh.id,
    evictedId,
  };
}
