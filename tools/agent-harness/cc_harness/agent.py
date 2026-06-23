"""A real Sonnet agent that participates in claude-comms over the live stack.

The agent runs an Anthropic tool-use loop whose tools are the daemon's comms_*
tools, routed through its own MCP client. After every tool batch it fires the
real PostToolUse hook (so the harness measures the product's actual mid-turn
delivery path). Every step is recorded to ``events`` for full observability of
the participant's inputs and outputs.
"""

from __future__ import annotations

import json
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from anthropic import AsyncAnthropic

from .hooks import install_hook_script, run_hook
from .mcp_link import McpLink

DEFAULT_MODEL = "claude-sonnet-4-6"
MAX_TOOL_ITERS = 6
MAX_TOKENS = 3072

# Tools agents may call. join/leave/kick/conversation-admin are excluded; the
# harness joins agents and owns the conversation lifecycle.
DEFAULT_TOOLS = [
    "comms_send",
    "comms_read",
    "comms_check",
    "comms_members",
    "comms_history",
    "comms_artifact_create",
    "comms_artifact_update",
    "comms_artifact_get",
    "comms_artifact_list",
    "comms_react",
    "comms_status_set",
]


@dataclass
class AgentSpec:
    name: str
    persona: str
    model: str = DEFAULT_MODEL


@dataclass
class Agent:
    spec: AgentSpec
    link: McpLink
    home: Path
    client: AsyncAnthropic
    key: str = ""
    events: list[dict] = field(default_factory=list)
    _messages: list[dict] = field(default_factory=list)
    _tool_schemas: list[dict] = field(default_factory=list)
    _needs_key: set[str] = field(default_factory=set)
    _hook_path: Path | None = None
    tokens_in: int = 0
    tokens_out: int = 0

    @property
    def name(self) -> str:
        return self.spec.name

    def _log(self, kind: str, **data: Any) -> None:
        self.events.append({"t": time.time(), "agent": self.name, "kind": kind, **data})

    async def setup(self, allowlist: list[str] | None = None) -> None:
        allow = set(allowlist or DEFAULT_TOOLS)
        tools = await self.link.list_tools()
        for t in tools:
            if t.name not in allow:
                continue
            schema = json.loads(json.dumps(t.input_schema))  # deep copy
            props = schema.get("properties", {})
            if "key" in props:
                self._needs_key.add(t.name)
                props.pop("key", None)
                if "required" in schema:
                    schema["required"] = [r for r in schema["required"] if r != "key"]
            self._tool_schemas.append(
                {"name": t.name, "description": t.description, "input_schema": schema}
            )

    async def join(self, conversation: str = "general") -> dict:
        res, err = await self.link.call_tool(
            "comms_join", {"name": self.name, "conversation": conversation}
        )
        if err or not isinstance(res, dict) or "key" not in res:
            raise RuntimeError(f"{self.name} join failed: {res}")
        self.key = res["key"]
        self._hook_path = install_hook_script(self.key, self.home)
        self._log("join", conversation=conversation, key=self.key, result=res)
        return res

    def _system(self) -> str:
        return self.spec.persona

    async def act(self, user_text: str) -> str:
        """Feed the agent an incoming-context turn and run its tool-use loop.

        Returns the agent's final assistant text for this turn.
        """
        self._log("turn_input", text=user_text)
        self._messages.append({"role": "user", "content": user_text})
        final_text = ""

        for _ in range(MAX_TOOL_ITERS):
            t0 = time.perf_counter()
            try:
                resp = await self.client.messages.create(
                    model=self.spec.model,
                    max_tokens=MAX_TOKENS,
                    system=self._system(),
                    messages=self._messages,
                    tools=self._tool_schemas,
                )
            except Exception as exc:  # noqa: BLE001 - one bad turn must not kill the run
                self._log("llm_error", error=str(exc))
                break
            dt = time.perf_counter() - t0
            self.tokens_in += resp.usage.input_tokens
            self.tokens_out += resp.usage.output_tokens

            assistant_content = [self._block_to_dict(b) for b in resp.content]
            self._messages.append({"role": "assistant", "content": assistant_content})

            text_out = " ".join(
                b.text for b in resp.content if b.type == "text"
            ).strip()
            if text_out:
                final_text = text_out
            self._log(
                "llm_response",
                latency_s=round(dt, 3),
                stop_reason=resp.stop_reason,
                text=text_out,
                tokens_in=resp.usage.input_tokens,
                tokens_out=resp.usage.output_tokens,
            )

            # Answer EVERY tool_use with a tool_result regardless of stop_reason
            # (e.g. max_tokens mid-tool-use) — a dangling tool_use is a 400 on the
            # next call. Break only when the model emitted no tool calls.
            tool_uses = [b for b in resp.content if b.type == "tool_use"]
            if not tool_uses:
                break

            tool_results = []
            for tu in tool_uses:
                args = dict(tu.input or {})
                if tu.name in self._needs_key:
                    args["key"] = self.key
                ct0 = time.perf_counter()
                result, is_err = await self.link.call_tool(tu.name, args)
                cdt = time.perf_counter() - ct0
                self._log(
                    "tool_call",
                    tool=tu.name,
                    args={k: v for k, v in args.items() if k != "key"},
                    latency_s=round(cdt, 3),
                    is_error=is_err,
                    result=result,
                )
                tool_results.append(
                    {
                        "type": "tool_result",
                        "tool_use_id": tu.id,
                        "content": json.dumps(result)[:6000],
                        "is_error": is_err,
                    }
                )

            # PostToolUse hook — the product's real mid-turn delivery mechanism.
            if self._hook_path is not None:
                hook = run_hook(self._hook_path, self.home)
                self._log(
                    "hook_run", delivered=hook["delivered"], context=hook["context"]
                )
                if hook["delivered"] and hook["context"]:
                    tool_results.append({"type": "text", "text": hook["context"]})

            self._messages.append({"role": "user", "content": tool_results})

        self._log("turn_output", text=final_text)
        return final_text

    @staticmethod
    def _block_to_dict(block: Any) -> dict:
        if block.type == "text":
            return {"type": "text", "text": block.text}
        if block.type == "tool_use":
            return {
                "type": "tool_use",
                "id": block.id,
                "name": block.name,
                "input": block.input,
            }
        return {"type": block.type}
