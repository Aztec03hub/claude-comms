"""Regression test for R1-2: version counter correctness after pruning.

The previous implementation computed ``current_version = len(artifact.versions)``
which breaks after ``MAX_VERSIONS`` pruning: ``len`` stays 50 forever, so every
new update would reuse version 51 and the ``base_version`` concurrency check
would report the wrong "current" version number to clients.

This test creates 55 updates and asserts:
1. Each update's returned version number advances monotonically 1..55 (skipping
   v1 which is the initial create).
2. The final artifact's latest version is v55, even though ``len(versions)``
   is capped at MAX_VERSIONS == 50.
3. ``base_version=55`` passes the concurrency check for a 56th update.
4. ``base_version=50`` (the old buggy "current") is now rejected as stale.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from claude_comms.artifact import MAX_VERSIONS, load_artifact
from claude_comms.mcp_tools import (
    ParticipantRegistry,
    tool_comms_artifact_create,
    tool_comms_artifact_update,
    tool_comms_join,
)

from conftest import PublishSpy


@pytest.mark.asyncio
async def test_version_counter_after_pruning(tmp_path: Path) -> None:
    """After 55 updates, version 56 should be correctly assigned and
    base_version checks must reflect the true latest version (not len)."""
    registry = ParticipantRegistry()
    spy = PublishSpy()

    join = await tool_comms_join(registry, name="alice", conversation="general")
    assert "error" not in join
    key = join["key"]

    # Create v1
    create_result = await tool_comms_artifact_create(
        registry,
        spy,
        key=key,
        conversation="general",
        name="churn",
        title="Churn",
        type="doc",
        content="v1",
        data_dir=tmp_path,
    )
    assert create_result["status"] == "created"
    assert create_result["version"] == 1

    # Apply 54 more updates -> final version should be 55
    for expected in range(2, 56):
        result = await tool_comms_artifact_update(
            registry,
            spy,
            key=key,
            conversation="general",
            name="churn",
            content=f"v{expected}",
            data_dir=tmp_path,
        )
        assert result.get("status") == "updated", result
        assert result["version"] == expected, (
            f"Expected v{expected} but got v{result['version']} "
            f"— this is the R1-2 bug (version counter used len(versions))."
        )

    # Load artifact from disk and assert the list is pruned but the max
    # version number is correct.
    artifact = load_artifact("general", "churn", tmp_path)
    assert artifact is not None
    assert len(artifact.versions) == MAX_VERSIONS, (
        f"versions list should be capped at {MAX_VERSIONS} after pruning; "
        f"got {len(artifact.versions)}."
    )
    assert max(v.version for v in artifact.versions) == 55
    # The oldest kept version should be 55 - 50 + 1 == 6
    assert min(v.version for v in artifact.versions) == 55 - MAX_VERSIONS + 1

    # base_version check: v55 should succeed (correct current), v50 (the old
    # buggy "current == len") should fail as stale.
    ok = await tool_comms_artifact_update(
        registry,
        spy,
        key=key,
        conversation="general",
        name="churn",
        content="v56",
        base_version=55,
        data_dir=tmp_path,
    )
    assert ok.get("status") == "updated", ok
    assert ok["version"] == 56

    stale = await tool_comms_artifact_update(
        registry,
        spy,
        key=key,
        conversation="general",
        name="churn",
        content="v??",
        base_version=50,  # old "current" if we still used len()
        data_dir=tmp_path,
    )
    assert stale.get("error") is True
    assert "conflict" in stale["message"].lower() or "version" in stale["message"].lower()


@pytest.mark.asyncio
async def test_base_version_matches_max_after_many_updates(tmp_path: Path) -> None:
    """After many updates, passing the last returned version as base_version
    must be accepted as the concurrency-check "current"."""
    registry = ParticipantRegistry()
    spy = PublishSpy()

    join = await tool_comms_join(registry, name="bob", conversation="general")
    key = join["key"]

    await tool_comms_artifact_create(
        registry,
        spy,
        key=key,
        conversation="general",
        name="counter",
        title="Counter",
        type="doc",
        content="v1",
        data_dir=tmp_path,
    )

    last_version = 1
    for _ in range(60):
        res = await tool_comms_artifact_update(
            registry,
            spy,
            key=key,
            conversation="general",
            name="counter",
            content=f"v{last_version + 1}",
            base_version=last_version,
            data_dir=tmp_path,
        )
        assert res.get("status") == "updated", res
        last_version = res["version"]

    # 60 updates + 1 create => v61
    assert last_version == 61

    artifact = load_artifact("general", "counter", tmp_path)
    assert artifact is not None
    assert max(v.version for v in artifact.versions) == 61
