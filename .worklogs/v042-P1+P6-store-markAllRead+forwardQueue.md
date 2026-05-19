# Worklog — v0.4.2 Wave 0 Polish P1 + P6 (store)

**Agent:** Agent-P-Store (Polish Wave Batch 1)
**Worktree:** `/home/plafayette/claude-comms/.claude/worktrees/agent-a58a8a2d21d03f04e`
**Branch:** `worktree-agent-a58a8a2d21d03f04e`
**Base:** `a4dba0c` (v0.4.1 hotfix on main)
**Started:** 2026-05-18
**Status:** complete — ready for orchestrator integration

---

## 1. Goal

Land two store-only polish items bundled because they share `web/src/lib/mqtt-store.svelte.js`:

- **P1 — `markAllRead(channelId)`**: add a real implementation behind the Sidebar context menu's "Mark all as read" action (currently a TODO short-circuit at `Sidebar.svelte:77`).
- **P6 — `forwardMessage` pendingSends extension**: mirror the v0.3.3 G-62 disconnected-send-queue logic onto the forward path so disconnected forwards don't silently drop.

Both follow-ups were surfaced during v0.4.0 implementation (P1 in Step 2.12, P6 in Step 1.3 worklog §7) and were deferred to this polish wave per the v0.4.2 Wave 0 plan.

## 2. Scope

Writeable files (all three landed):

| File | Action |
|---|---|
| `web/src/lib/mqtt-store.svelte.js` | Modified — added `markAllRead`, extended `forwardMessage` |
| `web/tests/mqtt-store-mark-read.spec.js` | Created — 8 tests |
| `web/tests/mqtt-store-forward-queue.spec.js` | Created — 6 tests |

Read-only context: `web/src/lib/api.js`, `web/src/components/Sidebar.svelte`, `web/src/components/ChannelContextMenu.svelte`, existing `sendMessage` + `#pendingSends` + `#publishOutgoing` + `#drainPendingSends` + `#updateLocalMessageStatus` chain in the store.

Out of scope (per the brief): Sidebar wire-up of `markAllRead` (that lives in Batch 2 / Agent-P-Wire).

## 3. Implementation summary

### P1 — `markAllRead(channelId)`

Inserted at line 2272 immediately after `setStar` (matches the brief's "near channel-lifecycle methods" placement). Method behavior:

1. **Defensive guard** — no-op when `channelId` is missing, empty, non-string, or unknown. Matches the `setStar` / `setMute` defensive style.
2. **Local read-cursor advance** — zeros `ch.unread`, clears `ch.unreadHasMention`, drops `ch.unreadFrom` (the legacy v0.3.x first-unread message id pointer), and stamps `ch.lastReadAt = new Date().toISOString()`. The sidebar reads these four fields directly via $derived projections, so the row updates instantly.
3. **Persistence** — calls `this.#saveUnreadMarkers()` so a page refresh doesn't resurrect the cleared markers from localStorage.
4. **Best-effort server ack** — fires `mcpCall('comms_check', { key, conversation })` and swallows errors (the local state is already correct; the daemon will reconcile on next visibility-regain regardless).

Design choices worth noting:

- **`lastReadAt` is a new field** not previously set on channels. The Polish wave brief explicitly calls for it ("Update lastReadAt cursor so future incoming messages compare against the right baseline"). It lands as `undefined` for channels that have never been marked read; consumers must handle that case. The v0.4.2 unread-divider work (Phase 3) will be the first reader.
- The brief's exact text for the comms_check call uses `.catch()` directly on the `mcpCall` return. I extracted the call into a `result` local + checked for `.catch` existence + wrapped the whole thing in a `try/catch` because the v0.4.0 `mcpCall` signature wraps its errors in resolved `{ success: false, error }` envelopes rather than rejections — so the bare `.catch` is defensive against future signature changes. The semantics are identical.
- I added `ch.unreadFrom = null` even though it wasn't in the brief, because leaving the legacy v0.3.x first-unread pointer stale would cause the next-message unread divider to re-anchor to a deleted/cleared id — a subtle UX bug. Consistent with `selectChannel`'s existing "clear unread for old active" logic at line 1532.

### P6 — `forwardMessage` pendingSends extension

The pre-change `forwardMessage` (line 1730) called `this.#client.publish(...)` directly — no status field, no queue, no failure handling. Disconnected forwards local-echoed but never published.

After the change:

1. **Status field** — every forwarded message bubble starts as `status: 'sending'` (matches `sendMessage`'s G-62 contract). MessageBubble will render the same sending/sent/failed affordance on forwards that it already does on direct sends.
2. **Publish path** — when connected, calls `this.#publishOutgoing(msg.id, topic, payload)` instead of the raw `client.publish`. This funnels success → `'sent'` and error → `'failed'` through the existing `#updateLocalMessageStatus` helper.
3. **Queue path** — when disconnected, calls `this.#queuePendingSend(msg.id, topic, payload)`. The existing `#pendingSends` queue + cap-100 drop-oldest semantics apply unchanged.
4. **Drain** — no change needed. The existing `#drainPendingSends` iterates queue entries and calls `#publishOutgoing(item.messageId, item.topic, item.payload)` — topic-agnostic. Each queue entry already carries its own `(messageId, topic, payload)` snapshot, so a forward entry to `target-channel/messages` drains correctly alongside a direct send to `direct-channel/messages`. The brief's "extend the drain logic to dispatch by message type" turned out to be unnecessary — confirmed by the new `drain dispatches mixed sendMessage + forwardMessage entries by topic` test.

**Removed:** the unused `const prevChannel = this.activeChannel;` local at the top of the old `forwardMessage` (dead since whenever — it was never referenced).

## 4. Tests

### `web/tests/mqtt-store-mark-read.spec.js` (8 tests — exceeds the ≥5 requirement)

1. `clears the unread counter on the target channel`
2. `clears the unreadHasMention flag on the target channel`
3. `updates lastReadAt to a recent ISO timestamp` — asserts ISO-8601 format + bounded by before/after timestamps
4. `is a no-op when channelId is unknown`
5. `is a no-op when channelId is missing or empty` — tests undefined, empty string, null, undefined
6. `fires a comms_check ack via mcpCall with the user key + channel id`
7. `clears the legacy unreadFrom pointer so the unread divider re-anchors`
8. `swallows mcpCall rejections so the local state stays correct`

Test infrastructure: hoisted `vi.mock('../src/lib/api.js')` swaps `mcpCall` for a `vi.fn()` so the daemon doesn't need to be running. Pattern mirrors the existing `mqtt-store-channels.spec.js`.

### `web/tests/mqtt-store-forward-queue.spec.js` (6 tests — exceeds the ≥5 requirement)

1. `queues forwards while disconnected (does not publish, does not drop)`
2. `drains queued forwards in FIFO order on reconnect` — three forwards across two target channels; asserts FIFO + correct topics + status flips
3. `drops oldest forward when the queue cap (100) is exceeded; oldest is marked failed`
4. `publishes immediately + marks the bubble sent when already connected`
5. `publish-callback error during drain marks the forward as failed (retryable)` — also verifies `retryMessage` works on a failed forward
6. `drain dispatches mixed sendMessage + forwardMessage entries by topic` — locks the topic-agnostic drain contract

Test infrastructure: reuses the `makeFakeClient()` stub pattern + the `_installTestClient` / `_drainPendingSendsForTest` / `_pendingSendsLengthForTest` seams from the existing `mqtt-store-pending-sends.spec.js`.

## 5. Verification gate

All commands run inside the worktree (`/home/plafayette/claude-comms/.claude/worktrees/agent-a58a8a2d21d03f04e`) unless otherwise noted.

| Gate | Result | Delta |
|---|---|---|
| `.venv/bin/ruff check src/ tests/` (parent venv) | `All checks passed!` | clean |
| `.venv/bin/python -m pytest --tb=no -q` (parent venv) | `1268 passed` | unchanged from baseline |
| `cd web && CI=true pnpm exec vitest run` | `Test Files 44 passed (44) / Tests 759 passed (759)` | **745 → 759 (+14)** |
| `cd web && CI=true pnpm build` | `✓ built in 5.76s`, dist/ written | green |
| Svelte autofixer (on the changed methods, fed via mcp__plugin_svelte_svelte__svelte-autofixer) | `issues: []` | **0 issues** |
| `git status --short` | 1 modified + 2 untracked (expected scope) | clean |

Autofixer notes: 2 `suggestions` (not issues) flagged `new Date().toISOString()` calls in the changed methods and recommended `SvelteDate`. **Not applied** — `SvelteDate` is the reactive-tracked variant for mutable Date instances; we're calling `.toISOString()` immediately to produce a plain string, no reactivity is observing the Date object. The surrounding 24+ existing `new Date()` call sites in the same file all use this pattern. Applying the suggestion would be both inconsistent with the file's convention and semantically pointless. `issues: []` is the binding signal; the brief gate ("0 issues") is met.

Test-count math:
- markAllRead spec: 8 tests
- forward-queue spec: 6 tests
- Total new: 14 (brief required ≥10)
- Pre-change baseline: 745
- Post-change observed: 759
- Delta: +14 ✓

## 6. Risks & follow-ups

**P1 follow-up for Batch 2 (Agent-P-Wire):**
The Sidebar handler at `web/src/components/Sidebar.svelte:77` still reads:
```js
if (actionId === 'mark-read') return; // v0.4.1 follow-up — no store method yet.
```
Agent-P-Wire owns the wire-up flip to `if (actionId === 'mark-read') return void store.markAllRead(c.id);`. Out of scope here per the brief.

**P6 follow-up surfaced (deferred):**
The forwarded message's local-echo currently lacks the per-channel unread bump that direct sends get (this is consistent with pre-P6 behavior; not a regression). A future polish item could review whether forwards to a non-active channel should bump unread for the forwarder themselves. Not user-visible regression; flagging only.

**No L-blast risks**: both changes are S-blast (one file, one commit revert, isolated tests). No registry schema, no protocol, no security surface.

## 7. Standing-rules compliance

| Rule | Compliance |
|---|---|
| #1 no push | confirmed — no `git push` issued |
| #2 no tag | confirmed — no tag |
| #3 no CHANGELOG edit | confirmed — CHANGELOG.md untouched |
| #4 one commit + Co-Authored-By trailer | pending — see §8 below |
| #5 verify own work | confirmed — §5 above |
| #6 Edit-failure retry | n/a — no failures hit |
| #7 svelte autofixer 0 issues | confirmed — `issues: []` |
| #8 never skim brief | confirmed — read plan + §I.6 in full |
| #9 read before every same-file Edit | confirmed — Read between the two Edits on mqtt-store.svelte.js |
| #10 no em dashes in user-facing copy | confirmed — no user-facing copy added; comments only |
| #11 explicit `git add <paths>` | pending — see §8 below |
| #12 no destructive git ops | confirmed |

## 8. Commit plan

One commit per §I.13 conventions:

```
feat(store): markAllRead + forwardMessage pendingSends queue (Polish P1+P6)

P1: implement the markAllRead(channelId) method behind the Sidebar
context menu's "Mark all as read" stub. Local-clears unread + mention
dot + legacy unreadFrom pointer, stamps lastReadAt, persists via the
existing unread-markers cache, and fires a best-effort comms_check
ack through mcpCall. Sidebar wire-up follows in Batch 2.

P6: extend the v0.3.3 G-62 pending-sends queue + per-message status
contract onto forwardMessage. Disconnected forwards now queue +
drain on reconnect instead of silently never publishing. The drain
helper stayed topic-agnostic — each queue entry already carries its
own (messageId, topic, payload) snapshot.

vitest: 745 → 759 (+14: 8 markAllRead + 6 forward-queue). pytest
1268 unchanged. ruff clean. build green. Svelte autofixer 0 issues.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
```

Files to add (explicit paths per rule #11):
- `web/src/lib/mqtt-store.svelte.js`
- `web/tests/mqtt-store-mark-read.spec.js`
- `web/tests/mqtt-store-forward-queue.spec.js`

## 9. Blockers / asks

None. Ready for orchestrator integration onto main alongside the other three Batch 1 worktrees.

## 10. Return values for orchestrator

- **Worktree path:** `/home/plafayette/claude-comms/.claude/worktrees/agent-a58a8a2d21d03f04e`
- **Branch:** `worktree-agent-a58a8a2d21d03f04e`
- **Base commit:** `a4dba0c`
- **Commit SHA (after §8 lands):** see chat after commit
- **Touched files:** 1 modified + 2 created (all in scope)
- **Test delta:** vitest 745 → 759 (+14)
- **Baselines:** pytest 1268 / ruff clean / build green / autofixer 0 issues
