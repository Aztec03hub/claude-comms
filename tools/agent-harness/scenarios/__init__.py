"""Scenario builders for the claude-comms agent harness."""

from __future__ import annotations

from cc_harness.agent import AgentSpec
from cc_harness.runner import RunConfig

DEPTH_ROUNDS = {"quick": 2, "standard": 4, "deep": 7}


def two_agent_conversation(rounds: int) -> RunConfig:
    """Two engineers coordinate over chat: broadcast, whisper, mention, read."""
    return RunConfig(
        scenario="two-agent-conversation",
        objective=(
            "You and your teammate must agree on the THREE most important bullet "
            "points for a product release-notes blurb, then have ONE of you post a "
            "final numbered list prefixed 'FINAL:'. Discuss first, divide the "
            "thinking, and use a whisper (recipients=[teammate]) at least once to "
            "compare notes privately before going public."
        ),
        agent_specs=[
            AgentSpec(
                name="alice",
                persona=(
                    "You are Alice, a pragmatic product engineer. You value brevity "
                    "and shipping. You collaborate actively and don't repeat others."
                ),
            ),
            AgentSpec(
                name="bob",
                persona=(
                    "You are Bob, a detail-oriented backend engineer. You push for "
                    "correctness and call out vague claims. You collaborate actively."
                ),
            ),
        ],
        rounds=rounds,
    )


def three_agent_selforg(rounds: int) -> RunConfig:
    """Three agents self-organize to co-author ONE shared artifact without a leader.

    Designed to stress self-organization, message latency, response times, the
    hook, and — critically — concurrent edits to the SAME artifact (clobber
    safety via base_version)."""
    return RunConfig(
        scenario="three-agent-selforg",
        objective=(
            "The three of you must co-author ONE shared artifact named exactly "
            "'api-spec' (type 'doc') describing a tiny REST API for a TODO app. "
            "There is NO leader: organize yourselves. First, briefly claim "
            "DIFFERENT sections so you don't duplicate work (suggested: 'endpoints', "
            "'data-model', 'errors'). One of you creates the 'api-spec' artifact; "
            "everyone else updates that SAME artifact to add their own section. "
            "ALWAYS pass base_version (the version you last saw) on every update so "
            "concurrent edits are detected rather than silently overwriting each "
            "other. Announce in chat when you've added your section."
        ),
        agent_specs=[
            AgentSpec(
                name="alice",
                persona="You are Alice, an API designer. Decisive, concise, collaborative.",
            ),
            AgentSpec(
                name="bob",
                persona="You are Bob, a data-modeling specialist. Precise and collaborative.",
            ),
            AgentSpec(
                name="carol",
                persona="You are Carol, who owns error handling and edge cases. Collaborative.",
            ),
        ],
        rounds=rounds,
    )


def three_agent_clobber(rounds: int) -> RunConfig:
    """Three agents edit the SAME artifact CONCURRENTLY to stress clobber safety.

    The run does a short sequential setup, then burst rounds where all three act
    at the same instant (separate MCP connections) so their artifact updates
    genuinely race. We then check whether optimistic concurrency (base_version)
    caught the conflicts and whether anyone's section was silently lost."""
    seq = max(1, rounds - 2)
    return RunConfig(
        scenario="three-agent-clobber",
        objective=(
            "The three of you share ONE artifact named exactly 'shared-plan' "
            "(type 'doc'). SETUP: exactly one of you (whoever goes first) creates "
            "'shared-plan' containing a title and three clearly labeled, initially "
            "empty sections: '## Alice', '## Bob', '## Carol'. After it exists, you "
            "will all edit it AT THE SAME TIME, each filling in ONLY your own "
            "section with 2-3 bullet points, WITHOUT deleting anyone else's "
            "section. CRITICAL: before every update, call comms_artifact_get to "
            "read the latest version, then comms_artifact_update with base_version "
            "set to exactly that version number. If an update is rejected for a "
            "version conflict, re-read the latest version and retry so no one's "
            "work is lost."
        ),
        agent_specs=[
            AgentSpec(
                name="alice",
                persona="You are Alice. Careful about not overwriting others' edits.",
            ),
            AgentSpec(
                name="bob",
                persona="You are Bob. Careful about not overwriting others' edits.",
            ),
            AgentSpec(
                name="carol",
                persona="You are Carol. Careful about not overwriting others' edits.",
            ),
        ],
        rounds=seq,
        burst_rounds=2,
    )


SCENARIOS = {
    "two": two_agent_conversation,
    "three": three_agent_selforg,
    "clobber": three_agent_clobber,
}
