/**
 * @component FileAttachment
 *
 * Renders a downloadable file card within a message bubble.
 *
 * **Planned architecture for file sharing:**
 *
 * 1. **Upload path:** MessageInput will accept file drops/selections.
 *    Files under a size threshold (e.g. 256 KB) are base64-encoded and
 *    published inline in the MQTT message payload under an `attachments[]`
 *    array. Larger files are uploaded to a companion HTTP endpoint
 *    (`POST /api/files`) backed by local-disk or S3-compatible storage,
 *    which returns a signed download URL.
 *
 * 2. **Message schema:** Each attachment object carries
 *    `{ name, type, size, url, inline_data? }`. The `url` field is
 *    either the HTTP download URL or a `data:` URI for inline files.
 *
 * 3. **Download path:** This component reads the attachment metadata and
 *    triggers a browser download via an `<a>` element. For inline data
 *    it creates a Blob URL; for HTTP URLs it fetches with the signed token.
 *
 * 4. **Retention & cleanup:** Files stored server-side honor the channel's
 *    retention policy. A periodic cleanup job prunes expired uploads.
 *    MQTT retained messages are re-published without expired attachment URLs.
 *
 * 5. **Security:** Uploads are validated for MIME type and scanned for size
 *    limits. Signed URLs expire after a configurable TTL. Inline payloads
 *    are sanitized before rendering.
 */
<script>
  import { File, Download } from 'lucide-svelte';

  let { name = '', type = 'file', size = '', url = '' } = $props();

  let iconClass = $derived(
    type === 'pdf' ? 'pdf' :
    type === 'doc' || type === 'docx' ? 'doc' :
    type === 'image' || type === 'png' || type === 'jpg' ? 'img' : ''
  );

  function handleDownload(e) {
    e.stopPropagation();
    triggerDownload();
  }

  function triggerDownload() {
    const a = document.createElement('a');
    a.href = url || '#';
    a.download = name || 'download';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  }
</script>

<div class="file-attachment" onclick={triggerDownload} onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') triggerDownload(); }} role="button" tabindex="0" title="{name} ({type.toUpperCase()}, {size})" aria-label="Download {name}">
  <div class="file-icon {iconClass}">
    <File size={18} strokeWidth={2} />
  </div>
  <div class="file-info">
    <div class="file-name">{name}</div>
    <div class="file-meta">
      <span>{type.toUpperCase()}</span>
      <span>&bull;</span>
      <span>{size}</span>
    </div>
  </div>
  <button class="file-download" onclick={handleDownload} data-testid="file-download" title="Download {name}" aria-label="Download {name}">
    <Download size={14} strokeWidth={2} />
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
