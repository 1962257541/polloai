import hmac
import json
import os
import secrets
import time
from pathlib import Path
from typing import Any, Optional

from loguru import logger

from app.core.config import settings


PLUGIN_CONFIG_VERSION = 1


def plugin_config_path() -> Path:
    return Path(os.getenv("DOUBAO_COOKIE_PLUGIN_CONFIG_PATH") or settings.DOUBAO_COOKIE_PLUGIN_CONFIG_PATH)


def generate_connection_token() -> str:
    return f"dcp_{secrets.token_urlsafe(32)}"


def load_plugin_config() -> dict[str, Any]:
    path = plugin_config_path()
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        payload = {}
    except (json.JSONDecodeError, OSError) as exc:
        logger.warning(f"Unable to read Doubao cookie plugin config: {exc}")
        payload = {}
    if not isinstance(payload, dict):
        payload = {}
    return {
        "version": int(payload.get("version") or PLUGIN_CONFIG_VERSION),
        "connection_token": str(payload.get("connection_token") or ""),
        "enabled": bool(payload.get("enabled", True)),
        "created_at": payload.get("created_at"),
        "updated_at": payload.get("updated_at"),
    }


def save_plugin_config(config: dict[str, Any]) -> dict[str, Any]:
    path = plugin_config_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    now = time.time()
    payload = {
        "version": PLUGIN_CONFIG_VERSION,
        "connection_token": str(config.get("connection_token") or ""),
        "enabled": bool(config.get("enabled", True)),
        "created_at": config.get("created_at") or now,
        "updated_at": now,
    }
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    return payload


def ensure_plugin_config() -> dict[str, Any]:
    config = load_plugin_config()
    if not config.get("connection_token"):
        config["connection_token"] = generate_connection_token()
        config = save_plugin_config(config)
    return config


def rotate_connection_token(*, enabled: Optional[bool] = None) -> dict[str, Any]:
    config = load_plugin_config()
    config["connection_token"] = generate_connection_token()
    if enabled is not None:
        config["enabled"] = bool(enabled)
    return save_plugin_config(config)


def update_plugin_config(*, connection_token: Optional[str] = None, enabled: Optional[bool] = None) -> dict[str, Any]:
    config = ensure_plugin_config()
    if connection_token is not None:
        token = str(connection_token or "").strip()
        if token:
            config["connection_token"] = token
    if enabled is not None:
        config["enabled"] = bool(enabled)
    return save_plugin_config(config)


def verify_connection_token(provided_token: str) -> bool:
    config = load_plugin_config()
    expected = str(config.get("connection_token") or "")
    if not config.get("enabled", True) or not expected or not provided_token:
        return False
    return hmac.compare_digest(expected, str(provided_token))


def plugin_token_fingerprint(token: str) -> str:
    if not token:
        return ""
    return token[:8] + "..." + token[-6:]
