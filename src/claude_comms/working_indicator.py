"""Ergonomic helpers for the `working` activity indicator.

These wrappers turn a pair of ``status_set`` / ``status_clear`` callables into
an async context manager and a decorator so that opt-in costs nothing in
caller code.

Why this exists: the Phase B+C plan called for ``@comms.working("label")`` and
``async with comms.working("label")`` so a Claude client can mark itself as
``working`` while a tool call is in flight without writing try/finally
boilerplate every time.  Since claude-comms doesn't ship its own Python
client SDK (agents use the MCP protocol directly), this module is a thin
adaptor: the caller injects whatever async ``status_set(label, ttl=...)``
and ``status_clear()`` callables match their environment.

Examples
--------
Async context manager::

    async with working(set_status, clear_status, "running tests"):
        await run_pytest()

Decorator::

    @working_decorator(set_status, clear_status, "summarising")
    async def summarise(text: str) -> str:
        ...

Both surfaces guarantee ``status_clear`` is called even if the wrapped
operation raises.  Failures inside ``status_set`` / ``status_clear`` are
swallowed by default (configurable via ``swallow_errors=False``) so that a
broker hiccup never bubbles up and breaks the underlying work.
"""

from __future__ import annotations

import functools
import logging
from contextlib import asynccontextmanager
from collections.abc import Awaitable, Callable
from typing import Any, ParamSpec, TypeVar


logger = logging.getLogger(__name__)


# Caller-provided callables.
SetStatus = Callable[..., Awaitable[Any]]
ClearStatus = Callable[..., Awaitable[Any]]


P = ParamSpec("P")
R = TypeVar("R")


@asynccontextmanager
async def working(
    set_status: SetStatus,
    clear_status: ClearStatus,
    label: str,
    *,
    ttl_seconds: int = 30,
    swallow_errors: bool = True,
):
    """Async context manager that emits a ``working`` activity for the body.

    Calls ``set_status(label, ttl_seconds=...)`` on enter and
    ``clear_status()`` on exit.  The underlying call is whatever the caller
    plugs in (typically the MCP ``comms_status_set`` / ``comms_status_clear``
    tool wrapped to be call-by-name).

    The clear is run in a try/finally so that an exception in the wrapped
    block does NOT leave a stale activity stuck on the connection.
    """
    set_failed = False
    try:
        try:
            await set_status(label, ttl_seconds=ttl_seconds)
        except Exception:
            set_failed = True
            if not swallow_errors:
                raise
            logger.exception("working() set_status failed for label %r", label)
        yield
    finally:
        # Even if set_status failed we still attempt clear: the server's
        # idempotent clear is a no-op when nothing is set, and a successful
        # clear here protects against partial-set states.
        try:
            await clear_status()
        except Exception:
            if not swallow_errors and not set_failed:
                raise
            logger.exception("working() clear_status failed for label %r", label)


def working_decorator(
    set_status: SetStatus,
    clear_status: ClearStatus,
    label: str,
    *,
    ttl_seconds: int = 30,
    swallow_errors: bool = True,
) -> Callable[[Callable[P, Awaitable[R]]], Callable[P, Awaitable[R]]]:
    """Decorator form of :func:`working`.

    Wrap an async callable with ``@working_decorator(set_status, clear_status,
    "running tests")`` and the activity will be set for the duration of every
    call and cleared on completion (success or exception).

    Returns the wrapped coroutine function with `functools.wraps` applied so
    ``__name__`` / ``__doc__`` survive intact.
    """

    def _decorate(fn: Callable[P, Awaitable[R]]) -> Callable[P, Awaitable[R]]:
        @functools.wraps(fn)
        async def _wrapped(*args: P.args, **kwargs: P.kwargs) -> R:
            async with working(
                set_status,
                clear_status,
                label,
                ttl_seconds=ttl_seconds,
                swallow_errors=swallow_errors,
            ):
                return await fn(*args, **kwargs)

        return _wrapped

    return _decorate
