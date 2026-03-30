<!--
  @component DateSeparator
  @description Renders a horizontal date divider between message groups, showing a formatted date label (e.g., "Today", "Yesterday", or a full date) with decorative gradient lines.
  @prop {string|number} ts - Timestamp (ISO string or epoch ms) for the date to display.
-->
<script>
  import { formatDateSeparator } from '../lib/utils.js';

  let { ts } = $props();

  let label = $derived(formatDateSeparator(ts));
</script>

<div class="date-sep" data-testid="date-separator" role="separator" aria-label="{label}">
  <div class="date-sep-line left"></div>
  <span
    class="date-sep-label"
    title="{new Date(ts).toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}"
  >
    <svg width="11" height="11" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true">
      <circle cx="5.5" cy="5.5" r="4.5"/>
      <path d="M5.5 3v2.5l1.5 1"/>
    </svg>
    {label}
  </span>
  <div class="date-sep-line right"></div>
</div>

<style>
  .date-sep {
    display: flex;
    align-items: center;
    gap: 16px;
    padding: 18px 24px;
    user-select: none;
  }

  .date-sep-line {
    flex: 1;
    height: 1px;
    border: none;
  }

  .date-sep-line.left {
    background: linear-gradient(
      to right,
      transparent,
      var(--border-subtle, #1a1a1d) 30%,
      var(--border, #222225) 70%,
      rgba(245, 158, 11, 0.12)
    );
  }

  .date-sep-line.right {
    background: linear-gradient(
      to left,
      transparent,
      var(--border-subtle, #1a1a1d) 30%,
      var(--border, #222225) 70%,
      rgba(245, 158, 11, 0.12)
    );
  }

  :global(:root[data-theme="light"]) .date-sep-line.left {
    background: linear-gradient(
      to right,
      transparent,
      var(--border-subtle, #e0dbd3) 30%,
      var(--border, #d5d0c8) 70%,
      rgba(217, 119, 6, 0.12)
    );
  }

  :global(:root[data-theme="light"]) .date-sep-line.right {
    background: linear-gradient(
      to left,
      transparent,
      var(--border-subtle, #e0dbd3) 30%,
      var(--border, #d5d0c8) 70%,
      rgba(217, 119, 6, 0.12)
    );
  }

  .date-sep-label {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.3px;
    color: var(--text-faint, #3d3a36);
    background: var(--bg-surface, #1c1c1f);
    border: 1px solid var(--border-subtle, #1a1a1d);
    border-radius: 20px;
    padding: 5px 16px;
    white-space: nowrap;
    box-shadow: 0 0 12px rgba(245, 158, 11, 0.04);
    transition: color 0.2s ease, border-color 0.2s ease, box-shadow 0.2s ease;
  }

  .date-sep-label:hover {
    color: var(--text-muted, #6b6560);
    border-color: var(--border, #222225);
    box-shadow: 0 0 16px rgba(245, 158, 11, 0.08);
  }

  :global(:root[data-theme="light"]) .date-sep-label {
    background: var(--bg-surface, #e8e5e0);
    border-color: var(--border, #d5d0c8);
    color: var(--text-muted, #8a8480);
    box-shadow: 0 0 12px rgba(217, 119, 6, 0.04);
  }

  :global(:root[data-theme="light"]) .date-sep-label:hover {
    color: var(--text-secondary, #4a4540);
    border-color: var(--border, #d5d0c8);
    box-shadow: 0 0 16px rgba(217, 119, 6, 0.08);
  }

  .date-sep-label svg {
    opacity: 0.5;
    flex-shrink: 0;
  }

  .date-sep-label:hover svg {
    opacity: 0.7;
  }
</style>
