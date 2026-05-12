# Agent contract — test async fixes (issue #27)

## 1. Scope

Mechanical conversion of pre-existing test failures caused by 11 `tool_comms_*`
functions in `src/claude_comms/mcp_tools.py` being made `async` without the
test suite being updated. Every failing test was a "coroutine object is not
subscriptable / iterable / has no attribute 'get'" or "coroutine was never
awaited" symptom. Fix: at each call site to one of the inventory functions
add `await`, mark the containing test function `async def`, and decorate it
with `@pytest.mark.asyncio`. No `src/` changes. No new tests. No assertion
changes. No mock-behavior changes. No style/format changes.

## 2. Files modified

- `tests/test_mcp_tools.py` — 82 lines changed (43+ / 39-)
- `tests/test_mcp_server_extended.py` — 19 lines changed (11+ / 8-)
- `tests/test_integration.py` — 193 lines changed (109+ / 84-)
- `tests/test_gaps_mcp_tools.py` — 11 lines changed (6+ / 5-)
- `tests/test_gaps_expanded.py` — 20 lines changed (12+ / 8-)
- `tests/test_api_endpoints.py` — 39 lines changed (22+ / 17-)
- `tests/test_e2e.py` — 97 lines changed (54+ / 43-)

Per `git diff --stat`: 266 insertions, 195 deletions across 7 files. No `src/`
changes. No conftest.py changes (the `sample_participant` fixture uses
`registry.join(...)` directly — the sync low-level method — so it did not
need updating).

## 3. Async tools converted (by tool name, count, file)

Only `tool_comms_join` and `tool_comms_send` appeared at sync call sites in
the failing tests. The other 9 inventory tools (status_set, status_clear,
artifact_create, artifact_update, artifact_delete, conversation_create,
conversation_update, invite, react) are either already correctly awaited or
not exercised in these 7 files.

`tool_comms_join` await counts:

- `tests/test_mcp_tools.py`         — 16 call sites
- `tests/test_mcp_server_extended.py` — 5 call sites
- `tests/test_integration.py`       — 33 call sites
- `tests/test_gaps_mcp_tools.py`    — 1 call site (test_resolve_unknown_name_dropped) + 1 wrapped in `asyncio.run()` inside a thread (test_concurrent_joins)
- `tests/test_gaps_expanded.py`     — 5 call sites
- `tests/test_api_endpoints.py`     — 9 call sites
- `tests/test_e2e.py`               — 32 call sites

`tool_comms_send` await counts: already had `await` at every call site
(those tests were already `@pytest.mark.asyncio`). No new await sites added.

`registry.join(...)` (sync low-level method on `ParticipantRegistry`) was
not touched anywhere — it stays sync, as the brief specifies.

## 4. Fixture changes

One fixture-like helper converted:

- `tests/test_integration.py` — `TestAllCommsToolsWithMockPublish._setup()`
  was a plain `def` helper returning `(registry, store, key)` after calling
  `tool_comms_join`. Converted to `async def _setup(self)`. All 12 tests in
  that class that call `self._setup()` now `await self._setup()`. Of those
  12, 5 were already `@pytest.mark.asyncio` (the `_send_*` tests). The
  remaining 7 (`_read_empty`, `_read_with_messages`, `_read_with_since`,
  `_read_count_clamped`, `_check_no_unread`, `_check_with_unread`,
  `_check_specific_conversation`, `_history_all`, `_history_with_query`)
  were converted from sync `def` to `async def` with `@pytest.mark.asyncio`.

No `setup_method` / `teardown_method` patterns exist in any of the 7 files.
The `conftest.py` `sample_participant` fixture already uses the sync
`registry.join(...)` method directly (intentionally — see fixture
docstring), so it stayed sync and needed no change.

## 5. Pattern variants encountered

Three structural patterns observed across the 7 files:

1. **Per-test decorator, no class-level pytestmark** — the dominant pattern.
   Every async test has `@pytest.mark.asyncio` immediately above it. Used
   in all 7 files. No class-level or module-level `pytestmark` introduced
   (would have been inconsistent with the existing convention, which mixes
   sync and async tests freely within the same class — e.g.
   `TestErrorHandlingPaths`).
2. **Async helper called from async tests** — `TestAllCommsToolsWithMockPublish._setup()`.
   No `asyncio.run()` inside tests; the helper is awaited from inside
   already-async test bodies.
3. **`asyncio.run()` inside a worker thread** — single instance:
   `TestRegistryConcurrency.test_concurrent_joins` in
   `tests/test_gaps_mcp_tools.py`. Each worker thread spins its own event
   loop via `asyncio.run(tool_comms_join(...))`. This is the standard
   pattern for calling async from sync-threaded code; the alternative
   (`asyncio.gather` on N coroutines in a single loop) would have
   eliminated the threaded-concurrency property the test is verifying
   (concurrent lock contention on `ParticipantRegistry.join()`). The
   outer test stays sync.

`pytest_asyncio.fixture` was not needed anywhere — no fixtures yield async
or call async tools.

One import added: `import pytest` in `tests/test_gaps_expanded.py` —
previously absent because no test in that file needed pytest features
directly; the `@pytest.mark.asyncio` decorators introduced by this
conversion required it.

## 6. Unexpected findings (NOT fixed — surfaced per brief)

Five tests fail with non-coroutine errors after the await fix. These are
pre-existing test gaps that the coroutine-error masking was hiding. Per the
brief ("STOP and surface them in your contract"), I did NOT change the
assertions. They remain failing on `main` after this commit. Each is a
real test gap that should be triaged separately.

Four of the five cluster on the same root cause:

**Stale `client == "unknown"` assertions — 3 tests**

- `tests/test_mcp_server_extended.py::TestGetChannelParticipants::test_returns_participants_with_correct_shape`
- `tests/test_api_endpoints.py::TestGetChannelParticipants::test_returns_participants_with_client_field`
- `tests/test_api_endpoints.py::TestClientTypeInPresence::test_participant_response_includes_client_mcp`

All three call `tool_comms_join(...)` and then assert
`participant["client"] == "unknown"`. The current `tool_comms_join` async
implementation in `src/claude_comms/mcp_tools.py:454` and 504 calls
`_ensure_mcp_connection(p)`, which synthesizes an MCP connection on the
participant. `get_channel_participants` then derives `client` from the
synthesized connection's `client_type`, returning `"mcp"` instead of the
"no connections → fallback to unknown" string the tests expect. This
`_ensure_mcp_connection` call was introduced in commit `04a0501`
("feat: cumulative ship — mentions/whispers, threads, reactions, more")
alongside the async conversion. The three tests were never updated to
reflect the new behavior; they only stayed "green" because they were
failing with the coroutine error before pytest could ever evaluate the
assertion. Suggested fix is to update the assertions to expect `"mcp"`
(and adjust the related `status` / `connections` / `online` expectations),
but that is an intentional test-correctness fix, out of scope for this
commit.

**Stale Message JSON-schema assertion — 1 test**

- `tests/test_integration.py::TestMessageRoundtrip::test_roundtrip_preserves_json_structure`

Asserts `set(data.keys()) == {"id", "ts", "sender", "recipients", "body",
"reply_to", "conv"}` on the result of `Message.create(...).to_mqtt_payload()`.
The Message model has since gained 6 fields: `thread_root_id`,
`thread_reply_count`, `thread_participants`, `thread_last_author`,
`thread_last_ts`, and `mentions`. The test is unrelated to the async
conversion — it would have failed on `main` with or without the awaits.
Suggested fix is to broaden the expected set or switch to subset assertion.

**Targeted-to-self rejection — 1 test**

- `tests/test_e2e.py::TestMultiParticipantEdgeCases::test_targeted_to_self`

After awaiting `tool_comms_join` correctly, the test fails with `KeyError:
'status'` because `tool_comms_send(..., recipients=["alice"])` where the
sender is also alice now returns `{"error": True, "message": "None of
the specified recipients could be resolved..."}`. The recipient resolver
appears to drop the sender from the recipient list, leaving zero
resolvable recipients. This is a behavior change in the source code
(recipient resolution or self-recipient policy changed) that the
coroutine-masked test could not exercise. Suggested fix is to either
allow self-targeting and assert success, or update the test to assert the
new rejection behavior — but pick one intentionally rather than guessing.

## 7. Tests skipped or deleted

None. No test was deleted, skipped, xfail'd, or otherwise muted. All
remaining failures are visible in the pytest output exactly as the brief
intended.

## 8. Pytest delta

Before this commit: `93 failed, 1056 passed, 113 warnings in 21.81s`

After this commit: `5 failed, 1144 passed, 66 warnings in 21.78s`

Delta: -88 failures, +88 passes. The 5 remaining failures are documented
in section 6 above. None of them are coroutine-related.

The warning count dropped from 113 → 66 because most warnings were
`RuntimeWarning: coroutine 'tool_comms_*' was never awaited` from the
masked test failures, all now resolved.

## 9. Verification commands

```bash
cd /home/plafayette/claude-comms && .venv/bin/python -m pytest --tb=no -q 2>&1 | tail -5
```

Final output:

```
FAILED tests/test_api_endpoints.py::TestGetChannelParticipants::test_returns_participants_with_client_field
FAILED tests/test_api_endpoints.py::TestClientTypeInPresence::test_participant_response_includes_client_mcp
FAILED tests/test_e2e.py::TestMultiParticipantEdgeCases::test_targeted_to_self
FAILED tests/test_integration.py::TestMessageRoundtrip::test_roundtrip_preserves_json_structure
FAILED tests/test_mcp_server_extended.py::TestGetChannelParticipants::test_returns_participants_with_correct_shape
5 failed, 1144 passed, 66 warnings in 21.78s
```

Per-file verifications run between batches (all green except for the 5
real-test-gap exceptions documented in section 6):

```bash
.venv/bin/python -m pytest tests/test_mcp_tools.py --tb=line -q
# 42 passed in 0.06s

.venv/bin/python -m pytest tests/test_mcp_server_extended.py --tb=line -q
# 1 failed, 19 passed (test_returns_participants_with_correct_shape — section 6)

.venv/bin/python -m pytest tests/test_integration.py --tb=line -q
# 1 failed, 142 passed (test_roundtrip_preserves_json_structure — section 6)

.venv/bin/python -m pytest tests/test_gaps_mcp_tools.py --tb=line -q
# 16 passed in 0.03s

.venv/bin/python -m pytest tests/test_gaps_expanded.py --tb=line -q
# 36 passed in 0.05s

.venv/bin/python -m pytest tests/test_api_endpoints.py --tb=line -q
# 2 failed, 23 passed (test_returns_participants_with_client_field +
#                      test_participant_response_includes_client_mcp — section 6)

.venv/bin/python -m pytest tests/test_e2e.py --tb=line -q
# 1 failed, 48 passed (test_targeted_to_self — section 6)
```

## 10. Audit — 3 sample diffs

### Sample 1: `tests/test_mcp_tools.py` — sync test to async test

Before:
```python
def test_first_join_returns_key(self, registry: ParticipantRegistry):
    result = tool_comms_join(registry, name="alice", conversation="general")
    assert result["status"] == "joined"
    assert len(result["key"]) == 8
```

After:
```python
@pytest.mark.asyncio
async def test_first_join_returns_key(self, registry: ParticipantRegistry):
    result = await tool_comms_join(registry, name="alice", conversation="general")
    assert result["status"] == "joined"
    assert len(result["key"]) == 8
```

### Sample 2: `tests/test_integration.py` — sync helper to async helper

Before:
```python
class TestAllCommsToolsWithMockPublish:
    def _setup(self):
        registry = ParticipantRegistry()
        store = MessageStore()
        r = tool_comms_join(registry, name="tester", conversation="general")
        return registry, store, r["key"]

    @pytest.mark.asyncio
    async def test_comms_send_broadcast(self) -> None:
        registry, store, key = self._setup()
        ...
```

After:
```python
class TestAllCommsToolsWithMockPublish:
    async def _setup(self):
        registry = ParticipantRegistry()
        store = MessageStore()
        r = await tool_comms_join(registry, name="tester", conversation="general")
        return registry, store, r["key"]

    @pytest.mark.asyncio
    async def test_comms_send_broadcast(self) -> None:
        registry, store, key = await self._setup()
        ...
```

### Sample 3: `tests/test_gaps_mcp_tools.py` — threaded concurrency with asyncio.run per thread

Before:
```python
def test_concurrent_joins(self, registry: ParticipantRegistry):
    results = {}
    errors = []

    def join_thread(name, conv):
        try:
            r = tool_comms_join(registry, name=name, conversation=conv)
            results[name] = r
        except Exception as e:
            errors.append(e)
    ...
```

After:
```python
def test_concurrent_joins(self, registry: ParticipantRegistry):
    import asyncio

    results = {}
    errors = []

    def join_thread(name, conv):
        try:
            r = asyncio.run(
                tool_comms_join(registry, name=name, conversation=conv)
            )
            results[name] = r
        except Exception as e:
            errors.append(e)
    ...
```

The outer test stays sync; each worker thread spins its own event loop.
Threaded concurrency is preserved so the test still exercises the
`ParticipantRegistry` internal lock under contention. This is the one
place the brief's "avoid spawning event loops inside tests" guidance had
to bend, because pytest-asyncio's single-loop model cannot host threaded
contention.

## 11. Rollback

Single revert undoes the entire change:

```bash
git revert <commit-sha>
```

No `src/` was touched, no fixtures in `conftest.py` were touched, no new
files were created (other than this contract under `.worklogs/`). Revert
is safe and complete.

## 12. Follow-ups (intentionally not actioned)

1. **Update the 3 stale `client == "unknown"` assertions** to expect `"mcp"`,
   `"online"`, populated `connections`, `online: True`. These are
   `test_returns_participants_with_correct_shape`,
   `test_returns_participants_with_client_field`,
   `test_participant_response_includes_client_mcp`. The async wrapper
   `tool_comms_join` now synthesizes an MCP connection via
   `_ensure_mcp_connection`; the tests pre-date that behavior. Triage:
   confirm the new behavior is intentional, then update assertions
   verbatim with the new expected payload. Roughly 12-15 lines total.

2. **Broaden `test_roundtrip_preserves_json_structure`** in
   `tests/test_integration.py` to either use a subset assertion or to
   list the full current Message schema (id, ts, sender, recipients,
   body, reply_to, conv, thread_root_id, thread_reply_count,
   thread_participants, thread_last_author, thread_last_ts, mentions).
   Roughly 6-10 lines.

3. **Resolve `test_targeted_to_self`** in `tests/test_e2e.py`. Decide
   whether recipient resolution should include the sender (the resolver
   currently drops it, leaving an empty resolved set which triggers the
   "None of the specified recipients could be resolved" error). Either
   change the resolver to allow self-targeting (and add a regression
   test for the round-trip), or change the test to assert the
   self-rejection behavior. Both are valid product decisions; do not
   guess.

4. **The 3 `client == "unknown"` failures live in three different files.**
   When fixing them, also audit the rest of `test_api_endpoints.py`
   (`test_client_field_is_string`, `test_presence_payload_client_field`,
   `test_system_topic_includes_client_suffix`) to confirm they match the
   intended new behavior — `test_client_field_is_string` happens to
   already pass because it only checks `isinstance(client, str)`, but
   that's fragile and may be load-bearing once the other tests are
   corrected.

5. **Module-level `pytestmark = pytest.mark.asyncio`** could simplify
   `tests/test_mcp_tools.py::TestCommsJoin` and a few other classes
   where every test ended up async, but the brief explicitly cautions
   against introducing module-level pytestmark for files that mix sync
   and async tests — and all 7 files in this conversion now have mixed
   sync/async classes. Per-test decorator stays the convention.
