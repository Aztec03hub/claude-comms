<!--
  @component InviteParticipantDialog
  @description Modal dialog for inviting a participant into a channel
    (v0.4.2 Step 3.3, Wave F). Mounted from App.svelte in response to the
    "Invite participant..." action emitted by ChannelContextMenu via the
    ``claude-comms:invite-participant`` window CustomEvent bus (so the
    read-only Sidebar.svelte never has to learn the new action).

    UI layout:
      - Header: "Invite to #<channel-name>?"
      - Searchable participant picker:
          * single search input filters the ``participants`` prop by
            display-name substring (case-insensitive)
          * exclude: any key that is already a member of ``channel`` AND
            the caller's own key (``currentUserKey``)
          * results are alpha-sorted by display name; clicking a row
            selects it (radio-style: one selected at a time)
      - Optional note textarea (cap 200 chars; live counter on the side)
      - Footer: Cancel + Invite (Invite disabled until a target is picked)

    A11y mirrors LeaveChannelDialog / TypeNameConfirmDialog:
      - role="dialog" + aria-modal="true" + aria-labelledby
      - Default focus lands on the search input so a power user can
        type-to-filter immediately
      - Escape = onCancel; outside-click on overlay = onCancel
      - Focus trap: Tab cycles search → picker-row → note → Cancel →
        Invite → wrap. Submit is gated on a target being selected.

  @prop {object} channel - Channel object the invite is targeting.
    Consults ``.id``, ``.name``, and (for the existing-member exclude
    set) the parent supplies a pre-computed ``existingMemberKeys`` so
    this component never has to know how membership is stored.
  @prop {Array<{key: string, name: string}>} participants - Full
    participant registry (the store's ``participants`` map collapsed to
    an array). The picker filters this client-side.
  @prop {Array<string>} existingMemberKeys - Keys to exclude from the
    picker (current channel members + caller). The caller pre-computes
    so this component stays presentation-only.
  @prop {string} currentUserKey - Caller's 8-hex-char key. Excluded
    from the picker even if it leaks into existingMemberKeys.
  @prop {Function} onSubmit - Called as ``onSubmit({ inviteeKey, note })``
    when the user clicks Invite with a target selected. The host wires
    this to ``store.inviteParticipant`` and shows toast / banner.
  @prop {Function} onCancel - Called on Cancel, Escape, or outside-click.
-->
<script>
  import { tick } from 'svelte';
  import { X, Search, UserPlus } from 'lucide-svelte';

  let {
    channel,
    participants = [],
    existingMemberKeys = [],
    currentUserKey = '',
    onSubmit,
    onCancel,
  } = $props();

  // Stable element ids so aria-labelledby / aria-describedby resolve.
  const idSuffix = Math.random().toString(36).slice(2, 9);
  const titleId = `invite-dialog-title-${idSuffix}`;
  const searchId = `invite-dialog-search-${idSuffix}`;
  const noteId = `invite-dialog-note-${idSuffix}`;

  let query = $state('');
  let selectedKey = $state(/** @type {string | null} */ (null));
  let note = $state('');

  /** @type {HTMLDivElement | undefined} */
  let dialogEl = $state();
  /** @type {HTMLInputElement | undefined} */
  let searchEl = $state();

  // Capture previously-focused element for restore-on-unmount.
  /** @type {HTMLElement | null} */
  let previouslyFocused = null;

  // Exclude set: caller + existing members. Use a Set for O(1) lookup
  // during filter. Built as $derived so a hot-swap of props recomputes.
  let excludeKeys = $derived.by(() => {
    const set = new Set();
    if (currentUserKey) set.add(currentUserKey);
    if (Array.isArray(existingMemberKeys)) {
      for (const k of existingMemberKeys) {
        if (typeof k === 'string' && k) set.add(k);
      }
    }
    return set;
  });

  // Filtered + alpha-sorted candidate list. Substring match on display
  // name is case-insensitive; an empty query returns the full eligible
  // list so the user sees their options before typing.
  let candidates = $derived.by(() => {
    const q = (query ?? '').trim().toLowerCase();
    const list = [];
    if (Array.isArray(participants)) {
      for (const p of participants) {
        if (!p || typeof p.key !== 'string' || !p.key) continue;
        if (excludeKeys.has(p.key)) continue;
        const name = typeof p.name === 'string' ? p.name : '';
        if (q && !name.toLowerCase().includes(q)) continue;
        list.push({ key: p.key, name: name || p.key, type: p.type });
      }
    }
    list.sort((a, b) => a.name.localeCompare(b.name));
    return list;
  });

  // Submit is gated on a target being selected AND that target still
  // appearing in candidates (e.g. if the search query was changed after
  // selection and now excludes the previously-picked row, we drop the
  // selection rather than fire a stale invite).
  let canSubmit = $derived(
    selectedKey !== null && candidates.some((c) => c.key === selectedKey),
  );

  // Live char counter for the note field; cap at 200.
  const NOTE_MAX = 200;
  let noteLen = $derived((note ?? '').length);
  let noteOver = $derived(noteLen > NOTE_MAX);

  $effect(() => {
    previouslyFocused = /** @type {HTMLElement | null} */ (
      typeof document !== 'undefined' ? document.activeElement : null
    );
    // Default focus on the search input so typing filters immediately.
    queueMicrotask(() => {
      searchEl?.focus();
    });
    return () => {
      if (previouslyFocused && typeof previouslyFocused.focus === 'function') {
        previouslyFocused.focus();
      }
    };
  });

  function handleDialogKeydown(e) {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      onCancel?.();
      return;
    }
    if (e.key !== 'Tab') return;
    if (!dialogEl) return;
    const focusables = /** @type {HTMLElement[]} */ (
      Array.from(
        dialogEl.querySelectorAll(
          'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ),
      )
    );
    if (focusables.length === 0) return;
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    const active = /** @type {HTMLElement | null} */ (document.activeElement);
    if (e.shiftKey) {
      if (active === first || !dialogEl.contains(active)) {
        e.preventDefault();
        last.focus();
      }
    } else {
      if (active === last || !dialogEl.contains(active)) {
        e.preventDefault();
        first.focus();
      }
    }
  }

  function selectCandidate(key) {
    selectedKey = key;
  }

  function handleSubmit() {
    if (!canSubmit) return;
    const payload = {
      inviteeKey: selectedKey,
      note: noteOver ? (note ?? '').slice(0, NOTE_MAX) : (note ?? ''),
    };
    onSubmit?.(payload);
  }

  function handleOverlayClick(e) {
    // Only fire when the click landed on the overlay itself, not the
    // dialog content area (stopPropagation on the content guard).
    if (e.target === e.currentTarget) onCancel?.();
  }

  function handleContentClick(e) {
    e.stopPropagation();
  }

  // Keep the picker scroll position pinned to the top whenever the
  // query changes; otherwise a long candidate list mid-scroll could
  // hide newly-filtered rows. tick is wrapped in async/await so the
  // post-render layout has settled before we touch scrollTop.
  /** @type {HTMLDivElement | undefined} */
  let pickerEl = $state();
  $effect(() => {
    // Read query so this effect re-runs on input.
    void query;
    tick().then(() => {
      if (pickerEl) pickerEl.scrollTop = 0;
    });
  });

  // Friendly channel label for header copy. Display name beats slug.
  let channelLabel = $derived(channel?.name || channel?.id || '');
</script>

<!--
  Overlay + dialog content. Sibling structure (no portal) so tests
  mount + observe with @testing-library/svelte queries without portal
  escape hatches.
-->
<div
  class="invite-overlay"
  data-testid="invite-dialog-overlay"
  onclick={handleOverlayClick}
  onkeydown={handleDialogKeydown}
  role="presentation"
>
  <div
    bind:this={dialogEl}
    class="invite-modal"
    role="dialog"
    aria-modal="true"
    aria-labelledby={titleId}
    data-testid="invite-dialog"
    onclick={handleContentClick}
    onkeydown={handleDialogKeydown}
    tabindex="-1"
  >
    <div class="invite-header">
      <h2 id={titleId} class="invite-title" data-testid="invite-dialog-title">
        Invite to #{channelLabel}
      </h2>
      <button
        type="button"
        class="invite-close"
        aria-label="Close invite dialog"
        data-testid="invite-dialog-close"
        onclick={() => onCancel?.()}
      >
        <X size={14} aria-hidden="true" />
      </button>
    </div>

    <div class="invite-body">
      <label class="invite-label" for={searchId}>
        Find a participant
      </label>
      <div class="invite-search-wrap">
        <Search size={13} class="invite-search-icon" aria-hidden="true" />
        <input
          bind:this={searchEl}
          id={searchId}
          type="text"
          class="invite-search-input"
          placeholder="Search by name..."
          autocomplete="off"
          autocapitalize="off"
          autocorrect="off"
          spellcheck="false"
          data-testid="invite-dialog-search"
          bind:value={query}
        />
      </div>

      <div
        bind:this={pickerEl}
        class="invite-picker"
        role="listbox"
        aria-label="Participants available for invite"
        data-testid="invite-dialog-picker"
      >
        {#if candidates.length === 0}
          <div
            class="invite-empty"
            data-testid="invite-dialog-empty"
            role="status"
          >
            {query.trim()
              ? 'No matching participants.'
              : 'No participants available to invite.'}
          </div>
        {:else}
          {#each candidates as c (c.key)}
            <button
              type="button"
              class="invite-row"
              class:selected={selectedKey === c.key}
              role="option"
              aria-selected={selectedKey === c.key}
              data-testid="invite-dialog-row-{c.key}"
              data-row-key={c.key}
              onclick={() => selectCandidate(c.key)}
            >
              <span class="invite-row-avatar" aria-hidden="true">
                {c.name.slice(0, 2).toUpperCase()}
              </span>
              <span class="invite-row-name">{c.name}</span>
              {#if c.type === 'agent'}
                <span class="invite-row-tag" aria-label="agent participant">agent</span>
              {/if}
            </button>
          {/each}
        {/if}
      </div>

      <label class="invite-label" for={noteId}>
        Optional note <span class="invite-note-hint">(visible to the invitee in the system message)</span>
      </label>
      <textarea
        id={noteId}
        class="invite-note"
        class:over={noteOver}
        rows="2"
        maxlength={NOTE_MAX + 50}
        placeholder="Add an optional message..."
        data-testid="invite-dialog-note"
        bind:value={note}
      ></textarea>
      <div
        class="invite-note-counter"
        class:over={noteOver}
        data-testid="invite-dialog-note-counter"
      >
        {noteLen} / {NOTE_MAX}
      </div>
    </div>

    <div class="invite-footer">
      <button
        type="button"
        class="invite-btn secondary"
        data-testid="invite-dialog-cancel"
        onclick={() => onCancel?.()}
      >Cancel</button>
      <button
        type="button"
        class="invite-btn primary"
        disabled={!canSubmit || noteOver}
        aria-disabled={!canSubmit || noteOver}
        data-testid="invite-dialog-submit"
        onclick={handleSubmit}
      >
        <UserPlus size={13} aria-hidden="true" />
        Invite
      </button>
    </div>
  </div>
</div>

<style>
  .invite-overlay {
    position: fixed;
    inset: 0;
    z-index: 210;
    background: rgba(0, 0, 0, 0.6);
    backdrop-filter: blur(4px);
    display: flex;
    align-items: center;
    justify-content: center;
    animation: overlayIn 0.18s ease both;
  }

  .invite-modal {
    width: 480px;
    max-width: calc(100vw - 32px);
    max-height: calc(100vh - 64px);
    display: flex;
    flex-direction: column;
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 16px;
    box-shadow: 0 24px 64px rgba(0, 0, 0, 0.6), 0 0 0 1px rgba(255, 255, 255, 0.04);
    overflow: hidden;
    outline: none;
    animation: modalIn 0.3s cubic-bezier(0.16, 1, 0.3, 1) both;
  }

  .invite-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 18px 22px 12px;
  }

  .invite-title {
    font-size: 16px;
    font-weight: 700;
    letter-spacing: -0.3px;
    color: var(--text-primary);
    margin: 0;
  }

  .invite-close {
    width: 26px;
    height: 26px;
    border-radius: 6px;
    border: none;
    background: none;
    color: var(--text-faint);
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    transition: background 80ms ease, color 80ms ease;
  }
  .invite-close:hover {
    background: var(--bg-surface);
    color: var(--text-secondary);
  }

  .invite-body {
    padding: 4px 22px 12px;
    display: flex;
    flex-direction: column;
    gap: 8px;
    overflow-y: auto;
  }

  .invite-label {
    font-size: 12px;
    font-weight: 600;
    color: var(--text-secondary);
    margin-top: 4px;
  }

  .invite-note-hint {
    color: var(--text-faint);
    font-weight: 400;
    font-size: 11px;
  }

  .invite-search-wrap {
    position: relative;
    display: flex;
    align-items: center;
  }

  :global(.invite-search-wrap .invite-search-icon) {
    position: absolute;
    left: 10px;
    pointer-events: none;
    color: var(--text-faint);
  }

  .invite-search-input {
    width: 100%;
    box-sizing: border-box;
    padding: 8px 12px 8px 30px;
    border-radius: var(--radius-sm);
    border: 1px solid var(--border);
    background: var(--bg-deepest);
    color: var(--text-primary);
    font-size: 13px;
    font-family: inherit;
    outline: none;
    transition: var(--transition-fast);
  }

  .invite-search-input:focus {
    border-color: var(--ember-700);
    box-shadow: 0 0 0 3px var(--border-glow), 0 0 12px rgba(245, 158, 11, 0.04);
  }

  .invite-picker {
    max-height: 220px;
    min-height: 80px;
    overflow-y: auto;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    padding: 4px;
    background: var(--bg-surface);
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .invite-empty {
    padding: 20px 8px;
    text-align: center;
    color: var(--text-faint);
    font-size: 12px;
  }

  .invite-row {
    display: flex;
    align-items: center;
    gap: 10px;
    width: 100%;
    padding: 7px 9px;
    border-radius: 6px;
    border: 1px solid transparent;
    background: none;
    cursor: pointer;
    font-family: inherit;
    color: var(--text-secondary);
    font-size: 13px;
    text-align: left;
    transition: background 80ms ease, color 80ms ease, border-color 80ms ease;
  }
  .invite-row:hover,
  .invite-row:focus-visible {
    background: var(--bg-elevated);
    color: var(--text-primary);
    outline: none;
  }
  .invite-row.selected {
    background: rgba(245, 158, 11, 0.08);
    border-color: rgba(245, 158, 11, 0.25);
    color: var(--text-primary);
  }

  .invite-row-avatar {
    width: 26px;
    height: 26px;
    border-radius: 7px;
    background: linear-gradient(135deg, var(--ember-700), var(--ember-500));
    display: inline-flex;
    align-items: center;
    justify-content: center;
    font-size: 11px;
    font-weight: 700;
    color: #0a0a0c;
    flex-shrink: 0;
  }

  .invite-row-name { flex: 1; }

  .invite-row-tag {
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.4px;
    color: var(--ember-400);
    background: rgba(245, 158, 11, 0.08);
    border: 1px solid rgba(245, 158, 11, 0.18);
    border-radius: 4px;
    padding: 1px 5px;
  }

  .invite-note {
    width: 100%;
    box-sizing: border-box;
    padding: 8px 10px;
    border-radius: var(--radius-sm);
    border: 1px solid var(--border);
    background: var(--bg-deepest);
    color: var(--text-primary);
    font-size: 13px;
    font-family: inherit;
    resize: vertical;
    min-height: 50px;
    outline: none;
    transition: var(--transition-fast);
  }
  .invite-note:focus {
    border-color: var(--ember-700);
    box-shadow: 0 0 0 3px var(--border-glow);
  }
  .invite-note.over {
    border-color: rgba(239, 68, 68, 0.55);
  }

  .invite-note-counter {
    align-self: flex-end;
    font-size: 11px;
    color: var(--text-faint);
  }
  .invite-note-counter.over { color: #f87171; }

  .invite-footer {
    padding: 14px 22px 18px;
    border-top: 1px solid var(--border);
    display: flex;
    justify-content: flex-end;
    gap: 8px;
  }

  .invite-btn {
    padding: 8px 18px;
    border-radius: var(--radius-sm);
    font-size: 13px;
    font-weight: 600;
    cursor: pointer;
    border: none;
    font-family: inherit;
    display: inline-flex;
    align-items: center;
    gap: 6px;
    transition: var(--transition-fast);
  }

  .invite-btn.secondary {
    background: var(--bg-surface);
    color: var(--text-secondary);
    border: 1px solid var(--border);
  }
  .invite-btn.secondary:hover {
    background: var(--bg-elevated);
    color: var(--text-primary);
  }

  .invite-btn.primary {
    background: linear-gradient(135deg, var(--ember-600, #d97706), var(--ember-400, #f59e0b));
    color: #0a0a0c;
    box-shadow: 0 2px 8px rgba(245, 158, 11, 0.3);
  }
  .invite-btn.primary:hover:not(:disabled) {
    filter: brightness(1.08);
    box-shadow: 0 2px 12px rgba(245, 158, 11, 0.4);
  }

  .invite-btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
    box-shadow: none;
    filter: grayscale(0.4);
  }

  @keyframes overlayIn {
    from { opacity: 0; }
    to { opacity: 1; }
  }

  @keyframes modalIn {
    from { opacity: 0; transform: translateY(8px) scale(0.97); }
    to   { opacity: 1; transform: translateY(0) scale(1); }
  }
</style>
