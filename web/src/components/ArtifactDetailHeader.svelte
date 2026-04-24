<!--
  @component ArtifactDetailHeader
  @description Header for the artifact detail view: back button, title, type badge,
    version dropdowns (primary + optional compare), Content|Diff segmented toggle,
    Edit/Copy/Download icon buttons, and close button.

  Per plan §2 (Diff view), §3 (Per-version author display), §7 (Copy + download buttons).

  @prop {object} artifact               - The currently selected artifact detail object.
  @prop {number|string|null} selectedVersion - Currently selected ("to") version number.
  @prop {boolean} showVersionDropdown   - Whether the primary version dropdown is open.
  @prop {'content'|'diff'} viewMode     - Active view mode.
  @prop {number|null} compareVersion    - The "from" version for diff mode (null when only v1 exists).
  @prop {object|null} capabilities      - Deployment capabilities (`{ writable: bool }` or null).
  @prop {Function} onBack               - Callback when the back button is clicked.
  @prop {Function} onVersionSelect      - Callback with the version number when a primary dropdown option is clicked.
  @prop {Function} onToggleVersionDropdown - Callback when the primary version button is clicked.
  @prop {Function} onSetViewMode        - Callback invoked with 'content' | 'diff'.
  @prop {Function} onSetCompareVersion  - Callback invoked with a version number for the "from" side.
  @prop {Function} onCopy               - Callback invoked when the Copy button is clicked.
  @prop {Function} onDownload           - Callback invoked when the Download button is clicked.
  @prop {Function} [onEdit]             - Optional callback invoked when the Edit button is clicked.
  @prop {Function} onClose              - Callback when the close button is clicked.
-->
<script>
  import {
    FileText,
    Code,
    ClipboardList,
    X,
    ChevronLeft,
    ChevronDown,
    Clipboard,
    Download,
    Pencil,
    Check,
  } from 'lucide-svelte';
  import { formatTime, getParticipantColor } from '../lib/utils.js';

  let {
    artifact,
    selectedVersion,
    showVersionDropdown,
    viewMode = 'content',
    compareVersion = null,
    capabilities = null,
    onBack,
    onVersionSelect,
    onToggleVersionDropdown,
    onSetViewMode,
    onSetCompareVersion,
    onCopy,
    onDownload,
    onEdit,
    onClose,
  } = $props();

  // Stable id base for ARIA `aria-activedescendant` references. Using a
  // counter via `$props.id()` would be ideal, but a derived literal-based id
  // off the artifact name is sufficient — only one header is mounted at a
  // time and the artifact name is unique within a panel session.
  const listboxIdBase = `artifact-version-listbox-${Math.random().toString(36).slice(2, 8)}`;
  function optionId(kind, version) {
    return `${listboxIdBase}-${kind}-v${version}`;
  }

  const TYPE_CONFIG = {
    plan: { icon: ClipboardList, label: 'Plan', cssClass: 'type-plan' },
    doc:  { icon: FileText,      label: 'Doc',  cssClass: 'type-doc' },
    code: { icon: Code,          label: 'Code', cssClass: 'type-code' },
  };

  function getTypeConfig(type) {
    return TYPE_CONFIG[type] || TYPE_CONFIG.doc;
  }

  let typeConfig = $derived(getTypeConfig(artifact?.type));

  // Versions array (may be empty for a fresh artifact). Sorted newest-first
  // by the server; we render as-is.
  let versions = $derived(artifact?.versions ?? []);
  let hasMultipleVersions = $derived(versions.length > 1);

  // Compare-dropdown state. Local to this component — only opens/closes within
  // the header. Orchestrator owns the primary dropdown state because the
  // dropdown can close on outside-click at the panel level.
  let showCompareDropdown = $state(false);

  // Transient "Copied!" feedback on the Copy button.
  let copiedFlash = $state(false);
  /** @type {ReturnType<typeof setTimeout> | null} */
  let copiedTimer = null;

  function triggerCopy() {
    onCopy?.();
    copiedFlash = true;
    if (copiedTimer != null) clearTimeout(copiedTimer);
    copiedTimer = setTimeout(() => {
      copiedFlash = false;
      copiedTimer = null;
    }, 1200);
  }

  // Cleanup the copy-feedback timer if the component unmounts mid-flash.
  $effect(() => {
    return () => {
      if (copiedTimer != null) {
        clearTimeout(copiedTimer);
        copiedTimer = null;
      }
    };
  });

  // Edit button visibility — gated by capabilities (null means unknown → hide).
  let showEditBtn = $derived(
    capabilities != null && capabilities.writable === true && typeof onEdit === 'function',
  );

  // Find the currently-selected version entry (for dropdown trigger label).
  let activeVersionEntry = $derived(
    versions.find((v) => v.version === selectedVersion) ?? null,
  );

  /**
   * Render the relative-time fragment for a version row. Uses the existing
   * `formatTime` helper in 'relative' mode, which returns forms like "5m",
   * "2h", "3d", or a short "Apr 22" fallback once > 7 days old.
   */
  function relTime(ts) {
    if (!ts) return '';
    return formatTime(ts, 'relative');
  }

  /**
   * Handle a compare-dropdown selection. Closes the dropdown and forwards
   * the chosen version to the parent callback.
   */
  function selectCompareVersion(v) {
    showCompareDropdown = false;
    onSetCompareVersion?.(v);
  }

  function toggleCompareDropdown() {
    showCompareDropdown = !showCompareDropdown;
  }

  // Diff mode is disabled when there is only a single version to compare.
  let diffDisabled = $derived(!hasMultipleVersions);

  // ── Version dropdown keyboard nav (R2-5 a11y spec) ───────────────────────
  // The two dropdowns are independent listboxes; each tracks its own focused
  // option index for `aria-activedescendant`. The trigger buttons are
  // captured via `bind:this` so we can restore keyboard focus to them when
  // the listbox closes (per WAI-ARIA APG combobox-listbox pattern).

  /** @type {HTMLButtonElement | null} */
  let primaryTriggerEl = $state(null);
  /** @type {HTMLButtonElement | null} */
  let compareTriggerEl = $state(null);

  // Active descendants — index into the visible-options arrays below.
  /** Active descendant index in the primary listbox (-1 = none). */
  let primaryActiveIdx = $state(-1);
  /** Active descendant index in the compare listbox (-1 = none). */
  let compareActiveIdx = $state(-1);

  // Compare listbox excludes the currently-selected (to) version, since it
  // wouldn't make sense to diff a version against itself. Keep this derived
  // so the keyboard nav indices line up with what the template renders.
  let compareOptions = $derived(
    versions.filter((v) => v.version !== selectedVersion),
  );

  /** @type {HTMLDivElement | null} */
  let primaryListboxEl = $state(null);
  /** @type {HTMLDivElement | null} */
  let compareListboxEl = $state(null);

  /**
   * When the primary dropdown opens, seed the active index to the currently-
   * selected version (so a screen reader announces it immediately and arrow
   * keys feel anchored), then move keyboard focus into the listbox so the
   * arrow / Esc handlers actually fire. When it closes, focus returns to
   * the trigger.
   */
  $effect(() => {
    if (showVersionDropdown) {
      const idx = versions.findIndex((v) => v.version === selectedVersion);
      primaryActiveIdx = idx >= 0 ? idx : 0;
      // Defer focus into the listbox until after the {#if} branch mounts.
      queueMicrotask(() => {
        if (primaryListboxEl) primaryListboxEl.focus();
      });
    } else if (primaryActiveIdx !== -1) {
      // Closing path: reset index, return focus to trigger so keyboard
      // users land back where they were (R4-3 / a11y spec).
      primaryActiveIdx = -1;
      const btn = primaryTriggerEl;
      if (btn) queueMicrotask(() => btn.focus());
    }
  });

  $effect(() => {
    if (showCompareDropdown) {
      const idx = compareOptions.findIndex((v) => v.version === compareVersion);
      compareActiveIdx = idx >= 0 ? idx : 0;
      queueMicrotask(() => {
        if (compareListboxEl) compareListboxEl.focus();
      });
    } else if (compareActiveIdx !== -1) {
      compareActiveIdx = -1;
      const btn = compareTriggerEl;
      if (btn) queueMicrotask(() => btn.focus());
    }
  });

  /**
   * Shared keyboard handler for either listbox trigger — opens the listbox
   * on ArrowDown/ArrowUp/Enter/Space when closed; otherwise lets the keydown
   * fall through to the listbox handler.
   * @param {KeyboardEvent} e
   * @param {() => void} openFn
   * @param {boolean} isOpen
   */
  function handleTriggerKeydown(e, openFn, isOpen) {
    if (isOpen) return;
    if (
      e.key === 'ArrowDown'
      || e.key === 'ArrowUp'
      || e.key === 'Enter'
      || e.key === ' '
    ) {
      e.preventDefault();
      openFn();
    }
  }

  /**
   * Listbox keyboard handler: ArrowUp/Down move active descendant, Enter
   * commits, Escape closes (without committing). Home/End jump to ends.
   * Stop propagation on Escape so the App-global Esc handler does not also
   * fire (plan §4 R4-3 precedence).
   *
   * @param {KeyboardEvent} e
   * @param {Array} options       Visible options (each with a `.version`).
   * @param {number} activeIdx    Current active descendant index.
   * @param {(i: number) => void} setActiveIdx
   * @param {(v: number) => void} commit
   * @param {() => void} close
   */
  function handleListboxKeydown(e, options, activeIdx, setActiveIdx, commit, close) {
    if (options.length === 0) return;
    switch (e.key) {
      case 'ArrowDown': {
        e.preventDefault();
        const next = activeIdx < 0 ? 0 : Math.min(options.length - 1, activeIdx + 1);
        setActiveIdx(next);
        return;
      }
      case 'ArrowUp': {
        e.preventDefault();
        const next = activeIdx < 0 ? options.length - 1 : Math.max(0, activeIdx - 1);
        setActiveIdx(next);
        return;
      }
      case 'Home': {
        e.preventDefault();
        setActiveIdx(0);
        return;
      }
      case 'End': {
        e.preventDefault();
        setActiveIdx(options.length - 1);
        return;
      }
      case 'Enter':
      case ' ': {
        e.preventDefault();
        if (activeIdx >= 0 && activeIdx < options.length) {
          commit(options[activeIdx].version);
        }
        return;
      }
      case 'Escape': {
        e.preventDefault();
        e.stopPropagation();
        close();
        return;
      }
    }
  }

  function handlePrimaryListboxKeydown(e) {
    handleListboxKeydown(
      e,
      versions,
      primaryActiveIdx,
      (i) => { primaryActiveIdx = i; },
      (v) => onVersionSelect?.(v),
      () => onToggleVersionDropdown?.(),
    );
  }

  function handleCompareListboxKeydown(e) {
    handleListboxKeydown(
      e,
      compareOptions,
      compareActiveIdx,
      (i) => { compareActiveIdx = i; },
      (v) => selectCompareVersion(v),
      () => { showCompareDropdown = false; },
    );
  }

  // Active-descendant id strings for the listbox `aria-activedescendant` attr.
  let primaryActiveId = $derived(
    primaryActiveIdx >= 0 && primaryActiveIdx < versions.length
      ? optionId('primary', versions[primaryActiveIdx].version)
      : null,
  );
  let compareActiveId = $derived(
    compareActiveIdx >= 0 && compareActiveIdx < compareOptions.length
      ? optionId('compare', compareOptions[compareActiveIdx].version)
      : null,
  );
</script>

<div class="artifact-header">
  <div class="artifact-header-top">
    <button class="artifact-back-btn" onclick={onBack} title="Back to list" aria-label="Back to artifact list">
      <ChevronLeft size={16} strokeWidth={2} />
    </button>
    <span class="artifact-header-title">{artifact.title || artifact.name}</span>
    <span class="artifact-type-badge {typeConfig.cssClass}">{typeConfig.label}</span>
    <button class="artifact-close-btn" onclick={onClose} data-testid="artifact-panel-close" title="Close" aria-label="Close artifacts panel">
      <X size={16} strokeWidth={2} />
    </button>
  </div>

  <!-- Secondary controls row: dropdowns, segmented toggle, icon actions. -->
  <div class="artifact-header-controls">
    {#if viewMode === 'diff' && hasMultipleVersions}
      <!-- Compare (from) version dropdown — only when diffing. -->
      <div class="artifact-version-selector" data-testid="compare-version-selector">
        <button
          bind:this={compareTriggerEl}
          class="artifact-version-btn"
          onclick={toggleCompareDropdown}
          onkeydown={(e) => handleTriggerKeydown(e, () => { showCompareDropdown = true; }, showCompareDropdown)}
          aria-expanded={showCompareDropdown}
          aria-haspopup="listbox"
          aria-label="Compare from version (currently v{compareVersion ?? '?'})"
          title="Compare from version"
        >
          <span class="version-btn-label">
            Compare: v{compareVersion ?? '?'}
          </span>
          <ChevronDown size={14} strokeWidth={2} />
        </button>
        {#if showCompareDropdown}
          <div
            bind:this={compareListboxEl}
            class="artifact-version-dropdown"
            role="listbox"
            tabindex="-1"
            aria-label="Compare-from version"
            aria-activedescendant={compareActiveId}
            onkeydown={handleCompareListboxKeydown}
          >
            {#each compareOptions as v, idx (v.version)}
              {@const pc = getParticipantColor(v.author?.key ?? '')}
              <button
                type="button"
                id={optionId('compare', v.version)}
                class="artifact-version-option"
                class:active={v.version === compareVersion}
                class:active-descendant={idx === compareActiveIdx}
                role="option"
                aria-selected={v.version === compareVersion}
                onclick={() => selectCompareVersion(v.version)}
              >
                <span class="row-version">v{v.version}</span>
                <span class="row-author" style="color: {pc.textColor}">{v.author?.name ?? 'unknown'}</span>
                <span class="row-meta">
                  {relTime(v.timestamp)}{#if v.summary} &middot; "{v.summary}"{/if}
                </span>
              </button>
            {/each}
          </div>
        {/if}
      </div>
    {/if}

    <!-- Primary (to) version dropdown. -->
    <div class="artifact-version-selector" data-testid="primary-version-selector">
      <button
        bind:this={primaryTriggerEl}
        class="artifact-version-btn"
        onclick={onToggleVersionDropdown}
        onkeydown={(e) => handleTriggerKeydown(e, () => onToggleVersionDropdown?.(), showVersionDropdown)}
        aria-expanded={showVersionDropdown}
        aria-haspopup="listbox"
        aria-label="Select version (currently v{selectedVersion ?? '?'})"
        title="Select version"
      >
        <span class="version-btn-label">
          v{selectedVersion ?? '?'}{#if activeVersionEntry}
            <span class="version-btn-author"> &middot; {activeVersionEntry.author?.name ?? 'unknown'}</span>
            <span class="version-btn-time"> &middot; {relTime(activeVersionEntry.timestamp)}</span>
          {/if}
        </span>
        <ChevronDown size={14} strokeWidth={2} />
      </button>
      {#if showVersionDropdown}
        <div
          bind:this={primaryListboxEl}
          class="artifact-version-dropdown"
          role="listbox"
          tabindex="-1"
          aria-label="Artifact version"
          aria-activedescendant={primaryActiveId}
          onkeydown={handlePrimaryListboxKeydown}
        >
          {#each versions as v, idx (v.version)}
            {@const pc = getParticipantColor(v.author?.key ?? '')}
            <button
              type="button"
              id={optionId('primary', v.version)}
              class="artifact-version-option"
              class:active={v.version === selectedVersion}
              class:active-descendant={idx === primaryActiveIdx}
              role="option"
              aria-selected={v.version === selectedVersion}
              onclick={() => onVersionSelect?.(v.version)}
            >
              <span class="row-version">v{v.version}</span>
              <span class="row-author" style="color: {pc.textColor}">{v.author?.name ?? 'unknown'}</span>
              <span class="row-meta">
                {relTime(v.timestamp)}{#if v.summary} &middot; "{v.summary}"{/if}
              </span>
            </button>
          {/each}
        </div>
      {/if}
    </div>

    <!-- Content | Diff segmented toggle. -->
    <div class="view-toggle" role="group" aria-label="View mode">
      <button
        type="button"
        class="view-toggle-btn"
        class:active={viewMode === 'content'}
        data-testid="view-toggle-content"
        aria-pressed={viewMode === 'content'}
        onclick={() => onSetViewMode?.('content')}
      >
        Content
      </button>
      <button
        type="button"
        class="view-toggle-btn"
        class:active={viewMode === 'diff'}
        data-testid="view-toggle-diff"
        aria-pressed={viewMode === 'diff'}
        aria-disabled={diffDisabled}
        disabled={diffDisabled}
        title={diffDisabled ? 'Only one version — nothing to diff yet.' : 'Diff against another version'}
        onclick={() => {
          if (diffDisabled) return;
          onSetViewMode?.('diff');
        }}
      >
        Diff
      </button>
    </div>

    <span class="controls-spacer"></span>

    {#if showEditBtn}
      <button
        type="button"
        class="icon-btn"
        data-testid="artifact-edit-btn"
        title="Edit artifact"
        aria-label="Edit artifact"
        onclick={onEdit}
      >
        <Pencil size={16} strokeWidth={2} />
      </button>
    {/if}

    <button
      type="button"
      class="icon-btn"
      class:flashed={copiedFlash}
      data-testid="artifact-copy-btn"
      title="Copy content"
      aria-label="Copy artifact content to clipboard"
      onclick={triggerCopy}
    >
      {#if copiedFlash}
        <Check size={16} strokeWidth={2} />
      {:else}
        <Clipboard size={16} strokeWidth={2} />
      {/if}
    </button>

    <button
      type="button"
      class="icon-btn"
      data-testid="artifact-download-btn"
      title="Download as file"
      aria-label="Download artifact"
      onclick={onDownload}
    >
      <Download size={16} strokeWidth={2} />
    </button>
  </div>
</div>

<style>
  .artifact-header {
    padding: 16px;
    border-bottom: 1px solid var(--border);
    display: flex;
    flex-direction: column;
    gap: 10px;
    /* Stay pinned at the top of the panel; body scrolls independently. */
    flex-shrink: 0;
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

  /* -- Type Badges -- */
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

  /* -- Secondary controls row -- */
  .artifact-header-controls {
    display: flex;
    align-items: center;
    gap: 6px;
    flex-wrap: wrap;
  }

  .controls-spacer {
    flex: 1 1 auto;
    min-width: 0;
  }

  /* -- Version selector (shared) -- */
  .artifact-version-selector {
    position: relative;
  }

  .artifact-version-btn {
    display: flex;
    align-items: center;
    gap: 6px;
    max-width: 220px;
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

  .version-btn-label {
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    max-width: 190px;
  }

  .version-btn-author,
  .version-btn-time {
    color: var(--text-faint);
    font-weight: 400;
  }

  .artifact-version-dropdown {
    position: absolute;
    top: 100%;
    left: 0;
    margin-top: 4px;
    width: 320px;
    max-height: 240px;
    overflow-y: auto;
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.4);
    z-index: 10;
    animation: panelIn 0.15s cubic-bezier(0.16, 1, 0.3, 1) both;
  }

  /* -- Version option row (§3 three-column layout) -- */
  .artifact-version-option {
    display: grid;
    grid-template-columns: 32px auto 1fr;
    align-items: baseline;
    gap: 8px;
    width: 100%;
    padding: 8px 12px;
    background: none;
    border: none;
    font-size: 14px;
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
    background: var(--bg-surface);
  }

  /* Visual indicator for the keyboard-focused option (mirrors :focus-visible
     since the listbox uses `aria-activedescendant` rather than DOM focus). */
  .artifact-version-option.active-descendant {
    background: var(--bg-surface);
    box-shadow: inset 0 0 0 2px var(--ember-500);
  }

  .artifact-version-dropdown:focus {
    outline: none;
  }

  .row-version {
    width: 32px;
    text-align: right;
    font-family: ui-monospace, Menlo, Consolas, monospace;
    font-size: 12px;
    color: var(--text-muted);
    font-weight: 600;
  }

  .row-author {
    font-size: 14px;
    max-width: 140px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    font-weight: 600;
  }

  .row-meta {
    font-size: 14px;
    color: var(--text-faint);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    min-width: 0;
  }

  /* -- View toggle (Content | Diff) -- */
  .view-toggle {
    display: inline-flex;
    align-items: stretch;
    border: 1px solid var(--border);
    border-radius: var(--radius-xs);
    overflow: hidden;
    background: var(--bg-surface);
  }

  .view-toggle-btn {
    position: relative;
    padding: 4px 10px;
    background: transparent;
    border: none;
    font-size: 11px;
    font-weight: 600;
    color: var(--text-muted);
    cursor: pointer;
    transition: var(--transition-fast);
    font-family: inherit;
  }

  .view-toggle-btn + .view-toggle-btn {
    border-left: 1px solid var(--border);
  }

  .view-toggle-btn:hover:not(:disabled) {
    color: var(--text-primary);
  }

  .view-toggle-btn.active {
    color: var(--text-primary);
  }

  .view-toggle-btn.active::after {
    content: '';
    position: absolute;
    left: 8px;
    right: 8px;
    bottom: 2px;
    height: 2px;
    background: var(--ember-400);
    border-radius: 1px;
  }

  .view-toggle-btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  /* -- Icon buttons -- */
  .icon-btn {
    width: 32px;
    height: 32px;
    border-radius: 6px;
    border: none;
    background: transparent;
    color: var(--text-faint);
    cursor: pointer;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    transition: var(--transition-fast);
    flex-shrink: 0;
  }

  .icon-btn:hover {
    background: var(--bg-surface);
    color: var(--text-primary);
  }

  .icon-btn.flashed {
    background: rgba(245, 158, 11, 0.15);
    color: var(--ember-400);
  }
</style>
