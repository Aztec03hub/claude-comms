/**
 * Centralized empty-state copy for claude-comms UI components.
 *
 * Per Design Spec §11: friendly, brief, actionable. No "404"-style passive
 * voice. No "Oops!" — never trivialize. No emoji clutter. No em dashes in
 * the rendered strings (Phil's §I.6 rule #10 applies to anything that
 * shows up in the UI; em dashes are fine in this file's comments).
 *
 * v0.4.0 Step 2.16.
 *
 * Conventions:
 *   - Property = the empty-state surface. Value = the literal string or a
 *     function returning a string.
 *   - Each string ends with a period (sentence cadence) or a punctuation
 *     mark appropriate to the cadence; never a trailing em dash.
 *   - Filter-aware copy is exposed as a function so callers can pass the
 *     active filter text without re-implementing the template.
 *
 * Consumer status (v0.4.0 Step 2.16 landing):
 *   - MemberList.svelte           — adopts memberList* keys
 *   - ChatView.svelte             — adopts chatNoMessages* keys
 *   - Sidebar.svelte              — already free of em dashes, but the
 *                                   inline strings should switch to these
 *                                   constants in a follow-up step (this
 *                                   step's scope is the new module + the
 *                                   four named consumers).
 *   - SidebarChannelSection.svelte — passive (renders the `emptyState`
 *                                   prop verbatim); call-site adoption
 *                                   lives in Sidebar.svelte follow-up.
 *   - ChannelDirectoryModal.svelte — Browse tab delegates empty-state
 *                                   rendering to ConversationBrowser;
 *                                   adopts `noTopicSet` for the Admin
 *                                   row's topic fallback line.
 */

export const EMPTY_STATES = {
  // ── Sidebar channel sections ────────────────────────────────────────
  starred: 'No starred channels. Right-click a channel to star it.',
  active:
    "You haven't joined any channels yet. Browse the directory or create one.",
  available: 'No channels available. Create one to get started.',

  // ── Channel directory ──────────────────────────────────────────────
  archived: 'No archived channels.',
  privateChannels: 'No private channels. Create one or be invited.',
  noTopicSet: 'No topic set',

  // ── Member list (3 sections from v0.3.3 M-FIX) ──────────────────────
  memberListActive: 'No one is here yet. Invite someone.',
  memberListOnline: 'No one is online elsewhere.',
  memberListOffline: 'No one offline yet.',

  // ── Chat view (richer empty state with subtitle + hint) ─────────────
  chatNoMessages: 'No messages yet',
  chatNoMessagesSubtitle: 'This is the very beginning of the conversation.',
  chatNoMessagesHint: 'Type a message below to get things started.',

  // ── Pins / search ──────────────────────────────────────────────────
  pinsEmpty: 'No pinned messages.',
  searchEmpty: 'Nothing matches.',

  // ── Filter (function — takes the filter text) ──────────────────────
  filterEmpty: (filter) => `No channels match "${filter}".`,
};
