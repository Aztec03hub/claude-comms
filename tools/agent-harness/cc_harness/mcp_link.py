"""Thin async wrapper over an MCP Streamable-HTTP client session.

Each harness agent owns its own ``McpLink`` (its own client connection to the
daemon's ``/mcp`` endpoint), so the run exercises real per-client MCP transport
exactly the way a separate Claude process would.

The MCP client (``streamable_http_client`` + ``ClientSession``) is built on
anyio task groups whose cancel scopes must be entered and exited in the *same*
task. Driving enter/exit from separate ``await`` calls (e.g. via AsyncExitStack)
raises "Attempted to exit a cancel scope that isn't the current task's". So we
own both context managers inside one long-lived ``_run`` task and serve tool
calls to it over a request queue.
"""

from __future__ import annotations

import asyncio
import json
from dataclasses import dataclass
from typing import Any

from mcp import ClientSession
from mcp.client.streamable_http import streamable_http_client


@dataclass
class ToolDef:
    name: str
    description: str
    input_schema: dict


def _parse_tool_result(result: Any) -> Any:
    """Coerce an MCP CallToolResult into plain Python (the comms tools all
    return JSON-able dicts). Prefer structured content; fall back to the text
    block, which FastMCP fills with the JSON-serialized return value."""
    structured = getattr(result, "structuredContent", None)
    if structured is not None:
        if isinstance(structured, dict) and set(structured.keys()) == {"result"}:
            return structured["result"]
        return structured
    content = getattr(result, "content", None) or []
    for block in content:
        text = getattr(block, "text", None)
        if text is not None:
            try:
                return json.loads(text)
            except (json.JSONDecodeError, TypeError):
                return text
    return None


class McpLink:
    def __init__(self, url: str):
        self.url = url
        self._req_q: asyncio.Queue = asyncio.Queue()
        self._task: asyncio.Task | None = None
        self._ready = asyncio.Event()
        self._start_error: BaseException | None = None

    async def connect(self) -> None:
        self._task = asyncio.create_task(self._run())
        await self._ready.wait()
        if self._start_error is not None:
            raise self._start_error

    async def _run(self) -> None:
        try:
            async with streamable_http_client(self.url) as (read, write, *_):
                async with ClientSession(read, write) as session:
                    await session.initialize()
                    self._ready.set()
                    while True:
                        item = await self._req_q.get()
                        if item is None:
                            break
                        op, payload, fut = item
                        try:
                            if op == "list":
                                fut.set_result(await session.list_tools())
                            else:
                                name, arguments = payload
                                fut.set_result(await session.call_tool(name, arguments))
                        except Exception as exc:  # noqa: BLE001 - relay to caller
                            if not fut.done():
                                fut.set_exception(exc)
        except BaseException as exc:  # noqa: BLE001 - surface startup failure
            self._start_error = exc
            self._ready.set()

    async def _request(self, op: str, payload: Any) -> Any:
        fut: asyncio.Future = asyncio.get_running_loop().create_future()
        await self._req_q.put((op, payload, fut))
        return await fut

    async def list_tools(self) -> list[ToolDef]:
        resp = await self._request("list", None)
        return [
            ToolDef(
                name=t.name,
                description=t.description or "",
                input_schema=t.inputSchema or {},
            )
            for t in resp.tools
        ]

    async def call_tool(self, name: str, arguments: dict) -> tuple[Any, bool]:
        """Return (parsed_result, is_error)."""
        result = await self._request("call", (name, arguments))
        return _parse_tool_result(result), bool(getattr(result, "isError", False))

    async def aclose(self) -> None:
        if self._task is None:
            return
        await self._req_q.put(None)
        try:
            await asyncio.wait_for(self._task, timeout=10)
        except asyncio.TimeoutError:
            self._task.cancel()
        self._task = None
