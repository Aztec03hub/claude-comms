"""Tests for claude_comms.config module."""

from __future__ import annotations

import os
import stat
from pathlib import Path
from unittest.mock import patch

import pytest
import yaml

from claude_comms.config import (
    generate_identity_key,
    get_config_path,
    get_default_config,
    load_config,
    save_config,
)


@pytest.fixture
def tmp_config_path(tmp_path: Path) -> Path:
    """Return a temporary config file path."""
    return tmp_path / "config.yaml"


@pytest.fixture
def sample_config() -> dict:
    """Return a sample config dict."""
    return get_default_config()


class TestGetConfigPath:
    def test_returns_path_in_home(self):
        path = get_config_path()
        assert path == Path.home() / ".claude-comms" / "config.yaml"

    def test_returns_path_object(self):
        assert isinstance(get_config_path(), Path)


class TestGenerateIdentityKey:
    def test_length(self):
        key = generate_identity_key()
        assert len(key) == 8

    def test_is_hex(self):
        key = generate_identity_key()
        int(key, 16)  # Should not raise

    def test_uniqueness(self):
        keys = {generate_identity_key() for _ in range(100)}
        assert len(keys) == 100


class TestSaveConfig:
    def test_creates_file(self, tmp_config_path: Path, sample_config: dict):
        save_config(sample_config, tmp_config_path)
        assert tmp_config_path.exists()

    def test_creates_parent_dirs(self, tmp_path: Path, sample_config: dict):
        deep_path = tmp_path / "a" / "b" / "config.yaml"
        save_config(sample_config, deep_path)
        assert deep_path.exists()

    def test_valid_yaml(self, tmp_config_path: Path, sample_config: dict):
        save_config(sample_config, tmp_config_path)
        with open(tmp_config_path) as f:
            loaded = yaml.safe_load(f)
        assert loaded["identity"]["key"] == sample_config["identity"]["key"]

    def test_file_permissions_600(self, tmp_config_path: Path, sample_config: dict):
        save_config(sample_config, tmp_config_path)
        mode = tmp_config_path.stat().st_mode
        # Check owner read/write, no group/other
        assert mode & stat.S_IRUSR  # owner read
        assert mode & stat.S_IWUSR  # owner write
        assert not (mode & stat.S_IRGRP)  # no group read
        assert not (mode & stat.S_IWGRP)  # no group write
        assert not (mode & stat.S_IROTH)  # no other read
        assert not (mode & stat.S_IWOTH)  # no other write

    def test_returns_path(self, tmp_config_path: Path, sample_config: dict):
        result = save_config(sample_config, tmp_config_path)
        assert result == tmp_config_path


class TestLoadConfig:
    def test_load_nonexistent_returns_defaults(self, tmp_path: Path):
        path = tmp_path / "nonexistent.yaml"
        with patch.dict(os.environ, {}, clear=False):
            os.environ.pop("CLAUDE_COMMS_PASSWORD", None)
            with pytest.warns(UserWarning, match="no password"):
                config = load_config(path)
        assert config["broker"]["port"] == 1883
        assert config["default_conversation"] == "general"

    def test_load_existing_config(self, tmp_config_path: Path, sample_config: dict):
        sample_config["identity"]["name"] = "test-user"
        sample_config["broker"]["auth"]["password"] = "secret123"
        save_config(sample_config, tmp_config_path)
        loaded = load_config(tmp_config_path)
        assert loaded["identity"]["name"] == "test-user"

    def test_merges_with_defaults(self, tmp_config_path: Path):
        """Partial config should be filled with defaults."""
        partial = {"identity": {"name": "partial-user"}}
        with open(tmp_config_path, "w") as f:
            yaml.dump(partial, f)
        with patch.dict(os.environ, {}, clear=False):
            os.environ.pop("CLAUDE_COMMS_PASSWORD", None)
            with pytest.warns(UserWarning, match="no password"):
                config = load_config(tmp_config_path)
        assert config["identity"]["name"] == "partial-user"
        assert config["broker"]["port"] == 1883
        assert config["mcp"]["port"] == 9920

    def test_deep_merge_preserves_nested(self, tmp_config_path: Path):
        """Changing a nested value shouldn't lose sibling keys."""
        partial = {"broker": {"auth": {"password": "mypass"}}}
        with open(tmp_config_path, "w") as f:
            yaml.dump(partial, f)
        config = load_config(tmp_config_path)
        assert config["broker"]["auth"]["password"] == "mypass"
        assert config["broker"]["auth"]["username"] == "comms-user"
        assert config["broker"]["port"] == 1883


class TestPasswordResolution:
    def test_env_var_takes_priority(self, tmp_config_path: Path, sample_config: dict):
        sample_config["broker"]["auth"]["password"] = "yaml-pass"
        save_config(sample_config, tmp_config_path)
        with patch.dict(os.environ, {"CLAUDE_COMMS_PASSWORD": "env-pass"}):
            config = load_config(tmp_config_path)
        assert config["broker"]["auth"]["password"] == "env-pass"

    def test_yaml_password_used_when_no_env(self, tmp_config_path: Path, sample_config: dict):
        sample_config["broker"]["auth"]["password"] = "yaml-pass"
        save_config(sample_config, tmp_config_path)
        with patch.dict(os.environ, {}, clear=False):
            os.environ.pop("CLAUDE_COMMS_PASSWORD", None)
            config = load_config(tmp_config_path)
        assert config["broker"]["auth"]["password"] == "yaml-pass"

    def test_warns_when_no_password_and_auth_enabled(self, tmp_config_path: Path, sample_config: dict):
        sample_config["broker"]["auth"]["password"] = ""
        sample_config["broker"]["auth"]["enabled"] = True
        save_config(sample_config, tmp_config_path)
        with patch.dict(os.environ, {}, clear=False):
            os.environ.pop("CLAUDE_COMMS_PASSWORD", None)
            with pytest.warns(UserWarning, match="no password"):
                load_config(tmp_config_path)

    def test_no_warn_when_auth_disabled(self, tmp_config_path: Path, sample_config: dict):
        sample_config["broker"]["auth"]["password"] = ""
        sample_config["broker"]["auth"]["enabled"] = False
        save_config(sample_config, tmp_config_path)
        with patch.dict(os.environ, {}, clear=False):
            os.environ.pop("CLAUDE_COMMS_PASSWORD", None)
            # Should not warn
            config = load_config(tmp_config_path)
        assert config["broker"]["auth"]["password"] == ""


class TestGetDefaultConfig:
    def test_has_identity_key(self):
        config = get_default_config()
        assert len(config["identity"]["key"]) == 8

    def test_each_call_unique_key(self):
        c1 = get_default_config()
        c2 = get_default_config()
        assert c1["identity"]["key"] != c2["identity"]["key"]

    def test_has_all_top_level_keys(self):
        config = get_default_config()
        expected_keys = {"identity", "broker", "mcp", "web", "notifications", "logging", "default_conversation"}
        assert expected_keys == set(config.keys())
