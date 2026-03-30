<script>
  import { Reply, Smile, Ellipsis } from 'lucide-svelte';

  let { message, onReply, onReact, onMore } = $props();
</script>

<div class="msg-actions" data-testid="message-actions" role="toolbar" aria-label="Message actions">
  <button class="msg-action-btn" title="Reply" aria-label="Reply to message" onclick={onReply} data-testid="action-reply">
    <Reply size={14} />
  </button>
  <button class="msg-action-btn" title="React" aria-label="Add reaction" onclick={onReact} data-testid="action-react">
    <Smile size={14} />
  </button>
  <button class="msg-action-btn" title="More" aria-label="More actions" aria-haspopup="true" onclick={onMore} data-testid="action-more">
    <Ellipsis size={14} />
  </button>
</div>

<style>
  .msg-actions {
    position: absolute;
    top: -14px;
    right: 10px;
    display: flex;
    gap: 2px;
    opacity: 0;
    transition: opacity var(--transition-fast);
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 2px;
    box-shadow: 0 4px 16px rgba(0,0,0,0.4), 0 0 0 1px rgba(255,255,255,0.03);
    z-index: 10;
  }

  :global(.msg-row.human) .msg-actions { right: auto; left: 10px; }
  :global(.msg-row:hover) .msg-actions { opacity: 1; }

  .msg-action-btn {
    width: 28px;
    height: 28px;
    border-radius: var(--radius-xs);
    border: none;
    background: none;
    color: var(--text-muted);
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    transition: var(--transition-fast);
    font-size: 14px;
    position: relative;
  }

  .msg-action-btn:hover {
    background: var(--bg-surface);
    color: var(--ember-300);
  }

  .msg-action-btn:hover::after {
    content: attr(title);
    position: absolute;
    bottom: 100%;
    left: 50%;
    transform: translateX(-50%);
    padding: 3px 8px;
    border-radius: 4px;
    background: var(--bg-deepest);
    border: 1px solid var(--border);
    font-size: 10px;
    white-space: nowrap;
    color: var(--text-secondary);
    pointer-events: none;
    margin-bottom: 4px;
    box-shadow: 0 4px 12px rgba(0,0,0,0.3);
  }
</style>
