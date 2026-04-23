<!--
  @component ArtifactList
  @description List view of artifacts for the current conversation. Shows a STARRED section at the top when any artifact is starred, followed by the rest. Star state is per-identity + per-conversation, persisted to localStorage. Pure presentational aside from star-state bookkeeping — fetch state is owned by the parent panel.
  @prop {Array} artifacts - Array of artifact summary objects (name, type, title, version_count, latest_author, latest_timestamp).
  @prop {number} artifactCount - Total artifact count (may differ from artifacts.length if server paginates).
  @prop {boolean} loading - True while the list is being fetched.
  @prop {string|null} error - Error message if the fetch failed.
  @prop {Function} onSelectArtifact - Callback invoked with the full artifact object when a row is clicked.
  @prop {string} currentIdentityKey - Current user's identity key; scopes localStorage per user.
-->
<script>
  import { FileText, Code, ClipboardList, Clock, Star } from 'lucide-svelte';
  import { formatTime } from '../lib/utils.js';
  import { toggleStar, reconcile } from '../lib/starredArtifacts.js';

  let {
    artifacts,
    artifactCount,
    loading,
    error,
    onSelectArtifact,
    currentIdentityKey = '',
    conversation = ''
  } = $props();

  const TYPE_CONFIG = {
    plan: { icon: ClipboardList, label: 'Plan', cssClass: 'type-plan' },
    doc:  { icon: FileText,      label: 'Doc',  cssClass: 'type-doc' },
    code: { icon: Code,          label: 'Code', cssClass: 'type-code' },
  };

  function getTypeConfig(type) {
    return TYPE_CONFIG[type] || TYPE_CONFIG.doc;
  }

  // Starred names for the current (identity, conversation) pair. Reconciled
  // against the current artifacts array whenever either input changes so
  // stale entries (artifacts deleted remotely) silently drop out of storage
  // and out of the UI.
  let starred = $state([]);

  $effect(() => {
    // Touch reactive inputs so the effect re-runs when they change.
    const names = artifacts?.map(a => a.name) || [];
    if (!currentIdentityKey || !conversation) {
      starred = [];
      return;
    }
    starred = reconcile(currentIdentityKey, conversation, names);
  });

  function isStarred(name) {
    return starred.includes(name);
  }

  function handleStarClick(event, name) {
    event.stopPropagation();
    const nowStarred = toggleStar(currentIdentityKey, conversation, name);
    // Update local state to drive the re-render. Build a fresh array so
    // Svelte's proxy picks up the change.
    if (nowStarred) {
      starred = [...starred, name];
    } else {
      starred = starred.filter(n => n !== name);
    }
  }

  // Keyboard activation for the row (role=button). Enter or Space selects
  // the artifact. Space also scrolls by default so we preventDefault.
  function handleRowKeydown(event, artifact) {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      onSelectArtifact(artifact);
    }
  }

  // Partition artifacts into starred / unstarred, preserving list order.
  const starredArtifacts = $derived(
    (artifacts || []).filter(a => starred.includes(a.name))
  );
  const unstarredArtifacts = $derived(
    (artifacts || []).filter(a => !starred.includes(a.name))
  );
</script>

<div class="artifact-list">
  {#if loading}
    <div class="artifact-empty">
      <div class="artifact-empty-icon muted">
        <Clock size={24} strokeWidth={1.5} />
      </div>
      <div class="artifact-empty-title">Loading...</div>
    </div>
  {:else if error}
    <div class="artifact-empty">
      <div class="artifact-empty-icon">
        <FileText size={24} strokeWidth={1.5} />
      </div>
      <div class="artifact-empty-title">Error loading artifacts</div>
      <div class="artifact-empty-hint">{error}</div>
    </div>
  {:else if artifacts.length === 0}
    <!-- Polished empty state (plan §6) -->
    <div class="artifact-empty-polished" data-testid="artifact-empty">
      <div class="artifact-empty-icon-large">
        <FileText size={48} strokeWidth={1.5} />
      </div>
      <div class="artifact-empty-heading">No artifacts yet</div>
      <div class="artifact-empty-body">
        Artifacts are shared, versioned documents for plans, specs, and code. Any agent or collaborator with an MCP tool can create one. Once created, you can edit and compare versions here.
      </div>
      <a
        class="artifact-empty-link"
        href="https://github.com/Aztec03hub/claude-comms/blob/main/USAGE.md#artifacts"
        target="_blank"
        rel="noopener"
      >Read the artifact guide →</a>
    </div>
  {:else}
    {#if starredArtifacts.length > 0}
      <div class="section-label" data-testid="artifact-starred-section">STARRED</div>
      {#each starredArtifacts as artifact (artifact.name)}
        {@const tc = getTypeConfig(artifact.type)}
        {@const Icon = tc.icon}
        {@const rowStarred = isStarred(artifact.name)}
        <!--
          Row a11y (R2-5, Batch 4L): the "select row" action is a real <button>
          stretched to fill the row via an absolutely-positioned ::before
          hit-target. The star <button> is a SIBLING of the select-button, not
          a descendant — axe's `nested-interactive` rule rejects focusable
          descendants of role=button. The text content remains presentational.
        -->
        <div class="artifact-item" data-testid="artifact-item-{artifact.name}">
          <button
            type="button"
            class="artifact-item-select"
            aria-label="Open artifact {artifact.title || artifact.name}"
            data-testid="artifact-item-select-{artifact.name}"
            onclick={() => onSelectArtifact(artifact)}
            onkeydown={(e) => handleRowKeydown(e, artifact)}
          ></button>
          <div class="artifact-item-top">
            <Icon size={14} strokeWidth={2} />
            <span class="artifact-item-title">{artifact.title || artifact.name}</span>
            <span class="artifact-type-badge {tc.cssClass}">{tc.label}</span>
            <button
              class="artifact-star-btn"
              class:starred={rowStarred}
              type="button"
              aria-pressed={rowStarred}
              aria-label={rowStarred ? `Unstar artifact ${artifact.name}` : `Star artifact ${artifact.name}`}
              data-testid="artifact-star-{artifact.name}"
              onclick={(e) => handleStarClick(e, artifact.name)}
            >
              <Star size={16} strokeWidth={2} fill={rowStarred ? 'currentColor' : 'none'} />
            </button>
          </div>
          <div class="artifact-item-bottom">
            {#if artifact.version_count != null}
              <span class="artifact-item-meta">{artifact.version_count} version{artifact.version_count !== 1 ? 's' : ''}</span>
            {/if}
            {#if artifact.latest_author}
              <span class="artifact-item-meta">{artifact.latest_author}</span>
            {/if}
            {#if artifact.latest_timestamp}
              <span class="artifact-item-meta">{formatTime(artifact.latest_timestamp, 'relative')}</span>
            {/if}
          </div>
        </div>
      {/each}
      <div class="section-divider"></div>
    {/if}

    {#each unstarredArtifacts as artifact (artifact.name)}
      {@const tc = getTypeConfig(artifact.type)}
      {@const Icon = tc.icon}
      {@const rowStarred = isStarred(artifact.name)}
      <div class="artifact-item" data-testid="artifact-item-{artifact.name}">
        <button
          type="button"
          class="artifact-item-select"
          aria-label="Open artifact {artifact.title || artifact.name}"
          data-testid="artifact-item-select-{artifact.name}"
          onclick={() => onSelectArtifact(artifact)}
          onkeydown={(e) => handleRowKeydown(e, artifact)}
        ></button>
        <div class="artifact-item-top">
          <Icon size={14} strokeWidth={2} />
          <span class="artifact-item-title">{artifact.title || artifact.name}</span>
          <span class="artifact-type-badge {tc.cssClass}">{tc.label}</span>
          <button
            class="artifact-star-btn"
            class:starred={rowStarred}
            type="button"
            aria-pressed={rowStarred}
            aria-label={rowStarred ? `Unstar artifact ${artifact.name}` : `Star artifact ${artifact.name}`}
            data-testid="artifact-star-{artifact.name}"
            onclick={(e) => handleStarClick(e, artifact.name)}
          >
            <Star size={16} strokeWidth={2} fill={rowStarred ? 'currentColor' : 'none'} />
          </button>
        </div>
        <div class="artifact-item-bottom">
          {#if artifact.version_count != null}
            <span class="artifact-item-meta">{artifact.version_count} version{artifact.version_count !== 1 ? 's' : ''}</span>
          {/if}
          {#if artifact.latest_author}
            <span class="artifact-item-meta">{artifact.latest_author}</span>
          {/if}
          {#if artifact.latest_timestamp}
            <span class="artifact-item-meta">{formatTime(artifact.latest_timestamp, 'relative')}</span>
          {/if}
        </div>
      </div>
    {/each}
  {/if}
</div>

<style>
  /* ── Type Badges (shared with header, scoped here for list rows) ── */
  .artifact-type-badge {
    font-size: 9px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    padding: 2px 7px;
    border-radius: 6px;
    flex-shrink: 0;
  }

  .artifact-type-badge.type-plan {
    color: var(--ember-400);
    background: rgba(245, 158, 11, 0.1);
    border: 1px solid rgba(245, 158, 11, 0.15);
  }

  .artifact-type-badge.type-doc {
    color: #60a5fa;
    background: rgba(96, 165, 250, 0.1);
    border: 1px solid rgba(96, 165, 250, 0.15);
  }

  .artifact-type-badge.type-code {
    color: #34d399;
    background: rgba(52, 211, 153, 0.1);
    border: 1px solid rgba(52, 211, 153, 0.15);
  }

  /* ── List View ── */
  .artifact-list {
    flex: 1;
    overflow-y: auto;
    padding: 8px;
  }

  .artifact-item {
    position: relative;
    display: flex;
    flex-direction: column;
    gap: 6px;
    width: 100%;
    padding: 10px 12px;
    border-radius: var(--radius-sm);
    background: var(--bg-surface);
    border: 1px solid var(--border-subtle);
    margin-bottom: 6px;
    transition: var(--transition-fast);
    text-align: left;
    font-family: inherit;
    color: inherit;
  }

  .artifact-item:last-child { margin-bottom: 0; }

  .artifact-item:hover {
    border-color: var(--ember-700);
    background: var(--bg-elevated);
  }

  /* Star becomes fully visible on row hover */
  .artifact-item:hover .artifact-star-btn {
    opacity: 1;
  }

  /*
   * Stretched "select row" button (R2-5, Batch 4L). Covers the full row
   * as the click target + keyboard tab stop, while the star button sits
   * above it at a higher z-index so its click isn't eaten by this one.
   * Inherits the row's hover border via its background: transparent.
   */
  .artifact-item-select {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    padding: 0;
    margin: 0;
    background: transparent;
    border: none;
    border-radius: inherit;
    cursor: pointer;
    font-family: inherit;
    color: inherit;
    z-index: 0;
  }

  .artifact-item-select:focus-visible {
    outline: 2px solid var(--ember-500);
    outline-offset: -2px;
  }

  .artifact-item-top {
    position: relative;
    z-index: 1;
    display: flex;
    align-items: center;
    gap: 8px;
    /* The select button sits beneath this row; the star button within is a
       real interactive element at this z-index so it receives clicks first. */
    pointer-events: none;
  }

  .artifact-item-top > * {
    pointer-events: auto;
  }

  .artifact-item-top :global(svg) {
    color: var(--text-muted);
    flex-shrink: 0;
  }

  .artifact-item-title {
    font-size: 12.5px;
    font-weight: 600;
    color: var(--text-primary);
    flex: 1;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .artifact-item-bottom {
    position: relative;
    z-index: 1;
    display: flex;
    align-items: center;
    gap: 10px;
    padding-left: 22px;
    /* Let clicks pass through meta spans so the underlying select button
       still activates the row — the star button overrides this locally. */
    pointer-events: none;
  }

  .artifact-item-meta {
    font-size: 10px;
    color: var(--text-faint);
  }

  /* ── Star Button ── */
  .artifact-star-btn {
    width: 24px;
    height: 24px;
    border-radius: 6px;
    border: none;
    background: none;
    padding: 0;
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    color: var(--text-faint);
    opacity: 0.3;
    flex-shrink: 0;
    transition: opacity 120ms ease, color 120ms ease;
  }

  .artifact-star-btn:hover {
    opacity: 1;
  }

  .artifact-star-btn.starred {
    opacity: 1;
    color: var(--ember-400);
  }

  .artifact-star-btn:focus-visible {
    outline: 2px solid var(--ember-400);
    outline-offset: 1px;
    opacity: 1;
  }

  /* ── STARRED section header ── */
  .section-label {
    padding: 8px 4px 6px;
    font-size: 10px;
    font-weight: 700;
    letter-spacing: 1.4px;
    color: var(--text-faint);
    text-transform: uppercase;
  }

  .section-divider {
    height: 1px;
    background: var(--border);
    margin: 8px 0;
  }

  /* ── Loading / error states ── */
  .artifact-empty {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    padding: 48px 24px;
    gap: 8px;
    animation: emptyFadeIn 0.4s ease both;
  }

  .artifact-empty-icon {
    width: 48px;
    height: 48px;
    border-radius: 50%;
    background: rgba(245, 158, 11, 0.06);
    border: 1px solid rgba(245, 158, 11, 0.1);
    display: flex;
    align-items: center;
    justify-content: center;
    color: var(--ember-400);
    opacity: 0.7;
    margin-bottom: 4px;
  }

  .artifact-empty-icon.muted {
    background: var(--bg-surface);
    border-color: var(--border);
    color: var(--text-faint);
  }

  .artifact-empty-title {
    font-size: 14px;
    font-weight: 600;
    color: var(--text-secondary);
  }

  .artifact-empty-hint {
    font-size: 12px;
    color: var(--text-faint);
    text-align: center;
    line-height: 1.5;
  }

  /* ── Polished empty state (plan §6) ── */
  .artifact-empty-polished {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    min-height: 300px;
    padding: 32px 24px;
    text-align: center;
    animation: emptyFadeIn 0.4s ease both;
  }

  .artifact-empty-icon-large {
    color: var(--text-faint);
    opacity: 0.6;
    display: flex;
    align-items: center;
    justify-content: center;
  }

  .artifact-empty-heading {
    font-size: 16px;
    font-weight: 600;
    color: var(--text-primary);
    margin-top: 16px;
  }

  .artifact-empty-body {
    font-size: 13px;
    color: var(--text-muted);
    line-height: 1.6;
    max-width: 280px;
    margin-top: 8px;
  }

  .artifact-empty-link {
    font-size: 13px;
    color: var(--ember-400);
    text-decoration: none;
    margin-top: 16px;
  }

  .artifact-empty-link:hover {
    text-decoration: underline;
  }

  @keyframes emptyFadeIn {
    from { opacity: 0; transform: translateY(8px); }
    to { opacity: 1; transform: translateY(0); }
  }
</style>
