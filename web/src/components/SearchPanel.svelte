<script>
  import { onMount } from 'svelte';
  import { X, SearchX, Search as SearchIcon } from 'lucide-svelte';
  import { getParticipantColor, getInitials, formatTime } from '../lib/utils.js';

  let { store, onClose } = $props();

  let searchQuery = $state('');
  let activeFilter = $state('all');
  let results = $state([]);
  let searchInputEl = $state(null);

  const filters = ['All', 'Messages', 'Files', 'Code', 'Links'];

  onMount(() => {
    // Auto-focus the search input when panel opens
    if (searchInputEl) searchInputEl.focus();
  });

  // Escape handled by App.svelte global handler

  function handleSearch() {
    if (!searchQuery.trim()) {
      results = [];
      return;
    }
    results = store.searchMessages(searchQuery);
  }

  function handleInput(e) {
    searchQuery = e.target.value;
    handleSearch();
  }

  function highlightMatch(text, query) {
    if (!query) return text;
    const regex = new RegExp('(' + query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ')', 'gi');
    return text.replace(regex, '<mark>$1</mark>');
  }
</script>

<div class="search-panel" data-testid="search-panel" role="search" aria-label="Search messages">
  <div class="search-panel-header">
    <div class="search-panel-top">
      <span class="search-panel-title">Search Messages</span>
      <button class="search-panel-close" onclick={onClose} data-testid="search-panel-close" aria-label="Close search panel"><X size={16} strokeWidth={2} /></button>
    </div>
    <label for="search-panel-input-field" class="sr-only">Search messages</label>
    <input
      id="search-panel-input-field"
      class="search-panel-input"
      type="text"
      placeholder="Search..."
      bind:value={searchQuery}
      bind:this={searchInputEl}
      oninput={handleInput}
      data-testid="search-panel-input"
    >
    <div class="search-panel-filters">
      {#each filters as filter}
        <button
          class="search-filter"
          class:active={activeFilter === filter.toLowerCase()}
          onclick={() => activeFilter = filter.toLowerCase()}
          data-testid="search-filter-{filter.toLowerCase()}"
        >{filter}</button>
      {/each}
    </div>
  </div>
  <div class="search-results">
    {#if results.length > 0}
      <div class="search-results-count">{results.length} result{results.length !== 1 ? 's' : ''} for "{searchQuery}"</div>
      {#each results as result (result.id)}
        {@const color = getParticipantColor(result.sender.key)}
        <div class="search-result">
          <div class="search-result-header">
            <div class="search-result-avatar" style="background: {color.gradient}">{getInitials(result.sender.name)}</div>
            <span class="search-result-name" style="color: {color.textColor}">{result.sender.name}</span>
            <span class="search-result-channel">#{result.channel || result.conv}</span>
            <span class="search-result-time">{formatTime(result.ts, 'relative')}</span>
          </div>
          <div class="search-result-text">{@html highlightMatch(result.body.slice(0, 150), searchQuery)}</div>
        </div>
      {/each}
    {:else if searchQuery.trim()}
      <div class="search-empty">
        <div class="search-empty-icon">
          <SearchX size={24} strokeWidth={1.5} />
        </div>
        <div class="search-empty-title">No results found</div>
        <div class="search-empty-hint">No messages match "{searchQuery}"</div>
      </div>
    {:else}
      <div class="search-empty">
        <div class="search-empty-icon muted">
          <SearchIcon size={24} strokeWidth={1.5} />
        </div>
        <div class="search-empty-title">Search messages</div>
        <div class="search-empty-hint">Find messages, files, and links across all channels.</div>
      </div>
    {/if}
  </div>
</div>

<style>
  .search-panel {
    position: absolute;
    top: 82px;
    right: 0;
    bottom: 0;
    width: 380px;
    z-index: 50;
    background: rgba(20, 20, 22, 0.96);
    backdrop-filter: blur(20px);
    border-left: 1px solid var(--border);
    box-shadow: -8px 0 32px rgba(0,0,0,0.3);
    display: flex;
    flex-direction: column;
    animation: searchSlide 0.3s cubic-bezier(0.16, 1, 0.3, 1) both;
  }

  .search-panel-header {
    padding: 16px;
    border-bottom: 1px solid var(--border);
    display: flex;
    flex-direction: column;
    gap: 10px;
  }

  .search-panel-top {
    display: flex;
    align-items: center;
    justify-content: space-between;
  }

  .search-panel-title { font-size: 14px; font-weight: 700; }

  .search-panel-close {
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
    font-size: 16px;
  }

  .search-panel-close:hover { background: var(--bg-surface); color: var(--text-primary); }

  .search-panel-input {
    width: 100%;
    padding: 9px 12px;
    background: var(--bg-surface);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    color: var(--text-primary);
    font-size: 13px;
    outline: none;
    font-family: inherit;
    transition: var(--transition-med);
  }

  .search-panel-input:focus { border-color: var(--ember-700); }

  .search-panel-filters { display: flex; gap: 4px; flex-wrap: wrap; }

  .search-filter {
    padding: 3px 10px;
    border-radius: 12px;
    background: var(--bg-surface);
    border: 1px solid var(--border);
    font-size: 10px;
    font-weight: 600;
    color: var(--text-muted);
    cursor: pointer;
    transition: var(--transition-fast);
    font-family: inherit;
  }

  .search-filter:hover { border-color: var(--ember-700); color: var(--text-secondary); }
  .search-filter.active { border-color: var(--ember-600); color: var(--ember-400); background: rgba(245,158,11,0.08); }

  .search-results { flex: 1; overflow-y: auto; padding: 8px; }

  .search-results-count {
    padding: 8px 8px 4px;
    font-size: 11px;
    color: var(--text-faint);
    font-weight: 500;
  }

  .search-result {
    padding: 10px 12px;
    border-radius: var(--radius-sm);
    cursor: pointer;
    transition: var(--transition-fast);
    margin-bottom: 2px;
  }

  .search-result:hover { background: var(--bg-surface); }

  .search-result-header {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-bottom: 4px;
  }

  .search-result-avatar {
    width: 20px;
    height: 20px;
    border-radius: 50%;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 8px;
    font-weight: 700;
    color: #0a0a0c;
  }

  .search-result-name { font-size: 12px; font-weight: 600; }
  .search-result-time { font-size: 10px; color: var(--text-faint); margin-left: auto; }
  .search-result-channel { font-size: 10px; color: var(--text-faint); }

  .search-result-text { font-size: 12.5px; color: var(--text-secondary); line-height: 1.5; }

  .search-result-text :global(mark) {
    background: rgba(245,158,11,0.2);
    color: var(--ember-300);
    padding: 0 2px;
    border-radius: 2px;
  }

  .search-empty {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    padding: 48px 24px;
    gap: 8px;
    animation: emptyFadeIn 0.4s ease both;
  }

  .search-empty-icon {
    width: 48px;
    height: 48px;
    border-radius: 50%;
    background: rgba(245,158,11,0.06);
    border: 1px solid rgba(245,158,11,0.1);
    display: flex;
    align-items: center;
    justify-content: center;
    color: var(--ember-400);
    opacity: 0.7;
    margin-bottom: 4px;
  }

  .search-empty-icon.muted {
    background: var(--bg-surface);
    border-color: var(--border);
    color: var(--text-faint);
  }

  .search-empty-title {
    font-size: 14px;
    font-weight: 600;
    color: var(--text-secondary);
  }

  .search-empty-hint {
    font-size: 12px;
    color: var(--text-faint);
    text-align: center;
    line-height: 1.5;
  }

  @keyframes emptyFadeIn {
    from { opacity: 0; transform: translateY(8px); }
    to { opacity: 1; transform: translateY(0); }
  }
</style>
