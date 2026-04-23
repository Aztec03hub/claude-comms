<!--
  @component ArtifactPanel
  @description Slide-out panel that displays artifacts for the current conversation. Orchestrates the list + detail views via subcomponents.
  Owns the shared fetch state (artifacts, artifactCount, loading, error, selectedArtifact, selectedVersion, detailLoading, detailError) and passes it down via props.
  @prop {object} store - The ChatStore instance (uses store.activeChannel for fetching).
  @prop {Function} onClose - Callback invoked to close the artifact panel.
-->
<script>
  import { X, Clock } from 'lucide-svelte';
  import { untrack } from 'svelte';
  import { API_BASE, apiGet, apiPost } from '../lib/api.js';
  import ArtifactList from './ArtifactList.svelte';
  import ArtifactDetailHeader from './ArtifactDetailHeader.svelte';
  import ArtifactDetailBody from './ArtifactDetailBody.svelte';
  import RemoteUpdateBanner from './RemoteUpdateBanner.svelte';
  import ArtifactEditor from './ArtifactEditor.svelte';

  let { store, onClose } = $props();

  // Shared fetch state (list view)
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

  // Batch 3J additions: view-mode + compare-version + capabilities + copy toast.
  /** @type {'content'|'diff'} */
  let viewMode = $state('content');
  /** @type {number|null} */
  let compareVersion = $state(null);
  /** @type {{ writable: boolean } | null} */
  let capabilities = $state(null);
  /** @type {string|null} */
  let toastMessage = $state(null);
  /** @type {ReturnType<typeof setTimeout> | null} */
  let toastTimer = null;

  // Batch 3K: edit-in-place + remote-update banner state (plan §§1, 4).
  let isEditing = $state(false);
  /** Dirty flag fed by `ArtifactEditor` via its `onDirtyChange` callback. */
  let dirtyEdit = $state(false);

  // Remote-update banner state. All three reset together when the banner
  // is hidden; `bannerSender` / `bannerVersion` drive the banner copy.
  let remoteBannerVisible = $state(false);
  let remoteBannerSender = $state('');
  let remoteBannerVersion = $state(0);

  // Captured textarea state taken right before programmatic focus moves
  // into the banner. Restored on the preserving exit paths (Keep editing /
  // X / Esc / auto-dismiss) per plan §1 R5-4.
  /** @type {{ selectionStart: number, selectionEnd: number, scrollTop: number } | null} */
  let preBannerState = $state(null);

  /** @type {HTMLTextAreaElement | null} */
  let editorTextareaEl = null;

  /** Last epoch of `store.latestArtifactRefNotification` we reacted to. */
  let lastNotificationEpoch = 0;

  function showToast(msg) {
    toastMessage = msg;
    if (toastTimer != null) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      toastMessage = null;
      toastTimer = null;
    }, 2000);
  }

  // Fetch capabilities once on mount. `apiGet('/api/capabilities')` is
  // token-free per lib/api.js. On failure we leave `capabilities = null`,
  // which causes the Edit button to stay hidden — the safe default.
  $effect(() => {
    (async () => {
      try {
        const caps = await apiGet('/api/capabilities');
        capabilities = caps ?? null;
      } catch (e) {
        // Daemon may not yet expose /api/capabilities — degrade silently.
        capabilities = null;
      }
    })();
  });

  // Clean up the toast timer on unmount.
  $effect(() => {
    return () => {
      if (toastTimer != null) {
        clearTimeout(toastTimer);
        toastTimer = null;
      }
    };
  });

  async function fetchArtifacts(channel) {
    // Reset detail view whenever a fresh list fetch starts (channel change or manual refresh)
    selectedArtifact = null;
    selectedVersion = null;
    if (!channel) return;
    loading = true;
    error = null;
    try {
      const res = await fetch(`${API_BASE}/api/artifacts/${channel}`);
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
        ? `${API_BASE}/api/artifacts/${channel}/${name}?version=${version}`
        : `${API_BASE}/api/artifacts/${channel}/${name}`;
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      // Tag the detail with its channel so the body component can issue
      // per-version chunked reads without re-reading store.activeChannel
      // (which may tick during an async switch).
      if (!data.channel) data.channel = channel;
      selectedArtifact = data;
      selectedVersion = data.version;
      // Initialise the compare slot to v(N-1) when multiple versions exist;
      // otherwise leave null so the Diff toggle is disabled.
      const versions = data.versions ?? [];
      if (versions.length > 1 && data.version != null) {
        compareVersion = data.version - 1;
      } else {
        compareVersion = null;
      }
    } catch (e) {
      detailError = e.message;
    } finally {
      detailLoading = false;
    }
  }

  function handleSelectArtifact(artifact) {
    // Entering detail always starts in 'content' mode (plan §2 default).
    viewMode = 'content';
    fetchArtifactDetail(artifact.name);
  }

  function handleBack() {
    // Guard against losing unsaved edits when navigating away (plan §4
    // "Dirty-state protection").
    if (isEditing && dirtyEdit) {
      const ok = typeof window !== 'undefined'
        ? window.confirm('Discard unsaved changes?')
        : true;
      if (!ok) return;
    }
    isEditing = false;
    dirtyEdit = false;
    dismissBanner();
    selectedArtifact = null;
    selectedVersion = null;
    detailError = null;
    showVersionDropdown = false;
    viewMode = 'content';
    compareVersion = null;
  }

  function handleVersionSelect(v) {
    showVersionDropdown = false;
    if (selectedArtifact && v !== selectedVersion) {
      fetchArtifactDetail(selectedArtifact.name, v);
    }
  }

  function toggleVersionDropdown() {
    showVersionDropdown = !showVersionDropdown;
  }

  /**
   * Handle the `[Content | Diff]` segmented toggle. Accepts 'content' or
   * 'diff'; guards against meaningless diff requests (only one version).
   */
  function handleSetViewMode(mode) {
    if (mode !== 'content' && mode !== 'diff') return;
    const versions = selectedArtifact?.versions ?? [];
    if (mode === 'diff' && versions.length < 2) return;
    viewMode = mode;
  }

  /** Handle the "Compare:" dropdown selection. */
  function handleSetCompareVersion(v) {
    compareVersion = v;
  }

  /**
   * Copy the currently-selected version's content to the clipboard and
   * surface a transient "Copied!" toast.
   */
  async function handleCopy() {
    const text = selectedArtifact?.content ?? '';
    try {
      if (typeof navigator !== 'undefined' && navigator.clipboard) {
        await navigator.clipboard.writeText(text);
      }
      showToast('Copied!');
    } catch (e) {
      showToast('Copy failed');
    }
  }

  /** File-extension mapping for the Download button (§7). */
  function extForType(type) {
    if (type === 'plan' || type === 'doc') return 'md';
    return 'txt';
  }

  /**
   * Trigger a browser download of the currently-selected version's content
   * as `${name}-v${version}.${ext}`. Uses a transient Blob + anchor element
   * that we append, click, and remove synchronously.
   */
  function handleDownload() {
    if (!selectedArtifact) return;
    const text = selectedArtifact.content ?? '';
    const ext = extForType(selectedArtifact.type);
    const name = selectedArtifact.name ?? 'artifact';
    const version = selectedArtifact.version ?? 1;
    const filename = `${name}-v${version}.${ext}`;
    const mime = ext === 'md' ? 'text/markdown' : 'text/plain';
    const blob = new Blob([text], { type: `${mime};charset=utf-8` });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    // Revoke the object URL after a tick so the browser has time to consume it.
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }

  // Fetch on mount and when activeChannel changes. The fetch function itself
  // owns any state it mutates; this effect only reads `store.activeChannel`
  // to register the dependency and delegates the work.
  $effect(() => {
    fetchArtifacts(store.activeChannel);
  });

  // Real-time refresh (plan §1): when the store's artifactsDirty counter
  // ticks (driven by incoming chat messages with artifact_ref), debounce
  // by 150ms to coalesce bursts, then re-fetch the list. Reads the counter
  // unconditionally so Svelte tracks the dependency.
  let refreshDebounceTimer = null;
  $effect(() => {
    const tick = store.artifactsDirty;
    // Skip initial run (tick === 0) — the activeChannel effect handles first fetch.
    if (tick === 0) return;
    if (refreshDebounceTimer) clearTimeout(refreshDebounceTimer);
    refreshDebounceTimer = setTimeout(() => {
      refreshDebounceTimer = null;
      fetchArtifacts(store.activeChannel);
      // Non-editing path: also refresh the detail if we're viewing the
      // artifact that just changed. During edit, we route through the
      // banner instead (see the notification effect below).
      if (!isEditing && selectedArtifact) {
        const n = store.latestArtifactRefNotification;
        if (n && n.name === selectedArtifact.name) {
          fetchArtifactDetail(selectedArtifact.name);
        }
      }
    }, 150);
    return () => {
      if (refreshDebounceTimer) {
        clearTimeout(refreshDebounceTimer);
        refreshDebounceTimer = null;
      }
    };
  });

  // Remote-update banner trigger (plan §1): when the store reports a new
  // artifact_ref notification, AND we're mid-edit on that same artifact,
  // AND the incoming version is not one we just POSTed ourselves, show
  // the banner. Self-updates (isOurRecentUpdate) skip the banner path —
  // the counter tick above still drives list refresh.
  $effect(() => {
    const notice = store.latestArtifactRefNotification;
    if (!notice || notice.epoch === lastNotificationEpoch) return;
    untrack(() => {
      lastNotificationEpoch = notice.epoch;
      if (!isEditing || !selectedArtifact) return;
      if (notice.name !== selectedArtifact.name) return;
      // If this notification is the MQTT echo of our own save, drop it.
      if (
        notice.version != null
        && store.isOurRecentUpdate(notice.name, notice.version)
      ) {
        return;
      }
      // Capture textarea state BEFORE the banner takes focus.
      capturePreBannerState();
      remoteBannerSender = notice.senderName || 'Someone';
      remoteBannerVersion = notice.version ?? 0;
      remoteBannerVisible = true;
      // Programmatic focus into the banner (queueMicrotask so the DOM
      // node exists). Axe / SR users need the "assertive" aria-live + a
      // tabbable landing spot; the banner's outer <section> has tabindex=-1.
      queueMicrotask(() => {
        const el = document.querySelector(
          '[data-testid="remote-update-banner"]',
        );
        if (el instanceof HTMLElement) el.focus();
      });
    });
  });

  // ── Edit flow wiring (plan §4) ────────────────────────────────────────

  /**
   * Open the in-place editor. The header's Edit button only fires this when
   * the current view is the latest version AND capabilities.writable — both
   * conditions are checked there (header) AND defensively here so a future
   * caller can't bypass them.
   */
  function handleEnterEdit() {
    if (!selectedArtifact) return;
    if (!capabilities?.writable) return;
    if (selectedVersion !== selectedArtifact.version) return; // latest only
    isEditing = true;
    dirtyEdit = false;
    // Switching to edit mode forces content view (diff editing isn't a thing).
    viewMode = 'content';
  }

  /**
   * Close the editor without saving. Respects the dirty-state confirm: if
   * the user has unsaved changes, ask before discarding.
   */
  function handleEditorCancel() {
    if (dirtyEdit) {
      const ok = typeof window !== 'undefined'
        ? window.confirm('Discard unsaved changes?')
        : true;
      if (!ok) return;
    }
    exitEditMode();
  }

  /** Exit edit mode and clear draft/dirty/banner state (no confirm). */
  function exitEditMode() {
    isEditing = false;
    dirtyEdit = false;
    dismissBanner();
  }

  /**
   * POST the edit and handle the four documented outcomes (plan §4):
   *   - 2xx → markSelfUpdate + exit edit + refresh + toast
   *   - 409 → show banner (conflict path)
   *   - 401 → apiPost already retried once; message is "Session expired"
   *   - 403/404 → writable disabled in deployment; exit edit mode + toast
   */
  async function handleEditorSave(newContent) {
    if (!selectedArtifact) return;
    const channel = store.activeChannel;
    const name = selectedArtifact.name;
    const baseVersion = selectedArtifact.version ?? null;
    try {
      const resp = await apiPost(
        `/api/artifacts/${encodeURIComponent(channel)}/${encodeURIComponent(name)}`,
        {
          key: store.userProfile?.key ?? '',
          content: newContent,
          base_version: baseVersion,
        },
      );
      const newVersion = resp?.version ?? (baseVersion != null ? baseVersion + 1 : null);
      if (newVersion != null) {
        store.markSelfUpdate(name, newVersion);
      }
      exitEditMode();
      // Re-fetch detail so the panel reflects the new version / author /
      // timestamp. The list refresh arrives via the MQTT echo → counter.
      await fetchArtifactDetail(name);
      showToast(newVersion != null ? `Saved as v${newVersion}` : 'Saved');
    } catch (e) {
      const status = /** @type {any} */ (e)?.status;
      if (status === 409) {
        // Conflict — the server already advanced past our base_version.
        // Surface as the remote-update banner (it has the same 3-action UX).
        capturePreBannerState();
        const body = /** @type {any} */ (e)?.body ?? {};
        remoteBannerSender = body.latest_author ?? 'Someone';
        remoteBannerVersion = body.latest_version ?? 0;
        remoteBannerVisible = true;
        queueMicrotask(() => {
          const el = document.querySelector(
            '[data-testid="remote-update-banner"]',
          );
          if (el instanceof HTMLElement) el.focus();
        });
        return;
      }
      if (status === 403 || status === 404) {
        exitEditMode();
        showToast('Remote edits are disabled in this deployment.');
        return;
      }
      if (status === 401) {
        exitEditMode();
        showToast('Session expired — reload the page.');
        return;
      }
      showToast(`Save failed: ${e.message ?? 'unknown error'}`);
    }
  }

  /** Track the draft's dirty state so the confirm dialog knows. */
  function handleEditorDirtyChange(d) {
    dirtyEdit = Boolean(d);
  }

  /** Capture the textarea element from the editor for focus management. */
  function handleEditorTextareaMount(node) {
    editorTextareaEl = node;
  }

  /**
   * Capture textarea selection + scroll so we can restore them after the
   * banner is dismissed via a preserving path. Captures at most once per
   * banner lifecycle; never overwrites an existing snapshot.
   */
  function capturePreBannerState() {
    if (!editorTextareaEl || preBannerState) return;
    preBannerState = {
      selectionStart: editorTextareaEl.selectionStart,
      selectionEnd: editorTextareaEl.selectionEnd,
      scrollTop: editorTextareaEl.scrollTop,
    };
  }

  /**
   * Restore textarea selection + scroll from `preBannerState` and focus it.
   * No-ops if either the state or the textarea is unavailable.
   */
  function restorePreBannerState() {
    const state = preBannerState;
    const el = editorTextareaEl;
    preBannerState = null;
    if (!el || !state) {
      if (el) el.focus();
      return;
    }
    el.focus();
    try {
      el.setSelectionRange(state.selectionStart, state.selectionEnd);
    } catch {
      // Some browsers throw if the textarea isn't editable; ignore.
    }
    el.scrollTop = state.scrollTop;
  }

  function dismissBanner() {
    remoteBannerVisible = false;
    remoteBannerSender = '';
    remoteBannerVersion = 0;
    preBannerState = null;
  }

  // Banner action callbacks — preserving paths restore preBannerState,
  // exit paths drop it (plan §1 R5-4).
  function handleBannerViewChanges() {
    const name = selectedArtifact?.name;
    const proceed = dirtyEdit
      ? (typeof window !== 'undefined'
          ? window.confirm('Discard unsaved changes?')
          : true)
      : true;
    if (!proceed) return;
    // Explicit exit — do NOT restore preBannerState.
    exitEditMode();
    if (name) fetchArtifactDetail(name);
  }

  function handleBannerKeepEditing() {
    remoteBannerVisible = false;
    remoteBannerSender = '';
    remoteBannerVersion = 0;
    restorePreBannerState();
  }

  function handleBannerDiscardEdit() {
    const name = selectedArtifact?.name;
    // Explicit discard — do NOT restore preBannerState.
    exitEditMode();
    if (name) fetchArtifactDetail(name);
  }

  function handleBannerDismiss() {
    // X / 30s auto-dismiss / Esc path — preserving.
    remoteBannerVisible = false;
    remoteBannerSender = '';
    remoteBannerVersion = 0;
    restorePreBannerState();
  }
</script>

<div class="artifact-panel" data-testid="artifact-panel" role="complementary" aria-label="Artifacts">
  {#if selectedArtifact && !detailLoading}
    <!-- Detail View -->
    <ArtifactDetailHeader
      artifact={selectedArtifact}
      {selectedVersion}
      {showVersionDropdown}
      {viewMode}
      {compareVersion}
      {capabilities}
      onBack={handleBack}
      onVersionSelect={handleVersionSelect}
      onToggleVersionDropdown={toggleVersionDropdown}
      onSetViewMode={handleSetViewMode}
      onSetCompareVersion={handleSetCompareVersion}
      onCopy={handleCopy}
      onDownload={handleDownload}
      onEdit={selectedVersion === selectedArtifact.version ? handleEnterEdit : undefined}
      {onClose}
    />
    <RemoteUpdateBanner
      visible={remoteBannerVisible}
      senderName={remoteBannerSender}
      newVersion={remoteBannerVersion}
      onViewChanges={handleBannerViewChanges}
      onKeepEditing={handleBannerKeepEditing}
      onDiscardEdit={handleBannerDiscardEdit}
      onDismiss={handleBannerDismiss}
    />
    {#if isEditing}
      <ArtifactEditor
        visible={true}
        artifact={selectedArtifact}
        onSave={handleEditorSave}
        onCancel={handleEditorCancel}
        onDirtyChange={handleEditorDirtyChange}
        onTextareaMount={handleEditorTextareaMount}
      />
    {:else}
      <ArtifactDetailBody
        artifact={selectedArtifact}
        {detailError}
        {viewMode}
        {compareVersion}
      />
    {/if}
    {#if toastMessage}
      <div class="artifact-toast" role="status" aria-live="polite" data-testid="artifact-toast">
        {toastMessage}
      </div>
    {/if}
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
    {#if detailLoading}
      <div class="artifact-list">
        <div class="artifact-empty">
          <div class="artifact-empty-icon muted">
            <Clock size={24} strokeWidth={1.5} />
          </div>
          <div class="artifact-empty-title">Loading...</div>
        </div>
      </div>
    {:else}
      <ArtifactList
        {artifacts}
        {artifactCount}
        {loading}
        {error}
        onSelectArtifact={handleSelectArtifact}
        currentIdentityKey={store.userProfile.key}
        conversation={store.activeChannel}
      />
    {/if}
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

  /* ── List header (owned by orchestrator) ── */
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

  .artifact-close-btn {
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
    margin-left: auto;
  }

  .artifact-close-btn:hover {
    background: var(--bg-surface);
    color: var(--text-primary);
  }

  /* ── Detail loading state (shown while fetchArtifactDetail is in-flight before selectedArtifact is set) ── */
  .artifact-list {
    flex: 1;
    overflow-y: auto;
    padding: 8px;
  }

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

  @keyframes emptyFadeIn {
    from { opacity: 0; transform: translateY(8px); }
    to { opacity: 1; transform: translateY(0); }
  }

  /* ── Transient copy-success toast (Batch 3J §7) ── */
  .artifact-toast {
    position: absolute;
    bottom: 16px;
    right: 16px;
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    color: var(--text-primary);
    padding: 8px 14px;
    border-radius: var(--radius-sm);
    font-size: 12px;
    font-weight: 600;
    box-shadow: 0 4px 16px rgba(0, 0, 0, 0.3);
    animation: toastIn 0.18s cubic-bezier(0.16, 1, 0.3, 1) both;
    z-index: 20;
  }

  @keyframes toastIn {
    from { opacity: 0; transform: translateY(6px); }
    to { opacity: 1; transform: translateY(0); }
  }
</style>
