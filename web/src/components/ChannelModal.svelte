<script>
  import { Dialog } from "bits-ui";

  let { onClose, onCreate } = $props();

  let channelName = $state('');
  let description = $state('');
  let isPrivate = $state(false);

  function handleCreate() {
    if (!channelName.trim()) return;
    const sanitized = channelName.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
    if (!sanitized) return;
    onCreate(sanitized, description);
  }

  function handleKeydown(e) {
    if (e.key === 'Enter') handleCreate();
  }

  function handleOpenChange(open) {
    if (!open) onClose();
  }
</script>

<Dialog.Root open={true} onOpenChange={handleOpenChange}>
  <Dialog.Portal>
    <Dialog.Overlay class="modal-overlay" data-testid="channel-modal" />
    <Dialog.Content class="modal" data-testid="channel-modal-content">
      <div class="modal-header">
        <Dialog.Title class="modal-title">Create Conversation</Dialog.Title>
        <Dialog.Close class="modal-close" data-testid="channel-modal-close">&times;</Dialog.Close>
      </div>
      <div class="modal-body">
        <div class="modal-field">
          <label class="modal-label" for="channel-name-input">Channel Name</label>
          <input
            id="channel-name-input"
            class="modal-input"
            type="text"
            placeholder="e.g. project-phoenix"
            bind:value={channelName}
            onkeydown={handleKeydown}
            data-testid="channel-modal-name-input"
          >
          <div class="modal-hint">Names must be lowercase, no spaces. Use dashes instead.</div>
        </div>
        <div class="modal-field">
          <label class="modal-label" for="channel-desc-input">Description</label>
          <textarea
            id="channel-desc-input"
            class="modal-textarea"
            placeholder="What is this channel about?"
            bind:value={description}
            data-testid="channel-modal-description"
          ></textarea>
        </div>
        <div class="modal-toggle">
          <div>
            <div class="modal-toggle-label">Private Channel</div>
            <div class="modal-toggle-desc">Only invited members can see this channel</div>
          </div>
          <div
            class="toggle-switch"
            class:active={isPrivate}
            onclick={() => isPrivate = !isPrivate}
            onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); isPrivate = !isPrivate; } }}
            role="switch"
            aria-checked={isPrivate}
            aria-label="Private channel"
            tabindex="0"
            data-testid="channel-modal-private-toggle"
          ></div>
        </div>
      </div>
      <div class="modal-footer">
        <button class="modal-btn secondary" onclick={onClose} data-testid="channel-modal-cancel">Cancel</button>
        <button class="modal-btn primary" onclick={handleCreate} data-testid="channel-modal-create">Create Channel</button>
      </div>
    </Dialog.Content>
  </Dialog.Portal>
</Dialog.Root>

<style>
  :global([data-dialog-overlay].modal-overlay) {
    position: fixed;
    inset: 0;
    z-index: 200;
    background: rgba(0, 0, 0, 0.6);
    backdrop-filter: blur(4px);
    display: flex;
    align-items: center;
    justify-content: center;
    animation: overlayIn 0.2s ease both;
  }

  :global([data-dialog-content].modal) {
    position: fixed;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%);
    z-index: 201;
    width: 440px;
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 16px;
    box-shadow: 0 24px 64px rgba(0,0,0,0.6), 0 0 0 1px rgba(255,255,255,0.04);
    animation: modalIn 0.35s cubic-bezier(0.16, 1, 0.3, 1) both;
    overflow: hidden;
  }

  .modal-header {
    padding: 20px 24px 16px;
    border-bottom: 1px solid var(--border);
    display: flex;
    align-items: center;
    justify-content: space-between;
  }

  :global(.modal-title) {
    font-size: 17px;
    font-weight: 700;
    letter-spacing: -0.3px;
  }

  :global([data-dialog-close].modal-close) {
    width: 28px;
    height: 28px;
    border-radius: 8px;
    border: none;
    background: none;
    color: var(--text-faint);
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    transition: var(--transition-fast);
    font-size: 18px;
  }

  :global([data-dialog-close].modal-close:hover) { background: var(--bg-surface); color: var(--text-primary); }

  .modal-body { padding: 20px 24px; }
  .modal-field { margin-bottom: 18px; }

  .modal-label {
    display: block;
    font-size: 11px;
    font-weight: 700;
    color: var(--text-muted);
    text-transform: uppercase;
    letter-spacing: 0.8px;
    margin-bottom: 6px;
  }

  .modal-input {
    width: 100%;
    padding: 10px 14px;
    background: var(--bg-base);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    color: var(--text-primary);
    font-size: 14px;
    font-family: inherit;
    outline: none;
    transition: var(--transition-med);
  }

  .modal-input:focus { border-color: var(--ember-700); box-shadow: 0 0 0 3px var(--border-glow); }
  .modal-input::placeholder { color: var(--text-faint); }

  .modal-hint { font-size: 11px; color: var(--text-faint); margin-top: 4px; }

  .modal-textarea {
    width: 100%;
    padding: 10px 14px;
    height: 80px;
    resize: vertical;
    background: var(--bg-base);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    color: var(--text-primary);
    font-size: 13px;
    font-family: inherit;
    line-height: 1.5;
    outline: none;
    transition: var(--transition-med);
  }

  .modal-textarea:focus { border-color: var(--ember-700); box-shadow: 0 0 0 3px var(--border-glow); }

  .modal-toggle {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 12px 0;
  }

  .modal-toggle-label { font-size: 13px; font-weight: 500; }
  .modal-toggle-desc { font-size: 11px; color: var(--text-faint); margin-top: 2px; }

  .toggle-switch {
    width: 40px;
    height: 22px;
    border-radius: 11px;
    background: var(--bg-surface);
    border: 1px solid var(--border);
    position: relative;
    cursor: pointer;
    transition: var(--transition-med);
    flex-shrink: 0;
  }

  .toggle-switch.active { background: var(--ember-600); border-color: var(--ember-500); }

  .toggle-switch::after {
    content: '';
    position: absolute;
    top: 2px;
    left: 2px;
    width: 16px;
    height: 16px;
    border-radius: 50%;
    background: var(--text-muted);
    transition: var(--transition-med);
    box-shadow: 0 1px 3px rgba(0,0,0,0.3);
  }

  .toggle-switch.active::after { transform: translateX(18px); background: white; }

  .modal-footer {
    padding: 16px 24px;
    border-top: 1px solid var(--border);
    display: flex;
    justify-content: flex-end;
    gap: 8px;
  }

  .modal-btn {
    padding: 8px 20px;
    border-radius: var(--radius-sm);
    font-size: 13px;
    font-weight: 600;
    cursor: pointer;
    transition: var(--transition-fast);
    border: none;
    font-family: inherit;
  }

  .modal-btn.secondary {
    background: var(--bg-surface);
    color: var(--text-secondary);
    border: 1px solid var(--border);
  }

  .modal-btn.secondary:hover { background: var(--bg-elevated); color: var(--text-primary); }

  .modal-btn.primary {
    background: linear-gradient(135deg, var(--ember-600), var(--ember-400));
    color: #0a0a0c;
    box-shadow: 0 2px 8px rgba(245,158,11,0.2);
  }

  .modal-btn.primary:hover { filter: brightness(1.1); box-shadow: 0 2px 12px rgba(245,158,11,0.3); }
</style>
