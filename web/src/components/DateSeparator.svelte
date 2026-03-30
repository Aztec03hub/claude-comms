<script>
  import { formatDateSeparator } from '../lib/utils.js';

  let { ts } = $props();

  let label = $derived(formatDateSeparator(ts));
</script>

<div class="msg-row system">
  <div class="system-msg">
    <span>
      <svg width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" style="opacity: 0.5;"><circle cx="6" cy="6" r="5"/><path d="M6 3v3l2 1"/></svg>
      {label}
    </span>
  </div>
</div>

<style>
  .msg-row.system {
    align-self: center;
    max-width: none;
    padding: 14px 0;
  }

  .system-msg {
    font-size: 12px;
    color: var(--text-faint);
    text-align: center;
    padding: 4px 0;
  }

  .system-msg span {
    background: var(--bg-surface);
    padding: 5px 16px;
    border-radius: 20px;
    border: 1px solid var(--border-subtle);
    font-weight: 500;
    letter-spacing: 0.2px;
    display: inline-flex;
    align-items: center;
    gap: 6px;
  }
</style>
