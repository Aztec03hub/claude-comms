<script>
  import { X, MessageSquare, BellOff } from 'lucide-svelte';
  import { getParticipantColor, getInitials } from '../lib/utils.js';

  let { participant, onClose, onSendMessage } = $props();

  let color = $derived(getParticipantColor(participant.key));
  let muteNotifications = $state(false);

  let roleBadge = $derived(
    participant.type === 'human' ? 'Admin' : participant.role === 'admin' ? 'Admin' : 'Agent'
  );

  let typeIndicator = $derived(participant.type === 'human' ? 'Human \u{1F464}' : 'Claude \u{1F916}');

  function handleSendMessage() {
    onSendMessage?.(participant);
    onClose();
  }
</script>

<div class="user-profile-panel" data-testid="user-profile-view" role="complementary" aria-label="User Profile">
  <div class="panel-header">
    <span class="panel-title">User Profile</span>
    <button class="panel-close" onclick={onClose} data-testid="user-profile-view-close" aria-label="Close user profile panel">
      <X size={16} strokeWidth={2} />
    </button>
  </div>

  <div class="panel-body">
    <div class="profile-hero">
      <div class="profile-avatar" style="background: {color.gradient}">
        {getInitials(participant.name)}
      </div>
      <div class="profile-name" style="color: {color.base}">{participant.name}</div>
      <div class="profile-handle">@{participant.name}</div>
    </div>

    <div class="profile-section">
      <div class="info-row">
        <span class="info-label">Role</span>
        <span class="role-badge">{roleBadge}</span>
      </div>
      <div class="info-row">
        <span class="info-label">Type</span>
        <span class="info-value">{typeIndicator}</span>
      </div>
      <div class="info-row">
        <span class="info-label">Participant Key</span>
        <span class="info-value mono">{participant.key}</span>
      </div>
      <div class="info-row">
        <span class="info-label">Status</span>
        <span class="info-value status-value" class:online={participant.online !== false} class:offline={participant.online === false}>
          <span class="status-dot"></span>
          {participant.online !== false ? 'Online' : 'Offline'}
        </span>
      </div>
    </div>

    <div class="profile-section">
      <div class="section-heading">Actions</div>
      <button class="action-btn" onclick={handleSendMessage}>
        <MessageSquare size={14} strokeWidth={2} />
        Send Message
      </button>
      <button class="action-btn" onclick={() => muteNotifications = !muteNotifications}>
        <BellOff size={14} strokeWidth={2} />
        {muteNotifications ? 'Unmute Notifications' : 'Mute Notifications'}
        <span class="toggle-indicator" class:active={muteNotifications}></span>
      </button>
    </div>
  </div>
</div>

<style>
  .user-profile-panel {
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

  .panel-header {
    padding: 16px;
    border-bottom: 1px solid var(--border);
    display: flex;
    align-items: center;
    justify-content: space-between;
  }

  .panel-title {
    font-size: 14px;
    font-weight: 700;
  }

  .panel-close {
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
  }

  .panel-close:hover {
    background: var(--bg-surface);
    color: var(--text-primary);
  }

  .panel-body {
    flex: 1;
    overflow-y: auto;
    padding: 8px 16px 16px;
  }

  .profile-hero {
    display: flex;
    flex-direction: column;
    align-items: center;
    padding: 20px 0 16px;
  }

  .profile-avatar {
    width: 64px;
    height: 64px;
    border-radius: 50%;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 22px;
    font-weight: 700;
    color: #0a0a0c;
    border: 3px solid var(--bg-elevated);
    box-shadow: 0 4px 16px rgba(0,0,0,0.4);
    margin-bottom: 12px;
  }

  .profile-name {
    font-size: 18px;
    font-weight: 700;
    margin-bottom: 2px;
  }

  .profile-handle {
    font-size: 13px;
    color: var(--text-muted);
  }

  .profile-section {
    padding: 14px 0;
    border-bottom: 1px solid var(--border-subtle, var(--border));
  }

  .profile-section:last-child {
    border-bottom: none;
  }

  .section-heading {
    font-size: 11px;
    font-weight: 700;
    letter-spacing: 1px;
    text-transform: uppercase;
    color: var(--ember-400);
    margin-bottom: 12px;
  }

  .info-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 10px;
  }

  .info-row:last-child {
    margin-bottom: 0;
  }

  .info-label {
    font-size: 12px;
    color: var(--text-muted);
    font-weight: 500;
  }

  .info-value {
    font-size: 13px;
    color: var(--text-secondary);
  }

  .info-value.mono {
    font-family: 'SF Mono', Consolas, monospace;
    font-size: 11px;
    color: var(--text-faint);
    max-width: 200px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .role-badge {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 3px 10px;
    border-radius: 12px;
    font-size: 11px;
    font-weight: 600;
    background: rgba(245,158,11,0.1);
    color: var(--ember-400);
    border: 1px solid rgba(245,158,11,0.2);
  }

  .status-value {
    display: flex;
    align-items: center;
    gap: 6px;
  }

  .status-dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--text-faint);
  }

  .online .status-dot {
    background: #22c55e;
    box-shadow: 0 0 6px rgba(34, 197, 94, 0.4);
  }

  .offline .status-dot {
    background: #ef4444;
    box-shadow: 0 0 6px rgba(239, 68, 68, 0.4);
  }

  .online { color: #22c55e; }
  .offline { color: #ef4444; }

  .action-btn {
    width: 100%;
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 10px 12px;
    border-radius: var(--radius-sm);
    border: 1px solid var(--border);
    background: var(--bg-surface);
    color: var(--text-secondary);
    font-size: 13px;
    font-weight: 500;
    cursor: pointer;
    transition: var(--transition-fast);
    font-family: inherit;
    margin-bottom: 6px;
  }

  .action-btn:last-child {
    margin-bottom: 0;
  }

  .action-btn:hover {
    border-color: var(--ember-700);
    color: var(--text-primary);
    background: linear-gradient(135deg, rgba(217,119,6,0.08), rgba(245,158,11,0.04));
  }

  .toggle-indicator {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--text-faint);
    margin-left: auto;
    transition: var(--transition-fast);
  }

  .toggle-indicator.active {
    background: var(--ember-400);
    box-shadow: 0 0 6px rgba(245,158,11,0.4);
  }

  @media (max-width: 480px) {
    .user-profile-panel {
      width: 100%;
    }
  }
</style>
