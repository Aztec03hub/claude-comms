<!--
  @component ArtifactEditor
  @description In-place editor for an artifact's content (plan §4).

  When `!visible`, renders nothing. When `visible && artifact`:
    - Small strip above: "Editing v{N} · next save = v{N+1}"
    - <textarea {@attach autoresize}> with the current draft
    - Row below: [Save (v{N+1})] [Cancel]

  Keyboard shortcuts on the textarea only:
    - Cmd+Enter / Ctrl+Enter → Save (calls onSave(content))
    - Esc → Cancel (parent shows a confirm when dirty; we still emit onCancel()
      so parent can run its dirty-check)

  Both handlers `stopPropagation()` so they don't bubble to the App-global
  Esc handler (plan §4 R4-3 precedence).

  Focus / scroll preservation (plan §1 R5-4): the orchestrator owns
  `preBannerState`. We expose the textarea element via the `onTextareaMount`
  callback so the orchestrator can capture selection + scrollTop before
  programmatic focus moves to the banner, and restore them when the banner
  is dismissed via the "preserving" paths (Keep editing / X / Esc / auto).

  @prop {boolean}  visible        - Whether the editor is shown.
  @prop {object}   [artifact]     - Current artifact detail (`{ name, content,
                                     version, versions, ... }`).
  @prop {Function} [onSave]       - Called with the current draft content.
  @prop {Function} [onCancel]     - Called when Cancel / Esc fires.
  @prop {Function} [onDirtyChange] - Called with a boolean whenever the dirty
                                     state flips.
  @prop {Function} [onTextareaMount] - Called once with the HTMLTextAreaElement
                                       (and once with `null` on teardown) so the
                                       orchestrator can capture selection +
                                       scrollTop for the banner focus path.
-->
<script>
  import { untrack } from 'svelte';
  import { autoresize } from '../lib/autoresize.js';

  let {
    visible = false,
    artifact = null,
    onSave,
    onCancel,
    onDirtyChange,
    onTextareaMount,
  } = $props();

  // Editor draft content. Initialised from `artifact.content` whenever the
  // editor opens or switches to a different artifact. We intentionally do
  // NOT reset on every artifact prop mutation — only when the
  // (name, version) identity changes — so mid-edit re-fetches from the
  // orchestrator don't silently blow away the user's text.
  // User-editable draft content. Declared as `$state` so the `bind:value`
  // can mutate it while the user types; seeded from the artifact by the
  // identity-reset block below.
  let content = $state('');

  // Snapshot of the (name, version) we last seeded from and of the
  // content at seed time. Used as the dirty-state baseline. These are
  // bookkeeping fields — not user-mutable — but we set them from inside
  // an effect because we only want them to change when the artifact
  // identity changes (not on every keystroke in the textarea).
  let baseName = $state('');
  let baseVersion = $state(0);
  let initialContent = $state('');

  /** @type {HTMLTextAreaElement | null} */
  let textareaEl = null;

  // Reset the draft whenever the editor becomes visible OR the (name,
  // version) composite identity changes. We intentionally DO NOT reset on
  // every `artifact` prop mutation — only on an identity change — so
  // mid-edit orchestrator re-fetches of the same (name, version) don't
  // silently wipe out the user's typing.
  //
  // This is the documented "escape hatch" use of `$effect` for syncing
  // external identity → internal draft state: we read the tracked source
  // (visible, artifact.name, artifact.version) and `untrack` the bookkeeping
  // fields we compare against, so the effect only re-runs when the source
  // actually changes (never because of its own writes).
  $effect(() => {
    if (!visible || !artifact) return;
    const name = artifact?.name ?? '';
    const version = artifact?.version ?? 0;
    untrack(() => {
      if (name !== baseName || version !== baseVersion) {
        baseName = name;
        baseVersion = version;
        initialContent = artifact?.content ?? '';
        content = initialContent;
      }
    });
  });

  // Dirty flag: content differs from the baseline snapshot. Pure derivation.
  let dirty = $derived(visible && content !== initialContent);

  // Push dirty updates outward. The orchestrator uses this for its
  // "Discard unsaved changes?" confirm when switching artifacts / closing
  // the panel. This IS a side effect (calling a callback prop) — $effect
  // is the right tool.
  $effect(() => {
    const d = dirty;
    onDirtyChange?.(d);
  });

  // Next version number for the Save button label. Pure derivation.
  let nextVersion = $derived((artifact?.version ?? 0) + 1);

  /**
   * Keyboard shortcut handler, attached to the textarea. Cmd/Ctrl+Enter
   * triggers Save; Esc triggers Cancel. Both stop propagation so the
   * App-global Esc handler does not also fire (plan §4 R4-3).
   * @param {KeyboardEvent} e
   */
  function handleKeydown(e) {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault();
      e.stopPropagation();
      onSave?.(content);
      return;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      onCancel?.();
    }
  }

  /**
   * Svelte `{@attach}` helper that captures the textarea element for the
   * orchestrator (so it can manage focus / scroll during banner flows)
   * and programmatically focuses it on mount (plan §4 "On mount,
   * programmatic focus to textarea").
   * @param {HTMLTextAreaElement} node
   */
  function registerTextarea(node) {
    textareaEl = node;
    onTextareaMount?.(node);
    // Programmatic focus, non-stealing: queueMicrotask so this lands after
    // the editor container is fully in the DOM.
    queueMicrotask(() => {
      if (textareaEl === node) node.focus();
    });
    return () => {
      // Report unmount so the orchestrator can drop its ref.
      if (textareaEl === node) textareaEl = null;
      onTextareaMount?.(null);
    };
  }
</script>

{#if visible && artifact}
  <div class="artifact-editor-wrap" data-testid="artifact-editor">
    <div class="editor-meta">
      Editing v{artifact.version ?? '?'} &middot; next save = v{nextVersion}
    </div>

    <textarea
      class="artifact-editor"
      data-testid="artifact-editor-textarea"
      bind:value={content}
      onkeydown={handleKeydown}
      aria-label="Editing {artifact.title || artifact.name}"
      spellcheck="false"
      autocomplete="off"
      autocorrect="off"
      {@attach autoresize}
      {@attach registerTextarea}
    ></textarea>

    <div class="editor-actions">
      <button
        type="button"
        class="editor-btn secondary"
        data-testid="artifact-editor-cancel"
        onclick={() => onCancel?.()}
      >
        Cancel
      </button>
      <button
        type="button"
        class="editor-btn primary"
        data-testid="artifact-editor-save"
        onclick={() => onSave?.(content)}
      >
        Save (v{nextVersion})
      </button>
    </div>
  </div>
{/if}

<style>
  .artifact-editor-wrap {
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 12px 16px 16px;
    flex: 1;
    min-height: 0;
  }

  .editor-meta {
    font-size: 12px;
    color: var(--text-muted);
    font-weight: 500;
  }

  .artifact-editor {
    width: 100%;
    min-height: 320px;
    padding: 12px;
    font-family: ui-monospace, Menlo, Consolas, monospace;
    font-size: 13px;
    line-height: 1.5;
    color: var(--text-primary);
    background: var(--bg-deepest);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    resize: none;
    transition: border-color var(--transition-fast);
    /* Progressive enhancement: native `field-sizing: content` lets modern
       browsers match our JS autoresize, turning the attachment into an
       observer-only no-op. The attachment owns correctness across browsers. */
    field-sizing: content;
  }

  .artifact-editor:focus {
    outline: none;
    border-color: var(--ember-500);
    box-shadow: 0 0 0 1px var(--ember-500);
  }

  .editor-actions {
    display: flex;
    justify-content: flex-end;
    gap: 12px;
  }

  .editor-btn {
    font-family: inherit;
    font-size: 12px;
    font-weight: 600;
    padding: 6px 14px;
    border-radius: var(--radius-xs);
    cursor: pointer;
    transition: var(--transition-fast);
  }

  .editor-btn.primary {
    background: var(--ember-500);
    color: #0c0a09;
    border: 1px solid var(--ember-500);
  }

  .editor-btn.primary:hover {
    background: var(--ember-400);
    border-color: var(--ember-400);
  }

  .editor-btn.secondary {
    background: transparent;
    color: var(--text-secondary);
    border: 1px solid var(--border);
  }

  .editor-btn.secondary:hover {
    border-color: var(--ember-700);
    color: var(--text-primary);
  }

  .editor-btn:focus-visible {
    outline: 2px solid var(--ember-500);
    outline-offset: 2px;
  }
</style>
