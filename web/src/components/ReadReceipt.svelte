<script>
  let { count = 0 } = $props();
</script>

<div class="read-receipt">
  <svg width="14" height="10" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true">
    <path d="M1 5l3 3 7-7"/>
    <path d="M4 5l3 3 7-7" opacity=".5"/>
  </svg>
  <span>Read by {count}</span>
</div>

<style>
  .read-receipt {
    display: flex;
    align-items: center;
    gap: 3px;
    padding: 2px 4px;
  }

  .read-receipt :global(svg) { color: var(--ember-400); }
  .read-receipt span { font-size: 10px; color: var(--text-faint); }
</style>
