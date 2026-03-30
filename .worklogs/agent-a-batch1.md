# Agent-A Batch 1 Work Log — Project Scaffolding + Config

**Date:** 2026-03-13
**Status:** Complete

## Files Created

1. `/home/plafayette/claude-comms/pyproject.toml` — Package configuration with hatchling build system, all dependencies, optional extras (tui, web, all, dev), entry point, and pytest config.
2. `/home/plafayette/claude-comms/src/claude_comms/__init__.py` — Package init with `__version__ = "0.1.0"`.
3. `/home/plafayette/claude-comms/src/claude_comms/__main__.py` — Entry point for `python -m claude_comms`, delegates to CLI app.
4. `/home/plafayette/claude-comms/src/claude_comms/config.py` — Config management with `load_config`, `save_config`, `get_config_path`, `get_default_config`, `generate_identity_key`. Implements YAML load/save, chmod 600, deep merge with defaults, and env var password resolution chain.
5. `/home/plafayette/claude-comms/src/claude_comms/cli.py` — Typer CLI with `app` and `conv_app` at module level. Implements `init` command with `--name`, `--type`, and `--force` options.
6. `/home/plafayette/claude-comms/tests/test_config.py` — 21 tests covering config path, identity key generation, save/load, file permissions, deep merge, password resolution chain, and default config structure.

## Issues Encountered

1. **Build backend typo:** Initially used `hatchling.backends` instead of `hatchling.build`. Fixed.
2. **Dependency conflict:** `amqtt` pins `typer==0.15.4` while `mcp[cli]` requires `typer>=0.16.0`. These two packages cannot coexist with their CLI extras resolved simultaneously. Worked around by installing without strict dep resolution. The pyproject.toml specifies `typer>=0.15.0` which is compatible with amqtt's pin. The mcp CLI extra may need to be dropped or mcp used without the cli extra in practice.

## Deviations from Plan

- **typer version:** Changed from `>=0.9.0` to `>=0.15.0` to be closer to what amqtt requires. The original `>=0.9.0` would have worked but the tighter bound better documents the actual minimum.
- **Added `hatchling` as build system** since the plan specified `[project.scripts]` but no build system. Hatchling is lightweight and works well with src layout.
- **Added `get_default_config()` function** not in the original spec but useful for the `init` command and tests.
- **Added `[tool.pytest.ini_options]`** to pyproject.toml for test discovery.
- **Added `dev` optional dependency group** with pytest and pytest-asyncio.

## Potential Concerns

1. **amqtt vs mcp typer conflict:** This is a real issue. If both amqtt and mcp try to use typer CLI features, they'll conflict. May need to pin mcp without the `[cli]` extra or wait for amqtt to relax its typer pin.
2. **WSL2 chmod:** The `_set_file_permissions` function has a fallback warning for platforms where chmod doesn't work as expected. This is relevant for WSL2 with Windows-mounted filesystems.
3. **Config file not gitignored:** The `~/.claude-comms/config.yaml` lives outside the repo, so this is fine, but worth noting it contains credentials.

## CLI Contract for Agent-F

- `app = typer.Typer()` at module level in `cli.py`
- `conv_app = typer.Typer()` added via `app.add_typer(conv_app, name="conv")`
- `init` command implemented on `app`
- Agent-F should add commands to `app` (for `start`, `stop`, `status`, `tui`, `web`, `log`) and `conv_app` (for conversation management)
- Config available via `from claude_comms.config import load_config, save_config, get_config_path`

## Test Results

All 21 tests pass.
