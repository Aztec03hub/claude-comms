<script>
  let { name = '', type = 'file', size = '' } = $props();

  let iconClass = $derived(
    type === 'pdf' ? 'pdf' :
    type === 'doc' || type === 'docx' ? 'doc' :
    type === 'image' || type === 'png' || type === 'jpg' ? 'img' : ''
  );
</script>

<div class="file-attachment">
  <div class="file-icon {iconClass}">
    <svg width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 1h7l5 5v10a1 1 0 01-1 1H4a1 1 0 01-1-1V2a1 1 0 011-1z"/><path d="M11 1v5h5"/></svg>
  </div>
  <div class="file-info">
    <div class="file-name">{name}</div>
    <div class="file-meta">
      <span>{type.toUpperCase()}</span>
      <span>&bull;</span>
      <span>{size}</span>
    </div>
  </div>
  <button class="file-download">
    <svg width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M7 2v8m-3-3l3 3 3-3 M2 12h10"/></svg>
  </button>
</div>

<style>
  .file-attachment {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 10px 14px;
    margin-top: 8px;
    background: var(--bg-surface);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    cursor: pointer;
    transition: var(--transition-fast);
  }

  .file-attachment:hover { border-color: var(--ember-700); background: var(--bg-elevated); }

  .file-icon {
    width: 40px;
    height: 40px;
    border-radius: 8px;
    flex-shrink: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 16px;
    font-weight: 700;
  }

  .file-icon.pdf { background: rgba(239,68,68,0.12); color: #ef4444; }
  .file-icon.doc { background: rgba(59,130,246,0.12); color: #3b82f6; }
  .file-icon.img { background: rgba(52,211,153,0.12); color: #34d399; }

  .file-info { flex: 1; min-width: 0; }

  .file-name {
    font-size: 13px;
    font-weight: 600;
    color: var(--text-primary);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .file-meta {
    font-size: 11px;
    color: var(--text-faint);
    display: flex;
    align-items: center;
    gap: 6px;
  }

  .file-download {
    width: 32px;
    height: 32px;
    border-radius: 8px;
    border: 1px solid var(--border);
    background: none;
    color: var(--text-faint);
    cursor: pointer;
    flex-shrink: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    transition: var(--transition-fast);
  }

  .file-download:hover {
    border-color: var(--ember-600);
    color: var(--ember-400);
    background: rgba(245,158,11,0.05);
  }
</style>
