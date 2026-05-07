#!/usr/bin/env python3
"""seed-live-reactions.py — publish a fixed list of reaction events on
``claude-comms/conv/general/reactions`` so a connected web client paints
reaction chips on the seeded message bubbles.

Reactions are intentionally NOT retained on MQTT in production
(see ``mcp_tools.tool_comms_react``), so the historical reactions.jsonl is
not auto-broadcast on daemon startup. This helper bridges that gap for the
gallery screenshots: invoked AFTER the Playwright spec has loaded the page
and the web client is subscribed to ``claude-comms/conv/+/reactions``, it
fires synthetic events so the bubbles render with a populated reactions bar.

Topic + wire format mirrors ``ReactionEvent`` from ``claude_comms.reactions``::

    topic   = claude-comms/conv/general/reactions
    payload = {
        "message_id": "...",
        "emoji":      "🚀",
        "actor_key":  "<8-hex>",
        "ts":         "<ISO-8601>",
        "op":         "add" | "remove",
    }

Usage::

    python3 web/e2e/seed-live-reactions.py
"""

from __future__ import annotations

import json
import sys
import time
import uuid
from datetime import datetime, timedelta, timezone

import paho.mqtt.client as mqtt

REACTION_TARGET_ID = "22222222-2222-4222-8222-222222222222"

EMBER_KEY = "7cfc4984"
PHOENIX_KEY = "2821263e"
SAGE_KEY = "ba8f4e0c"
ALEX_KEY = "8db84cae"
PHIL_KEY = "a1aece1b"


def _ts(offset: int) -> str:
    base = datetime(2026, 5, 7, 14, 0, 0, tzinfo=timezone(timedelta(hours=-5)))
    return (base + timedelta(seconds=offset)).isoformat()


REACTIONS = [
    (REACTION_TARGET_ID, "🚀", EMBER_KEY, 80),
    (REACTION_TARGET_ID, "🚀", PHOENIX_KEY, 82),
    (REACTION_TARGET_ID, "👍", SAGE_KEY, 85),
    (REACTION_TARGET_ID, "👍", PHIL_KEY, 86),
    (REACTION_TARGET_ID, "🔥", ALEX_KEY, 88),
    (REACTION_TARGET_ID, "✅", SAGE_KEY, 90),
]


def main() -> None:
    client = mqtt.Client(
        callback_api_version=mqtt.CallbackAPIVersion.VERSION2,
        client_id=f"gallery-seed-{uuid.uuid4().hex[:8]}",
    )
    # Anonymous auth — broker.auth.password is empty in the dev config.
    client.username_pw_set("comms-user", "")
    try:
        client.connect("127.0.0.1", 1883, keepalive=15)
    except Exception as exc:
        print(f"[seed-reactions] could not connect to broker: {exc}", file=sys.stderr)
        sys.exit(1)
    client.loop_start()
    try:
        published = 0
        for message_id, emoji, actor_key, offset in REACTIONS:
            payload = {
                "message_id": message_id,
                "emoji": emoji,
                "actor_key": actor_key,
                "ts": _ts(offset),
                "op": "add",
            }
            info = client.publish(
                "claude-comms/conv/general/reactions",
                json.dumps(payload, ensure_ascii=False).encode("utf-8"),
                qos=1,
                retain=False,
            )
            info.wait_for_publish(timeout=2.0)
            published += 1
            time.sleep(0.05)
        print(f"[seed-reactions] published {published} reaction events.")
    finally:
        client.loop_stop()
        client.disconnect()


if __name__ == "__main__":
    main()
