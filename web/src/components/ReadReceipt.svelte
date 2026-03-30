<script>
  let { count = 0, readers = [] } = $props();

  let showTooltip = $state(false);

  let tooltipText = $derived(() => {
    if (readers.length > 0) {
      return readers.join(', ');
    }
    return `${count} ${count === 1 ? 'person' : 'people'}`;
  });
</script>

<div
  class="read-receipt"
  class:has-readers={count > 0}
  role="status"
  aria-label="Read by {count} {count === 1 ? 'person' : 'people'}"
  onmouseenter={() => showTooltip = true}
  onmouseleave={() => showTooltip = false}
>
  <svg class="checks" width="16" height="11" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path class="check check-1" d="M1 5.5l3 3L11 1.5" stroke-width="2"/>
    <path class="check check-2" d="M5 5.5l3 3L15 1.5" stroke-width="2"/>
  </svg>
  <span class="read-count">Read by {count}</span>

  {#if showTooltip && count > 0}
    <div class="tooltip" role="tooltip">
      <div class="tooltip-arrow"></div>
      <span class="tooltip-text">
        {#if readers.length > 0}
          {#each readers as reader, i}
            <span class="reader-name">{reader}{i < readers.length - 1 ? ',' : ''}</span>
          {/each}
        {:else}
          Read by {count} {count === 1 ? 'person' : 'people'}
        {/if}
      </span>
    </div>
  {/if}
</div>

<style>
  .read-receipt {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 2px 6px;
    border-radius: 4px;
    position: relative;
    cursor: default;
    transition: background 0.15s ease;
  }

  .read-receipt:hover {
    background: rgba(245, 158, 11, 0.04);
  }

  :global(:root[data-theme="light"]) .read-receipt:hover {
    background: rgba(217, 119, 6, 0.04);
  }

  /* ── Check mark SVG ── */
  .checks {
    flex-shrink: 0;
  }

  .check {
    stroke: var(--text-faint, #3d3a36);
    transition: stroke 0.2s ease;
  }

  .has-readers .check {
    stroke: var(--ember-400, #f59e0b);
  }

  :global(:root[data-theme="light"]) .has-readers .check {
    stroke: var(--ember-500, #d97706);
  }

  /* Staggered entrance animation */
  .check-1 {
    stroke-dasharray: 14;
    stroke-dashoffset: 14;
    animation: drawCheck 0.35s ease-out 0.1s forwards;
  }

  .check-2 {
    stroke-dasharray: 18;
    stroke-dashoffset: 18;
    animation: drawCheck 0.4s ease-out 0.3s forwards;
    opacity: 0.7;
  }

  @keyframes drawCheck {
    to {
      stroke-dashoffset: 0;
    }
  }

  /* ── Count label ── */
  .read-count {
    font-size: 10px;
    color: var(--text-faint, #3d3a36);
    letter-spacing: 0.2px;
    white-space: nowrap;
  }

  .has-readers .read-count {
    color: var(--text-muted, #6b6560);
  }

  :global(:root[data-theme="light"]) .read-count {
    color: var(--text-muted, #8a8480);
  }

  /* ── Tooltip ── */
  .tooltip {
    position: absolute;
    bottom: calc(100% + 8px);
    left: 50%;
    transform: translateX(-50%);
    background: var(--bg-elevated, #252528);
    border: 1px solid var(--border, #222225);
    border-radius: 6px;
    padding: 6px 10px;
    box-shadow: 0 4px 16px rgba(0, 0, 0, 0.3);
    z-index: 100;
    animation: tooltipIn 0.15s ease;
    pointer-events: none;
    white-space: nowrap;
  }

  :global(:root[data-theme="light"]) .tooltip {
    background: #fff;
    border-color: var(--border, #d5d0c8);
    box-shadow: 0 4px 16px rgba(0, 0, 0, 0.1);
  }

  @keyframes tooltipIn {
    from {
      opacity: 0;
      transform: translateX(-50%) translateY(4px);
    }
    to {
      opacity: 1;
      transform: translateX(-50%) translateY(0);
    }
  }

  .tooltip-arrow {
    position: absolute;
    bottom: -5px;
    left: 50%;
    transform: translateX(-50%) rotate(45deg);
    width: 8px;
    height: 8px;
    background: var(--bg-elevated, #252528);
    border-right: 1px solid var(--border, #222225);
    border-bottom: 1px solid var(--border, #222225);
  }

  :global(:root[data-theme="light"]) .tooltip-arrow {
    background: #fff;
    border-right-color: var(--border, #d5d0c8);
    border-bottom-color: var(--border, #d5d0c8);
  }

  .tooltip-text {
    font-size: 11px;
    color: var(--text-secondary, #a8a098);
    display: flex;
    gap: 4px;
    flex-wrap: wrap;
  }

  :global(:root[data-theme="light"]) .tooltip-text {
    color: var(--text-secondary, #4a4540);
  }

  .reader-name {
    font-weight: 500;
    color: var(--text-primary, #ede9e3);
  }

  :global(:root[data-theme="light"]) .reader-name {
    color: var(--text-primary, #1a1816);
  }
</style>
