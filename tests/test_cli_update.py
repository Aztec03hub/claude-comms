"""Tests for the ``claude-comms update`` one-shot self-update command.

Covers the pure helpers with mocked subprocess/filesystem (no real daemon, git,
pnpm, or pip required):

- ``_find_source_repo_root`` — git-checkout vs non-git (wheel) install.
- ``_should_reinstall`` — the version-changed / pyproject-changed decision.
- ``_select_web_package_manager`` — pnpm preferred, npm fallback (ci vs install),
  neither present.
- The non-git guard short-circuit (exit 1, ``pip install -U`` message).
- That the full ``_run_update`` sequence puts stop/start LAST (after the web
  build + reinstall steps).
"""

from __future__ import annotations

import subprocess
from pathlib import Path

import pytest
import typer

import claude_comms.cli as cli


# ---------------------------------------------------------------------------
# _find_source_repo_root
# ---------------------------------------------------------------------------


class TestFindSourceRepoRoot:
    def test_git_checkout_returns_root(self, tmp_path: Path) -> None:
        repo = tmp_path / "claude-comms"
        (repo / ".git").mkdir(parents=True)
        _ = (repo / "pyproject.toml").write_text('[project]\nversion = "1.0.0"\n')
        pkg_file = repo / "src" / "claude_comms" / "__init__.py"
        pkg_file.parent.mkdir(parents=True)
        _ = pkg_file.write_text("")

        assert cli._find_source_repo_root(start=pkg_file.resolve()) == repo

    def test_git_can_be_a_file_worktree(self, tmp_path: Path) -> None:
        # A linked worktree has a ``.git`` *file*, not a directory.
        repo = tmp_path / "wt"
        repo.mkdir()
        _ = (repo / ".git").write_text("gitdir: /somewhere/.git/worktrees/wt\n")
        _ = (repo / "pyproject.toml").write_text('[project]\nversion = "1.0.0"\n')
        pkg_file = repo / "src" / "claude_comms" / "__init__.py"
        pkg_file.parent.mkdir(parents=True)
        _ = pkg_file.write_text("")

        assert cli._find_source_repo_root(start=pkg_file.resolve()) == repo

    def test_wheel_install_returns_none(self, tmp_path: Path) -> None:
        # site-packages layout: pyproject is absent and there is no .git ancestor.
        site = tmp_path / "site-packages" / "claude_comms" / "__init__.py"
        site.parent.mkdir(parents=True)
        _ = site.write_text("")

        assert cli._find_source_repo_root(start=site.resolve()) is None

    def test_pyproject_without_git_returns_none(self, tmp_path: Path) -> None:
        repo = tmp_path / "no-git"
        repo.mkdir()
        _ = (repo / "pyproject.toml").write_text('[project]\nversion = "1.0.0"\n')
        pkg_file = repo / "src" / "claude_comms" / "__init__.py"
        pkg_file.parent.mkdir(parents=True)
        _ = pkg_file.write_text("")

        assert cli._find_source_repo_root(start=pkg_file.resolve()) is None


# ---------------------------------------------------------------------------
# _pyproject_project_version
# ---------------------------------------------------------------------------


class TestPyprojectVersion:
    def test_reads_project_version(self, tmp_path: Path) -> None:
        _ = (tmp_path / "pyproject.toml").write_text(
            "[build-system]\nrequires = []\n\n"
            '[project]\nname = "claude-comms"\nversion = "0.5.0"\n'
        )
        assert cli._pyproject_project_version(tmp_path) == "0.5.0"

    def test_ignores_version_outside_project_table(self, tmp_path: Path) -> None:
        _ = (tmp_path / "pyproject.toml").write_text(
            '[tool.other]\nversion = "9.9.9"\n\n[project]\nversion = "1.2.3"\n'
        )
        assert cli._pyproject_project_version(tmp_path) == "1.2.3"

    def test_missing_file_returns_none(self, tmp_path: Path) -> None:
        assert cli._pyproject_project_version(tmp_path) is None


# ---------------------------------------------------------------------------
# _should_reinstall  (the version-changed decision)
# ---------------------------------------------------------------------------


class TestShouldReinstall:
    def test_pyproject_changed_forces_reinstall(self) -> None:
        assert cli._should_reinstall("0.5.0", "0.5.0", pyproject_changed=True)

    def test_version_bumped_reinstalls(self) -> None:
        assert cli._should_reinstall("0.4.0", "0.5.0", pyproject_changed=False)

    def test_same_version_no_pyproject_change_skips(self) -> None:
        assert not cli._should_reinstall("0.5.0", "0.5.0", pyproject_changed=False)

    def test_unknown_installed_version_reinstalls(self) -> None:
        assert cli._should_reinstall(None, "0.5.0", pyproject_changed=False)

    def test_unknown_source_version_reinstalls(self) -> None:
        assert cli._should_reinstall("0.5.0", None, pyproject_changed=False)


# ---------------------------------------------------------------------------
# _select_web_package_manager  (pnpm vs npm selection)
# ---------------------------------------------------------------------------


class TestSelectWebPackageManager:
    def test_prefers_pnpm(self, tmp_path: Path) -> None:
        def which(name: str) -> str | None:
            return "/usr/bin/pnpm" if name == "pnpm" else "/usr/bin/npm"

        result = cli._select_web_package_manager(tmp_path, which=which)
        assert result is not None
        name, install_cmd, build_cmd = result
        assert name == "pnpm"
        assert install_cmd == ["pnpm", "install", "--frozen-lockfile"]
        assert build_cmd == ["pnpm", "build"]

    def test_npm_ci_when_lockfile_present(self, tmp_path: Path) -> None:
        _ = (tmp_path / "package-lock.json").write_text("{}")

        def which(name: str) -> str | None:
            return "/usr/bin/npm" if name == "npm" else None

        result = cli._select_web_package_manager(tmp_path, which=which)
        assert result is not None
        name, install_cmd, build_cmd = result
        assert name == "npm"
        assert install_cmd == ["npm", "ci"]
        assert build_cmd == ["npm", "run", "build"]

    def test_npm_install_when_no_lockfile(self, tmp_path: Path) -> None:
        def which(name: str) -> str | None:
            return "/usr/bin/npm" if name == "npm" else None

        result = cli._select_web_package_manager(tmp_path, which=which)
        assert result is not None
        _, install_cmd, _ = result
        assert install_cmd == ["npm", "install"]

    def test_none_when_no_manager(self, tmp_path: Path) -> None:
        assert (
            cli._select_web_package_manager(tmp_path, which=lambda _name: None) is None
        )


# ---------------------------------------------------------------------------
# Non-git guard short-circuit
# ---------------------------------------------------------------------------


def test_run_update_refuses_non_git_install(monkeypatch, capsys) -> None:
    monkeypatch.setattr(cli, "_find_source_repo_root", lambda: None)

    with pytest.raises(typer.Exit) as excinfo:
        cli._run_update()

    assert excinfo.value.exit_code == 1
    out = capsys.readouterr().out
    assert "pip install -U claude-comms" in out


# ---------------------------------------------------------------------------
# Full sequence: stop/start come LAST
# ---------------------------------------------------------------------------


def test_run_update_orders_stop_start_last(monkeypatch, tmp_path: Path) -> None:
    """End-to-end ordering with everything mocked: the build + reinstall steps
    must all run BEFORE the daemon is stopped and restarted."""
    repo = tmp_path / "repo"
    repo.mkdir()
    calls: list[str] = []

    monkeypatch.setattr(cli, "_find_source_repo_root", lambda: repo)
    monkeypatch.setattr(cli, "_installed_package_version", lambda: "0.4.0")
    monkeypatch.setattr(cli, "_pyproject_project_version", lambda _root: "0.5.0")
    monkeypatch.setattr(cli, "_git_rev", lambda _root: "abc123")
    monkeypatch.setattr(cli, "_git_changed_files", lambda _r, _o, _n: [])
    monkeypatch.setattr(
        cli,
        "_select_web_package_manager",
        lambda _web_dir: ("pnpm", ["pnpm", "install"], ["pnpm", "build"]),
    )

    def fake_step(cmd, *, cwd=None, env=None):  # type: ignore[no-untyped-def]
        calls.append(" ".join(cmd))
        return subprocess.CompletedProcess(args=cmd, returncode=0, stdout="", stderr="")

    monkeypatch.setattr(cli, "_run_subprocess_step", fake_step)
    monkeypatch.setattr(cli, "stop", lambda: calls.append("STOP"))
    monkeypatch.setattr(
        cli,
        "start",
        lambda background, web: calls.append(f"START bg={background} web={web}"),
    )
    monkeypatch.setattr(cli, "_is_daemon_running", lambda: True)
    monkeypatch.setattr(cli, "_read_pid", lambda: 4321)

    cli._run_update(web=True)

    stop_idx = calls.index("STOP")
    start_idx = next(i for i, c in enumerate(calls) if c.startswith("START"))

    # Build + reinstall steps recorded by fake_step must precede stop.
    assert any("git pull" in c for c in calls[:stop_idx])
    assert any("pnpm build" in c for c in calls[:stop_idx])
    assert any("pip install -e" in c for c in calls[:stop_idx])
    # stop and start are the final two operations, in that order.
    assert stop_idx < start_idx
    assert start_idx == len(calls) - 1
    assert calls[start_idx] == "START bg=True web=True"


def test_run_update_skips_reinstall_when_unchanged(monkeypatch, tmp_path: Path) -> None:
    repo = tmp_path / "repo"
    repo.mkdir()
    calls: list[str] = []

    monkeypatch.setattr(cli, "_find_source_repo_root", lambda: repo)
    monkeypatch.setattr(cli, "_installed_package_version", lambda: "0.5.0")
    monkeypatch.setattr(cli, "_pyproject_project_version", lambda _root: "0.5.0")
    monkeypatch.setattr(cli, "_git_rev", lambda _root: "abc123")
    monkeypatch.setattr(cli, "_git_changed_files", lambda _r, _o, _n: [])
    monkeypatch.setattr(
        cli,
        "_select_web_package_manager",
        lambda _web_dir: ("pnpm", ["pnpm", "install"], ["pnpm", "build"]),
    )

    def fake_step(cmd, *, cwd=None, env=None):  # type: ignore[no-untyped-def]
        calls.append(" ".join(cmd))
        return subprocess.CompletedProcess(args=cmd, returncode=0, stdout="", stderr="")

    monkeypatch.setattr(cli, "_run_subprocess_step", fake_step)
    monkeypatch.setattr(cli, "stop", lambda: calls.append("STOP"))
    monkeypatch.setattr(cli, "start", lambda background, web: calls.append("START"))
    monkeypatch.setattr(cli, "_is_daemon_running", lambda: True)
    monkeypatch.setattr(cli, "_read_pid", lambda: 4321)

    cli._run_update(web=True)

    # No pip reinstall step when version + pyproject are unchanged.
    assert not any("pip install -e" in c for c in calls)


def test_run_update_aborts_on_web_build_failure_before_stop(
    monkeypatch, tmp_path: Path
) -> None:
    """A failing web build must abort BEFORE the daemon is stopped."""
    repo = tmp_path / "repo"
    repo.mkdir()
    calls: list[str] = []

    monkeypatch.setattr(cli, "_find_source_repo_root", lambda: repo)
    monkeypatch.setattr(cli, "_installed_package_version", lambda: "0.4.0")
    monkeypatch.setattr(cli, "_pyproject_project_version", lambda _root: "0.5.0")
    monkeypatch.setattr(cli, "_git_rev", lambda _root: "abc123")
    monkeypatch.setattr(cli, "_git_changed_files", lambda _r, _o, _n: [])
    monkeypatch.setattr(
        cli,
        "_select_web_package_manager",
        lambda _web_dir: ("pnpm", ["pnpm", "install"], ["pnpm", "build"]),
    )

    def fake_step(cmd, *, cwd=None, env=None):  # type: ignore[no-untyped-def]
        calls.append(" ".join(cmd))
        if cmd == ["pnpm", "build"]:
            raise cli._UpdateStepError(cmd, 1, "", "vite build error")
        return subprocess.CompletedProcess(args=cmd, returncode=0, stdout="", stderr="")

    monkeypatch.setattr(cli, "_run_subprocess_step", fake_step)
    monkeypatch.setattr(cli, "stop", lambda: calls.append("STOP"))
    monkeypatch.setattr(cli, "start", lambda background, web: calls.append("START"))

    with pytest.raises(typer.Exit) as excinfo:
        cli._run_update(web=True)

    assert excinfo.value.exit_code == 1
    # Daemon was never touched.
    assert "STOP" not in calls
    assert "START" not in calls
