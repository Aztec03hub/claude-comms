<script>
  import { ExternalLink } from 'lucide-svelte';

  let { domain = '', title = '', description = '', url = '', image = '' } = $props();

  let faviconUrl = $derived(
    domain ? `https://www.google.com/s2/favicons?domain=${domain}&sz=16` : ''
  );
</script>

<a
  class="link-preview"
  href={url || '#'}
  target="_blank"
  rel="noopener noreferrer"
  title="{domain} — {title}"
>
  <div class="preview-content">
    <div class="preview-header">
      {#if faviconUrl}
        <img class="favicon" src={faviconUrl} alt="" width="14" height="14" loading="lazy" />
      {:else}
        <span class="favicon-placeholder">
          <ExternalLink size={10} strokeWidth={2} />
        </span>
      {/if}
      <span class="preview-domain">{domain}</span>
      <span class="preview-external">
        <ExternalLink size={10} strokeWidth={2} />
      </span>
    </div>

    <div class="preview-title">{title}</div>

    {#if description}
      <div class="preview-desc">{description}</div>
    {/if}
  </div>

  {#if image}
    <div class="preview-image">
      <img src={image} alt="{title}" loading="lazy" />
    </div>
  {:else}
    <div class="preview-image-placeholder">
      <svg width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <rect x="2" y="2" width="16" height="16" rx="2"/>
        <circle cx="7.5" cy="7.5" r="1.5"/>
        <path d="M18 13l-4-4L5 18"/>
      </svg>
    </div>
  {/if}
</a>

<style>
  .link-preview {
    display: flex;
    align-items: stretch;
    gap: 0;
    margin-top: 8px;
    border-left: 3px solid var(--ember-600, #b45309);
    background: var(--bg-surface, #1c1c1f);
    border-radius: 0 var(--radius-sm, 10px) var(--radius-sm, 10px) 0;
    overflow: hidden;
    text-decoration: none;
    color: inherit;
    transition: background 0.15s ease, border-color 0.15s ease, box-shadow 0.15s ease;
    cursor: pointer;
  }

  .link-preview:hover {
    background: var(--bg-elevated, #252528);
    border-left-color: var(--ember-500, #d97706);
    box-shadow: 0 2px 12px rgba(0, 0, 0, 0.15);
  }

  :global(:root[data-theme="light"]) .link-preview {
    background: var(--bg-surface, #e8e5e0);
    border-left-color: var(--ember-600, #92400e);
  }

  :global(:root[data-theme="light"]) .link-preview:hover {
    background: var(--bg-elevated, #ddd9d3);
    border-left-color: var(--ember-500, #d97706);
    box-shadow: 0 2px 12px rgba(0, 0, 0, 0.06);
  }

  /* ── Content area ── */
  .preview-content {
    flex: 1;
    min-width: 0;
    padding: 10px 14px;
    display: flex;
    flex-direction: column;
    gap: 3px;
  }

  .preview-header {
    display: flex;
    align-items: center;
    gap: 6px;
  }

  .favicon {
    width: 14px;
    height: 14px;
    border-radius: 2px;
    flex-shrink: 0;
  }

  .favicon-placeholder {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 14px;
    height: 14px;
    flex-shrink: 0;
    color: var(--ember-400, #f59e0b);
    opacity: 0.6;
  }

  .preview-domain {
    font-size: 10px;
    color: var(--ember-400, #f59e0b);
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  :global(:root[data-theme="light"]) .preview-domain {
    color: var(--ember-500, #d97706);
  }

  .preview-external {
    color: var(--text-faint, #3d3a36);
    opacity: 0;
    transition: opacity 0.15s ease;
    flex-shrink: 0;
    display: flex;
    align-items: center;
  }

  .link-preview:hover .preview-external {
    opacity: 1;
  }

  .preview-title {
    font-size: 13px;
    font-weight: 600;
    color: var(--text-primary, #ede9e3);
    line-height: 1.3;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }

  :global(:root[data-theme="light"]) .preview-title {
    color: var(--text-primary, #1a1816);
  }

  .preview-desc {
    font-size: 12px;
    color: var(--text-muted, #6b6560);
    line-height: 1.4;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }

  :global(:root[data-theme="light"]) .preview-desc {
    color: var(--text-muted, #8a8480);
  }

  /* ── Image / placeholder ── */
  .preview-image {
    width: 80px;
    flex-shrink: 0;
    overflow: hidden;
  }

  .preview-image img {
    width: 100%;
    height: 100%;
    object-fit: cover;
  }

  .preview-image-placeholder {
    width: 64px;
    flex-shrink: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    background: rgba(245, 158, 11, 0.03);
    border-left: 1px solid var(--border-subtle, #1a1a1d);
    color: var(--text-faint, #3d3a36);
    opacity: 0.4;
    transition: opacity 0.15s ease;
  }

  .link-preview:hover .preview-image-placeholder {
    opacity: 0.6;
  }

  :global(:root[data-theme="light"]) .preview-image-placeholder {
    background: rgba(217, 119, 6, 0.03);
    border-left-color: var(--border-subtle, #e0dbd3);
    color: var(--text-muted, #8a8480);
  }
</style>
