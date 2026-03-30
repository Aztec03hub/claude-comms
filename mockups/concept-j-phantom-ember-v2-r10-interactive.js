(function() {
  'use strict';

  /* ================================================================
     REFERENCES
     ================================================================ */
  var messagesEl = document.querySelector('.messages');
  var chatHeaderName = document.querySelector('.header-name');
  var mainInput = document.querySelector('.input-area .input-wrap input');
  var sendBtn = document.querySelector('.btn-send');
  var scrollBottomBtn = document.querySelector('.scroll-bottom');

  var pinnedPanel = document.querySelector('.pinned-panel');
  var searchPanel = document.querySelector('.search-panel');
  var threadPanel = document.querySelector('.thread-panel');
  var toast = document.querySelector('.toast');
  var emojiPicker = document.querySelector('.emoji-picker');
  var contextMenu = document.querySelector('.context-menu');
  var modalOverlay = document.querySelector('.modal-overlay');
  var profileCard = document.querySelector('.profile-card');

  /* ================================================================
     HELPER: escape HTML for user input
     ================================================================ */
  function escapeHtml(str) {
    var div = document.createElement('div');
    div.textContent = str;
    return div.childNodes[0] ? div.childNodes[0].textContent : '';
  }

  /* ================================================================
     HELPER: build an element from safe parts (no innerHTML needed)
     ================================================================ */
  function createEl(tag, className, text) {
    var el = document.createElement(tag);
    if (className) el.className = className;
    if (text) el.textContent = text;
    return el;
  }

  function formatTime() {
    var now = new Date();
    var h = now.getHours();
    var m = String(now.getMinutes()).padStart(2, '0');
    var ampm = h >= 12 ? 'PM' : 'AM';
    h = h % 12 || 12;
    return 'Today at ' + h + ':' + m + ' ' + ampm;
  }

  function formatTimeShort() {
    return new Date().toLocaleTimeString([], {hour:'numeric', minute:'2-digit'});
  }

  /* Build a message row using DOM methods (no innerHTML) */
  function buildMsgRow(text) {
    var row = createEl('div', 'msg-row human');

    // Avatar
    var avatar = createEl('div', 'avatar');
    avatar.style.background = 'linear-gradient(135deg,#b45309,#f59e0b)';
    avatar.textContent = 'PL';
    row.appendChild(avatar);

    // Bubble wrap
    var bw = createEl('div', 'bubble-wrap');

    // Sender line
    var sl = createEl('div', 'sender-line');
    var sn = createEl('span', 'sender-name', 'phil');
    sn.style.color = '#f59e0b';
    sl.appendChild(sn);
    sl.appendChild(createEl('span', 'msg-time', formatTime()));
    bw.appendChild(sl);

    // Bubble
    var bubble = createEl('div', 'bubble', text);
    bw.appendChild(bubble);

    // Reactions container with add button
    var reactions = createEl('div', 'reactions');
    var addBtn = createEl('div', 'reaction-add', '+');
    reactions.appendChild(addBtn);
    bw.appendChild(reactions);

    row.appendChild(bw);

    // Action bar
    var actions = createEl('div', 'msg-actions');
    ['Reply', 'React', 'More'].forEach(function(title) {
      var btn = createEl('button', 'msg-action-btn');
      btn.title = title;
      if (title === 'Reply') {
        btn.insertAdjacentHTML('afterbegin', '<svg width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M5 4L1 7.5 5 11"/><path d="M1 7.5h8a4 4 0 014 4v.5"/></svg>');
      } else if (title === 'React') {
        btn.insertAdjacentHTML('afterbegin', '<svg width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="7" cy="7" r="5.5"/><path d="M5 8.5s.8 1 2 1 2-1 2-1"/></svg>');
      } else {
        btn.insertAdjacentHTML('afterbegin', '<svg width="14" height="14" fill="currentColor"><circle cx="3" cy="7" r="1.2"/><circle cx="7" cy="7" r="1.2"/><circle cx="11" cy="7" r="1.2"/></svg>');
      }
      actions.appendChild(btn);
    });
    row.appendChild(actions);

    return row;
  }

  /* Build a thread reply using DOM methods */
  function buildThreadReply(text) {
    var reply = createEl('div', 'thread-reply');

    var avatar = createEl('div', 'thread-reply-avatar');
    avatar.style.background = 'linear-gradient(135deg,#b45309,#f59e0b)';
    avatar.textContent = 'PL';
    reply.appendChild(avatar);

    var content = createEl('div', 'thread-reply-content');
    var header = createEl('div', 'thread-reply-header');
    var name = createEl('span', 'thread-reply-name', 'phil');
    name.style.color = '#f59e0b';
    header.appendChild(name);
    header.appendChild(createEl('span', 'thread-reply-time', formatTimeShort()));
    content.appendChild(header);
    content.appendChild(createEl('div', 'thread-reply-text', text));
    reply.appendChild(content);

    return reply;
  }

  /* Build a channel item using DOM methods */
  function buildChannelItem(channelName) {
    var item = createEl('div', 'channel-item');

    var icon = createEl('div', 'ch-icon');
    icon.insertAdjacentHTML('afterbegin', '<svg width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 2v12M12 2v12M2 6h12M2 10h12"/></svg>');
    item.appendChild(icon);

    var info = createEl('div', 'ch-info');
    info.appendChild(createEl('div', 'ch-name', channelName));
    info.appendChild(createEl('div', 'ch-preview', 'No messages yet'));
    item.appendChild(info);

    var meta = createEl('div', 'ch-meta');
    meta.appendChild(createEl('span', 'ch-time', 'now'));
    item.appendChild(meta);

    return item;
  }

  /* ================================================================
     1. INITIAL STATE - hide overlay elements
     ================================================================ */
  pinnedPanel.classList.add('hidden');
  searchPanel.classList.add('hidden');
  threadPanel.classList.add('hidden');
  emojiPicker.classList.add('hidden');
  contextMenu.classList.add('hidden');
  modalOverlay.classList.add('hidden');
  profileCard.classList.add('hidden');
  scrollBottomBtn.classList.add('hidden');

  // Toast starts visible, auto-dismiss after 5s
  var toastTimer = setTimeout(dismissToast, 5000);

  /* ================================================================
     2. SIDEBAR CHANNELS - click to activate
     ================================================================ */
  document.querySelectorAll('.channel-item').forEach(function(item) {
    item.addEventListener('click', function(e) {
      if (e.target.closest('.ch-action-btn')) return;
      document.querySelectorAll('.channel-item').forEach(function(ch) {
        ch.classList.remove('active');
      });
      this.classList.add('active');
      var name = this.querySelector('.ch-name').textContent;
      chatHeaderName.textContent = name;
      mainInput.placeholder = 'Message #' + name + '...';
    });
  });

  /* ================================================================
     3. CLOSE / TOGGLE PANELS
     ================================================================ */

  // Pinned panel close
  document.querySelector('.pinned-close').addEventListener('click', function() {
    pinnedPanel.classList.add('hidden');
  });

  // Search panel close
  document.querySelector('.search-panel-close').addEventListener('click', function() {
    searchPanel.classList.add('hidden');
  });

  // Thread panel close
  document.querySelector('.thread-close').addEventListener('click', function() {
    threadPanel.classList.add('hidden');
  });

  // Toast dismiss
  function dismissToast() {
    if (toast.classList.contains('hidden')) return;
    toast.classList.add('exiting');
    setTimeout(function() {
      toast.classList.add('hidden');
      toast.classList.remove('exiting');
    }, 300);
    clearTimeout(toastTimer);
  }
  document.querySelector('.toast-close').addEventListener('click', dismissToast);

  // Click outside: emoji picker, context menu, profile card
  document.addEventListener('click', function(e) {
    if (!emojiPicker.classList.contains('hidden') &&
        !emojiPicker.contains(e.target) &&
        !e.target.closest('.reaction-add') &&
        !e.target.closest('.msg-action-btn[title="React"]')) {
      emojiPicker.classList.add('hidden');
    }
    if (!contextMenu.classList.contains('hidden') && !contextMenu.contains(e.target)) {
      contextMenu.classList.add('hidden');
    }
    if (!profileCard.classList.contains('hidden') &&
        !profileCard.contains(e.target) &&
        !e.target.closest('.member')) {
      profileCard.classList.add('hidden');
    }
  });

  // Modal - Cancel, X, overlay click close it
  modalOverlay.addEventListener('click', function(e) {
    if (e.target === modalOverlay) modalOverlay.classList.add('hidden');
  });
  document.querySelector('.modal-close').addEventListener('click', function() {
    modalOverlay.classList.add('hidden');
  });
  document.querySelector('.modal-btn.secondary').addEventListener('click', function() {
    modalOverlay.classList.add('hidden');
  });

  // Toggle switch in modal
  document.querySelector('.toggle-switch').addEventListener('click', function() {
    this.classList.toggle('active');
  });

  /* ================================================================
     4. OPEN PANELS
     ================================================================ */

  // Header buttons: Search and Pinned messages
  document.querySelectorAll('.header-btn').forEach(function(btn) {
    var title = btn.getAttribute('title');
    if (title === 'Search') {
      btn.addEventListener('click', function(e) {
        e.stopPropagation();
        searchPanel.classList.toggle('hidden');
        if (!searchPanel.classList.contains('hidden')) {
          searchPanel.querySelector('.search-panel-input').focus();
        }
      });
    }
    if (title === 'Pinned messages') {
      btn.addEventListener('click', function(e) {
        e.stopPropagation();
        pinnedPanel.classList.toggle('hidden');
      });
    }
  });

  // Reply action on messages opens thread panel
  document.addEventListener('click', function(e) {
    var replyBtn = e.target.closest('.msg-action-btn[title="Reply"]');
    if (replyBtn) {
      e.stopPropagation();
      var msgRow = replyBtn.closest('.msg-row');
      if (msgRow) updateThreadParent(msgRow);
      threadPanel.classList.remove('hidden');
    }
  });

  function updateThreadParent(msgRow) {
    var senderName = msgRow.querySelector('.sender-name');
    var bubbleText = msgRow.querySelector('.bubble');
    var avatar = msgRow.querySelector('.avatar');
    var time = msgRow.querySelector('.msg-time');
    var parentName = threadPanel.querySelector('.thread-parent-name');
    var parentText = threadPanel.querySelector('.thread-parent-text');
    var parentAvatar = threadPanel.querySelector('.thread-parent-avatar');
    var parentTime = threadPanel.querySelector('.thread-parent-time');
    if (senderName && parentName) {
      parentName.textContent = senderName.textContent;
      parentName.style.color = senderName.style.color;
    }
    if (bubbleText && parentText) parentText.textContent = bubbleText.textContent.trim().substring(0, 200);
    if (avatar && parentAvatar) parentAvatar.style.background = avatar.style.background;
    if (time && parentTime) parentTime.textContent = time.textContent;
  }

  // New Conversation button opens modal
  document.querySelector('.create-channel').addEventListener('click', function() {
    modalOverlay.classList.remove('hidden');
    modalOverlay.querySelector('.modal-input').focus();
  });

  // Create Channel button in modal
  document.querySelector('.modal-btn.primary').addEventListener('click', function() {
    var nameInput = modalOverlay.querySelector('.modal-input');
    var channelName = nameInput.value.trim();
    if (channelName) {
      var channelList = document.querySelectorAll('.channel-list')[1];
      var newItem = buildChannelItem(channelName);
      channelList.appendChild(newItem);
      // Bind click handler
      newItem.addEventListener('click', function() {
        document.querySelectorAll('.channel-item').forEach(function(ch) {
          ch.classList.remove('active');
        });
        newItem.classList.add('active');
        chatHeaderName.textContent = channelName;
        mainInput.placeholder = 'Message #' + channelName + '...';
      });
      newItem.click();
    }
    modalOverlay.classList.add('hidden');
  });

  /* ================================================================
     5. MEMBER LIST - click shows profile popup
     ================================================================ */
  document.querySelectorAll('.member').forEach(function(member) {
    member.addEventListener('click', function(e) {
      e.stopPropagation();
      var name = this.querySelector('.member-name');
      var avatar = this.querySelector('.member-avatar');
      var badge = this.querySelector('.member-badge');

      var pcName = profileCard.querySelector('.profile-card-name');
      var pcHandle = profileCard.querySelector('.profile-card-handle');
      var pcAvatar = profileCard.querySelector('.profile-card-avatar');
      var pcRole = profileCard.querySelector('.profile-card-role');

      if (name && pcName) {
        pcName.textContent = name.textContent;
        pcName.style.color = name.style.color || 'var(--text-primary)';
      }
      if (name && pcHandle) pcHandle.textContent = '@' + name.textContent.toLowerCase().replace(/\s+/g, '-');
      if (avatar && pcAvatar) pcAvatar.style.background = avatar.style.background;
      if (badge && pcRole) pcRole.textContent = badge.textContent.trim();

      var rect = this.getBoundingClientRect();
      profileCard.style.position = 'fixed';
      profileCard.style.left = (rect.left - 250) + 'px';
      profileCard.style.top = Math.max(10, rect.top - 100) + 'px';
      profileCard.style.bottom = 'auto';
      profileCard.classList.remove('hidden');
    });
  });

  /* ================================================================
     6. EMOJI REACTIONS
     ================================================================ */
  var emojiPickerTarget = null;

  // Clicking existing reaction toggles count
  document.addEventListener('click', function(e) {
    var reaction = e.target.closest('.reaction:not(.reaction-add)');
    if (reaction) {
      e.stopPropagation();
      var countEl = reaction.querySelector('.count');
      if (countEl) {
        var c = parseInt(countEl.textContent) || 0;
        if (reaction.classList.contains('active')) {
          c = Math.max(0, c - 1);
          reaction.classList.remove('active');
        } else {
          c++;
          reaction.classList.add('active');
        }
        countEl.textContent = c;
      }
    }
  });

  // (+) button or React action btn shows emoji picker
  document.addEventListener('click', function(e) {
    var addBtn = e.target.closest('.reaction-add');
    var reactBtn = e.target.closest('.msg-action-btn[title="React"]');
    if (addBtn || reactBtn) {
      e.stopPropagation();
      var msgRow = (addBtn || reactBtn).closest('.msg-row');
      emojiPickerTarget = msgRow;

      var rect = (addBtn || reactBtn).getBoundingClientRect();
      emojiPicker.style.position = 'fixed';
      emojiPicker.style.left = Math.min(rect.left, window.innerWidth - 350) + 'px';
      emojiPicker.style.bottom = (window.innerHeight - rect.top + 8) + 'px';
      emojiPicker.style.top = 'auto';
      emojiPicker.style.transform = 'none';
      emojiPicker.classList.toggle('hidden');
    }
  });

  // Clicking emoji in picker adds reaction
  document.querySelectorAll('.emoji-item').forEach(function(item) {
    item.addEventListener('click', function(e) {
      e.stopPropagation();
      var emoji = this.textContent;
      if (emojiPickerTarget) {
        var reactions = emojiPickerTarget.querySelector('.reactions');
        if (!reactions) {
          reactions = createEl('div', 'reactions');
          var bubbleWrap = emojiPickerTarget.querySelector('.bubble-wrap');
          if (bubbleWrap) bubbleWrap.appendChild(reactions);
        }
        // Check existing
        var existing = null;
        reactions.querySelectorAll('.reaction:not(.reaction-add)').forEach(function(r) {
          var emojiSpan = r.querySelector('.emoji');
          if (emojiSpan && emojiSpan.textContent === emoji) existing = r;
        });
        if (existing) {
          var countEl = existing.querySelector('.count');
          countEl.textContent = parseInt(countEl.textContent) + 1;
          existing.classList.add('active');
        } else {
          var newReaction = createEl('div', 'reaction active');
          var emojiSpan = createEl('span', 'emoji');
          emojiSpan.textContent = emoji;
          newReaction.appendChild(emojiSpan);
          var countSpan = createEl('span', 'count', '1');
          newReaction.appendChild(countSpan);
          var addBtnEl = reactions.querySelector('.reaction-add');
          if (addBtnEl) {
            reactions.insertBefore(newReaction, addBtnEl);
          } else {
            reactions.appendChild(newReaction);
          }
        }
      }
      var previewIcon = emojiPicker.querySelector('.emoji-preview-icon');
      if (previewIcon) previewIcon.textContent = emoji;
      emojiPicker.classList.add('hidden');
    });
  });

  // Emoji picker category tabs
  document.querySelectorAll('.emoji-cat').forEach(function(cat) {
    cat.addEventListener('click', function() {
      document.querySelectorAll('.emoji-cat').forEach(function(c) { c.classList.remove('active'); });
      this.classList.add('active');
    });
  });

  // Emoji hover updates footer preview
  document.querySelectorAll('.emoji-item').forEach(function(item) {
    item.addEventListener('mouseenter', function() {
      var previewIcon = emojiPicker.querySelector('.emoji-preview-icon');
      var previewName = emojiPicker.querySelector('.emoji-preview-name');
      if (previewIcon) previewIcon.textContent = this.textContent;
      if (previewName) previewName.textContent = this.textContent;
    });
  });

  /* ================================================================
     7. CONTEXT MENU - right-click on message
     ================================================================ */
  document.addEventListener('contextmenu', function(e) {
    var msgRow = e.target.closest('.msg-row:not(.system)');
    if (msgRow) {
      e.preventDefault();
      contextMenu.style.left = e.clientX + 'px';
      contextMenu.style.top = e.clientY + 'px';
      contextMenu.classList.remove('hidden');
    }
  });

  contextMenu.querySelectorAll('.ctx-item').forEach(function(item) {
    item.addEventListener('click', function() {
      var actionSpan = this.querySelector('span:not(.ctx-kbd)');
      if (actionSpan && actionSpan.textContent === 'Reply') {
        threadPanel.classList.remove('hidden');
      }
      contextMenu.classList.add('hidden');
    });
  });

  /* ================================================================
     8. MESSAGE INPUT - send new messages
     ================================================================ */
  function sendMessage() {
    var text = mainInput.value.trim();
    if (!text) return;
    var msgRow = buildMsgRow(text);
    messagesEl.appendChild(msgRow);
    mainInput.value = '';
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  mainInput.addEventListener('keydown', function(e) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  });
  sendBtn.addEventListener('click', sendMessage);

  // Thread input send
  var threadInput = threadPanel.querySelector('.thread-input-wrap input');
  var threadSendBtn = threadPanel.querySelector('.thread-send');

  function sendThreadReply() {
    var text = threadInput.value.trim();
    if (!text) return;
    var reply = buildThreadReply(text);
    var replies = threadPanel.querySelector('.thread-replies');
    replies.appendChild(reply);
    threadInput.value = '';
    replies.scrollTop = replies.scrollHeight;
    var countEl = threadPanel.querySelector('.thread-reply-count');
    if (countEl) {
      var current = parseInt(countEl.textContent) || 0;
      countEl.textContent = (current + 1) + ' replies';
    }
  }

  threadInput.addEventListener('keydown', function(e) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendThreadReply();
    }
  });
  threadSendBtn.addEventListener('click', sendThreadReply);

  /* ================================================================
     9. SCROLL-TO-BOTTOM BUTTON
     ================================================================ */
  messagesEl.addEventListener('scroll', function() {
    var atBottom = messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight < 60;
    if (atBottom) {
      scrollBottomBtn.classList.add('hidden');
    } else {
      scrollBottomBtn.classList.remove('hidden');
    }
  });

  scrollBottomBtn.addEventListener('click', function(e) {
    e.stopPropagation();
    messagesEl.scrollTo({top: messagesEl.scrollHeight, behavior: 'smooth'});
  });

  // Initially scroll to bottom
  messagesEl.scrollTop = messagesEl.scrollHeight;

  /* ================================================================
     10. SIDEBAR SECTION COLLAPSE
     ================================================================ */
  document.querySelectorAll('.section-label').forEach(function(label) {
    var arrow = label.querySelector('.arrow');
    if (!arrow) return;
    label.style.cursor = 'pointer';
    label.addEventListener('click', function() {
      this.classList.toggle('collapsed');
      var next = this.nextElementSibling;
      while (next && !next.classList.contains('channel-list')) {
        next = next.nextElementSibling;
      }
      if (next) next.classList.toggle('collapsed');
    });
  });

  /* ================================================================
     11. COPY BUTTON ON CODE BLOCKS
     ================================================================ */
  document.addEventListener('click', function(e) {
    var copyBtn = e.target.closest('.code-copy-btn');
    if (copyBtn) {
      e.stopPropagation();
      var codeBlock = copyBtn.closest('.code-block-wrap').querySelector('.code-block');
      if (codeBlock) {
        var text = codeBlock.textContent;
        // Find the text node that contains "Copy"
        var textNodes = [];
        copyBtn.childNodes.forEach(function(n) {
          if (n.nodeType === Node.TEXT_NODE && n.textContent.trim()) textNodes.push(n);
        });
        var copyTextNode = textNodes.length ? textNodes[textNodes.length - 1] : null;
        var origContent = copyTextNode ? copyTextNode.textContent : '';

        navigator.clipboard.writeText(text).then(function() {
          copyBtn.classList.add('copied');
          if (copyTextNode) copyTextNode.textContent = ' Copied!';
          setTimeout(function() {
            copyBtn.classList.remove('copied');
            if (copyTextNode) copyTextNode.textContent = origContent;
          }, 2000);
        }).catch(function() {
          // Clipboard API may fail in some contexts
        });
      }
    }
  });

  /* ================================================================
     12. SEARCH FILTERS - toggle active state
     ================================================================ */
  document.querySelectorAll('.search-filter').forEach(function(filter) {
    filter.addEventListener('click', function() {
      document.querySelectorAll('.search-filter').forEach(function(f) { f.classList.remove('active'); });
      this.classList.add('active');
    });
  });

  /* ================================================================
     13. THREAD INDICATORS - click opens thread
     ================================================================ */
  document.addEventListener('click', function(e) {
    var indicator = e.target.closest('.thread-indicator');
    if (indicator) {
      var msgRow = indicator.closest('.msg-row');
      if (msgRow) updateThreadParent(msgRow);
      threadPanel.classList.remove('hidden');
    }
  });

  /* ================================================================
     14. KEYBOARD SHORTCUTS
     ================================================================ */
  document.addEventListener('keydown', function(e) {
    if (e.key === 'Escape') {
      if (!modalOverlay.classList.contains('hidden')) { modalOverlay.classList.add('hidden'); return; }
      if (!contextMenu.classList.contains('hidden')) { contextMenu.classList.add('hidden'); return; }
      if (!emojiPicker.classList.contains('hidden')) { emojiPicker.classList.add('hidden'); return; }
      if (!profileCard.classList.contains('hidden')) { profileCard.classList.add('hidden'); return; }
      if (!searchPanel.classList.contains('hidden')) { searchPanel.classList.add('hidden'); return; }
      if (!pinnedPanel.classList.contains('hidden')) { pinnedPanel.classList.add('hidden'); return; }
      if (!threadPanel.classList.contains('hidden')) { threadPanel.classList.add('hidden'); return; }
    }
    if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
      e.preventDefault();
      searchPanel.classList.remove('hidden');
      searchPanel.querySelector('.search-panel-input').focus();
    }
  });

})();
