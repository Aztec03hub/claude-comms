"""@mention parsing and routing logic.

The ``[@name1, @name2]`` prefix at the start of a message body is for
**human readability** only.  The authoritative routing data lives in the
``recipients`` field of the Message model (which contains participant keys,
not names).  The ``comms_send`` MCP tool resolves names to keys before
publishing.

This module provides utilities for:
- Extracting mentioned names from a message body
- Building the ``[@name, ...]`` prefix string
- Stripping the prefix to get the "bare" body
"""

from __future__ import annotations

import re


# Matches [@name1, @name2, ...] at the very start of the body
MENTION_PATTERN = re.compile(
    r"^\[(@[\w-]+(?:\s*,\s*@[\w-]+)*)\]\s*",
)

# Extracts individual names (without the @) from a mention block
NAME_PATTERN = re.compile(r"@([\w-]+)")


def extract_mentions(body: str) -> list[str]:
    """Return the list of mentioned display names from the body prefix.

    Only considers the ``[@name, ...]`` block at the **start** of the
    message.  Names are returned without the leading ``@``, in the order
    they appear.

    >>> extract_mentions("[@alice, @bob] Hello!")
    ['alice', 'bob']
    >>> extract_mentions("No mentions here @alice")
    []
    """
    match = MENTION_PATTERN.match(body)
    if not match:
        return []
    return NAME_PATTERN.findall(match.group(1))


def strip_mentions(body: str) -> str:
    """Remove the ``[@name, ...]`` prefix, returning the bare message text.

    >>> strip_mentions("[@alice, @bob] Hello!")
    'Hello!'
    >>> strip_mentions("No prefix")
    'No prefix'
    """
    return MENTION_PATTERN.sub("", body)


def build_mention_prefix(names: list[str]) -> str:
    """Build a ``[@name1, @name2]`` prefix string from display names.

    Returns an empty string when *names* is empty.

    >>> build_mention_prefix(["alice", "bob"])
    '[@alice, @bob] '
    >>> build_mention_prefix([])
    ''
    """
    if not names:
        return ""
    at_names = ", ".join(f"@{n}" for n in names)
    return f"[{at_names}] "


def resolve_mentions(
    body: str,
    name_to_key: dict[str, str],
) -> list[str]:
    """Extract mentions from *body* and resolve them to participant keys.

    Names not found in *name_to_key* are silently skipped (they may be
    typos or participants who have left).  Returns a list of unique keys
    in mention order, or an empty list if there are no mentions.

    >>> resolve_mentions("[@alice, @bob] Hi", {"alice": "a1b2c3d4", "bob": "e5f6a7b8"})
    ['a1b2c3d4', 'e5f6a7b8']
    """
    names = extract_mentions(body)
    seen: set[str] = set()
    keys: list[str] = []
    for name in names:
        key = name_to_key.get(name)
        if key and key not in seen:
            seen.add(key)
            keys.append(key)
    return keys
