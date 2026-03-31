<!--
  @component ArtifactPanel
  @description Slide-out panel that displays artifacts for the current conversation. Shows a list view of all artifacts with type badges, version counts, and timestamps. Clicking an artifact opens a detail view with version selector and content display.
  @prop {object} store - The ChatStore instance (uses store.activeChannel for fetching).
  @prop {Function} onClose - Callback invoked to close the artifact panel.
-->
<script>
  import { FileText, Code, ClipboardList, X, ChevronLeft, ChevronDown, Clock, User } from 'lucide-svelte';
  import { formatTime } from '../lib/utils.js';

  let { store, onClose } = $props();

  let artifacts = $state([]);
  let artifactCount = $state(0);
  let loading = $state(false);
  let error = $state(null);

  // Detail view state
  let selectedArtifact = $state(null);
  let selectedVersion = $state(null);
  let detailLoading = $state(false);
  let detailError = $state(null);
  let showVersionDropdown = $state(false);

  const TYPE_CONFIG = {
    plan: { icon: ClipboardList, label: 'Plan', cssClass: 'type-plan' },
    doc:  { icon: FileText,      label: 'Doc',  cssClass: 'type-doc' },
    code: { icon: Code,          label: 'Code', cssClass: 'type-code' },
  };

  function getTypeConfig(type) {
    return TYPE_CONFIG[type] || TYPE_CONFIG.doc;
  }

  async function fetchArtifacts(channel) {
    if (!channel) return;
    loading = true;
    error = null;
    try {
      const res = await fetch(`/api/artifacts/${channel}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      artifacts = data.artifacts || [];
      artifactCount = data.count || artifacts.length;
    } catch (e) {
      error = e.message;
      artifacts = [];
      artifactCount = 0;
    } finally {
      loading = false;
    }
  }

  async function fetchArtifactDetail(name, version) {
    const channel = store.activeChannel;
    if (!channel || !name) return;
    detailLoading = true;
    detailError = null;
    try {
      const url = version != null
        ? `/api/artifacts/${channel}/${name}?version=${version}`
        : `/api/artifacts/${channel}/${name}`;
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      selectedArtifact = data;
      selectedVersion = data.version;
    } catch (e) {
      detailError = e.message;
    } finally {
      detailLoading = false;
    }
  }

  function handleSelectArtifact(artifact) {
    fetchArtifactDetail(artifact.name);
  }

  function handleBack() {
    selectedArtifact = null;
    selectedVersion = null;
    detailError = null;
    showVersionDropdown = false;
  }

  function handleVersionSelect(v) {
    showVersionDropdown = false;
    if (selectedArtifact && v !== selectedVersion) {
      fetchArtifactDetail(selectedArtifact.name, v);
    }
  }

  // Fetch on mount and when activeChannel changes
  $effect(() => {
    const channel = store.activeChannel;
    // Reset detail view on channel change
    selectedArtifact = null;
    selectedVersion = null;
    fetchArtifacts(channel);
  });
</script>

<div class="artifact-panel" data-testid="artifact-panel" role="complementary" aria-label="Artifacts">
  {#if selectedArtifact && !detailLoading}
    <!-- Detail View -->
    <div class="artifact-header">
      <div class="artifact-header-top">
        <button class="artifact-back-btn" onclick={handleBack} title="Back to list" aria-label="Back to artifact list">
          <ChevronLeft size={16} strokeWidth={2} />
        </button>
        <span class="artifact-header-title">{selectedArtifact.title || selectedArtifact.name}</span>
        <span class="artifact-type-badge {getTypeConfig(selectedArtifact.type).cssClass}">{getTypeConfig(selectedArtifact.type).label}</span>
        <button class="artifact-close-btn" onclick={onClose} data-testid="artifact-panel-close" title="Close" aria-label="Close artifacts panel">
          <X size={16} strokeWidth={2} />
        </button>
      </div>
      {#if selectedArtifact.versions && selectedArtifact.versions.length > 1}
        <div class="artifact-version-selector">
          <button class="artifact-version-btn" onclick={() => showVersionDropdown = !showVersionDropdown} aria-expanded={showVersionDropdown}>
            <span>v{selectedVersion}</span>
            <ChevronDown size={14} strokeWidth={2} />
          </button>
          {#if showVersionDropdown}
            <div class="artifact-version-dropdown">
              {#each selectedArtifact.versions as v}
                <button
                  class="artifact-version-option"
                  class:active={v.version === selectedVersion}
                  onclick={() => handleVersionSelect(v.version)}
                >
                  <span class="version-label">v{v.version}</span>
                  <span class="version-meta">
                    {#if v.author}{v.author}{/if}
                    {#if v.summary} — {v.summary}{/if}
                  </span>
                </button>
              {/each}
            </div>
          {/if}
        </div>
      {/if}
      <div class="artifact-detail-meta">
        <span class="artifact-meta-item"><User size={12} strokeWidth={2} /> {selectedArtifact.author || 'Unknown'}</span>
        <span class="artifact-meta-item"><Clock size={12} strokeWidth={2} /> {selectedArtifact.timestamp ? formatTime(selectedArtifact.timestamp, 'relative') : ''}</span>
        {#if selectedArtifact.summary}
          <span class="artifact-meta-summary">Updated by {selectedArtifact.author || 'Unknown'} — {selectedArtifact.summary}</span>
        {/if}
      </div>
    </div>
    <div class="artifact-content-area">
      {#if detailError}
        <div class="artifact-error">{detailError}</div>
      {:else}
        <pre class="artifact-content">{selectedArtifact.content || ''}</pre>
      {/if}
    </div>
  {:else}
    <!-- List View -->
    <div class="artifact-header">
      <div class="artifact-header-top">
        <span class="artifact-header-title">Artifacts</span>
        {#if artifactCount > 0}
          <span class="artifact-count-badge">{artifactCount}</span>
        {/if}
        <button class="artifact-close-btn" onclick={onClose} data-testid="artifact-panel-close" title="Close" aria-label="Close artifacts panel">
          <X size={16} strokeWidth={2} />
        </button>
      </div>
    </div>
    <div class="artifact-list">
      {#if loading || detailLoading}
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
        <div class="artifact-empty">
          <div class="artifact-empty-icon muted">
            <FileText size={24} strokeWidth={1.5} />
          </div>
          <div class="artifact-empty-title">No artifacts yet</div>
          <div class="artifact-empty-hint">Artifacts created in this conversation will appear here.</div>
        </div>
      {:else}
        {#each artifacts as artifact (artifact.name)}
          {@const tc = getTypeConfig(artifact.type)}
          <button class="artifact-item" onclick={() => handleSelectArtifact(artifact)} data-testid="artifact-item-{artifact.name}">
            <div class="artifact-item-top">
              <svelte:component this={tc.icon} size={14} strokeWidth={2} />
              <span class="artifact-item-title">{artifact.title || artifact.name}</span>
              <span class="artifact-type-badge {tc.cssClass}">{tc.label}</span>
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
          </button>
        {/each}
      {/if}
    </div>
  {/if}
</div>

<style>
  .artifact-panel {
    position: absolute;
    top: 0;
    right: 0;
    bottom: 0;
    width: 380px;
    z-index: 104;
    background: rgba(20, 20, 22, 0.96);
    backdrop-filter: blur(16px);
    border-left: 1px solid var(--border);
    box-shadow: -8px 0 32px rgba(0, 0, 0, 0.3);
    display: flex;
    flex-direction: column;
    animation: searchSlide 0.3s cubic-bezier(0.16, 1, 0.3, 1) both;
  }

  .artifact-header {
    padding: 16px;
    border-bottom: 1px solid var(--border);
    display: flex;
    flex-direction: column;
    gap: 10px;
  }

  .artifact-header-top {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .artifact-header-title {
    font-size: 14px;
    font-weight: 700;
    flex: 1;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .artifact-count-badge {
    font-size: 10px;
    font-weight: 600;
    color: var(--text-faint);
    background: var(--bg-surface);
    padding: 1px 7px;
    border-radius: 8px;
  }

  .artifact-close-btn,
  .artifact-back-btn {
    width: 24px;
    height: 24px;
    border-radius: 6px;
    border: none;
    background: none;
    color: var(--text-faint);
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    transition: var(--transition-fast);
    flex-shrink: 0;
  }

  .artifact-close-btn {
    margin-left: auto;
  }

  .artifact-close-btn:hover,
  .artifact-back-btn:hover {
    background: var(--bg-surface);
    color: var(--text-primary);
  }

  /* ── Type Badges ── */
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
    display: flex;
    flex-direction: column;
    gap: 6px;
    width: 100%;
    padding: 10px 12px;
    border-radius: var(--radius-sm);
    background: var(--bg-surface);
    border: 1px solid var(--border-subtle);
    margin-bottom: 6px;
    cursor: pointer;
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

  .artifact-item-top {
    display: flex;
    align-items: center;
    gap: 8px;
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
    display: flex;
    align-items: center;
    gap: 10px;
    padding-left: 22px;
  }

  .artifact-item-meta {
    font-size: 10px;
    color: var(--text-faint);
  }

  /* ── Empty State ── */
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

  .artifact-error {
    padding: 16px;
    font-size: 12px;
    color: #f87171;
  }

  @keyframes emptyFadeIn {
    from { opacity: 0; transform: translateY(8px); }
    to { opacity: 1; transform: translateY(0); }
  }

  /* ── Detail View ── */
  .artifact-detail-meta {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 12px;
  }

  .artifact-meta-item {
    display: flex;
    align-items: center;
    gap: 4px;
    font-size: 11px;
    color: var(--text-muted);
  }

  .artifact-meta-item :global(svg) {
    color: var(--text-faint);
  }

  .artifact-meta-summary {
    width: 100%;
    font-size: 11px;
    color: var(--text-faint);
    font-style: italic;
  }

  /* ── Version Selector ── */
  .artifact-version-selector {
    position: relative;
  }

  .artifact-version-btn {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 4px 10px;
    border-radius: var(--radius-xs);
    background: var(--bg-surface);
    border: 1px solid var(--border);
    font-size: 11px;
    font-weight: 600;
    color: var(--text-secondary);
    cursor: pointer;
    transition: var(--transition-fast);
    font-family: inherit;
  }

  .artifact-version-btn:hover {
    border-color: var(--ember-700);
    color: var(--text-primary);
  }

  .artifact-version-dropdown {
    position: absolute;
    top: 100%;
    left: 0;
    margin-top: 4px;
    width: 280px;
    max-height: 200px;
    overflow-y: auto;
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.4);
    z-index: 10;
    animation: panelIn 0.15s cubic-bezier(0.16, 1, 0.3, 1) both;
  }

  .artifact-version-option {
    display: flex;
    align-items: baseline;
    gap: 8px;
    width: 100%;
    padding: 8px 12px;
    background: none;
    border: none;
    font-size: 11px;
    color: var(--text-secondary);
    cursor: pointer;
    transition: var(--transition-fast);
    text-align: left;
    font-family: inherit;
  }

  .artifact-version-option:hover {
    background: var(--bg-surface);
  }

  .artifact-version-option.active {
    color: var(--ember-400);
  }

  .version-label {
    font-weight: 600;
    flex-shrink: 0;
  }

  .version-meta {
    color: var(--text-faint);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  /* ── Content Area ── */
  .artifact-content-area {
    flex: 1;
    overflow-y: auto;
    padding: 16px;
  }

  .artifact-content {
    font-family: 'SF Mono', Consolas, 'JetBrains Mono', 'Courier New', monospace;
    font-size: 12px;
    line-height: 1.6;
    color: var(--text-secondary);
    white-space: pre-wrap;
    word-wrap: break-word;
    margin: 0;
    background: none;
  }
</style>
