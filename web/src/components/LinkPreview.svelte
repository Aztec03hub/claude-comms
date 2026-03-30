<script>
  let { domain = '', title = '', description = '' } = $props();
</script>

<div class="link-preview" title="{domain} — {title}">
  <div class="link-preview-domain">{domain}</div>
  <div class="link-preview-title">{title}</div>
  {#if description}
    <div class="link-preview-desc">{description}</div>
  {/if}
</div>

<style>
  .link-preview {
    margin-top: 8px;
    padding: 10px 14px;
    border-left: 3px solid var(--ember-600);
    background: var(--bg-surface);
    border-radius: 0 var(--radius-sm) var(--radius-sm) 0;
  }

  .link-preview-domain {
    font-size: 10px;
    color: var(--ember-400);
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    margin-bottom: 3px;
  }

  .link-preview-title {
    font-size: 13px;
    font-weight: 600;
    color: var(--text-primary);
    margin-bottom: 2px;
  }

  .link-preview-desc {
    font-size: 12px;
    color: var(--text-muted);
    line-height: 1.4;
  }
</style>
