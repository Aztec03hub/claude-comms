<script>
  import { Star } from 'lucide-svelte';
  import { getParticipantColor, getInitials } from '../lib/utils.js';

  let { participant, onClose, onMessage, onViewProfile } = $props();

  let color = $derived(getParticipantColor(participant.key));
</script>

<svelte:window onkeydown={(e) => { if (e.key === 'Escape') onClose(); }} />

<div class="profile-backdrop" onclick={onClose} onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') onClose(); }} role="presentation" data-testid="profile-card-close">
  <div
    class="profile-card"
    data-testid="profile-card"
    onclick={(e) => e.stopPropagation()}
    role="dialog"
    aria-label="Profile card for {participant.name}"
    aria-modal="true"
  >
    <div class="profile-card-banner"></div>
    <div class="profile-card-avatar" style="background: {color.gradient}">
      {getInitials(participant.name)}
    </div>
    <div class="profile-card-body">
      <div class="profile-card-name" data-testid="profile-card-name">{participant.name}</div>
      <div class="profile-card-handle">@{participant.name}</div>
      <div class="profile-card-divider"></div>
      <div class="profile-card-section">Role</div>
      <div class="profile-card-role" style="background: rgba(245,158,11,0.1); color: var(--ember-400); border: 1px solid rgba(245,158,11,0.2);">
        <Star size={10} />
        {participant.type === 'human' ? 'Admin' : 'Agent'}
      </div>
      <div class="profile-card-actions">
        <button class="profile-card-btn" onclick={() => { onMessage?.(participant); onClose(); }} data-testid="profile-msg-btn">Message</button>
        <button class="profile-card-btn primary" onclick={() => { onViewProfile?.(participant); onClose(); }} data-testid="profile-view-btn">View Profile</button>
      </div>
    </div>
  </div>
</div>

<style>
  .profile-backdrop {
    position: fixed;
    inset: 0;
    z-index: 49;
  }

  .profile-card {
    position: fixed;
    bottom: 70px;
    left: 14px;
    z-index: 50;
    width: 240px;
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    box-shadow: 0 12px 40px rgba(0,0,0,0.5), 0 0 0 1px rgba(255,255,255,0.03);
    overflow: hidden;
    animation: cardIn 0.25s cubic-bezier(0.16, 1, 0.3, 1) both;
  }

  .profile-card-banner {
    height: 52px;
    background: linear-gradient(135deg, var(--ember-700), var(--ember-500), var(--ember-600));
    position: relative;
  }

  .profile-card-avatar {
    position: absolute;
    top: 32px;
    left: 16px;
    width: 48px;
    height: 48px;
    border-radius: 50%;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 16px;
    font-weight: 700;
    color: #0a0a0c;
    border: 3px solid var(--bg-elevated);
    box-shadow: 0 2px 8px rgba(0,0,0,0.3);
    z-index: 1;
  }

  .profile-card-body { padding: 28px 16px 16px; }
  .profile-card-name { font-size: 15px; font-weight: 700; margin-bottom: 1px; }
  .profile-card-handle { font-size: 12px; color: var(--text-muted); margin-bottom: 10px; }
  .profile-card-divider { height: 1px; background: var(--border); margin: 10px 0; }

  .profile-card-section {
    font-size: 10px;
    font-weight: 700;
    color: var(--text-faint);
    text-transform: uppercase;
    letter-spacing: 0.8px;
    margin-bottom: 6px;
  }

  .profile-card-role {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 3px 10px;
    border-radius: 12px;
    font-size: 11px;
    font-weight: 600;
  }

  .profile-card-actions { display: flex; gap: 6px; margin-top: 12px; }

  .profile-card-btn {
    flex: 1;
    padding: 7px;
    border-radius: var(--radius-sm);
    border: 1px solid var(--border);
    background: var(--bg-surface);
    color: var(--text-secondary);
    font-size: 11px;
    font-weight: 600;
    cursor: pointer;
    transition: var(--transition-fast);
    text-align: center;
    font-family: inherit;
  }

  .profile-card-btn:hover { border-color: var(--ember-700); color: var(--text-primary); }

  .profile-card-btn.primary {
    border-color: var(--ember-600);
    background: linear-gradient(135deg, rgba(217,119,6,0.15), rgba(245,158,11,0.1));
    color: var(--ember-300);
  }

  .profile-card-btn.primary:hover {
    background: linear-gradient(135deg, rgba(217,119,6,0.25), rgba(245,158,11,0.15));
  }
</style>
