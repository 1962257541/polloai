from __future__ import annotations

import json
import time
import uuid
from pathlib import Path
from typing import Any, Mapping
from urllib.parse import parse_qs, urlencode, urlparse

from app.core.config import settings


SENSITIVE_HEADER_NAMES = {
    "authorization",
    "cookie",
    "x-csrf-token",
    "x-secsdk-csrf-token",
    "x-ms-token",
}
SENSITIVE_QUERY_KEYS = {"a_bogus", "x-bogus", "mstoken", "msToken"}


def context_template_dir() -> Path:
    return Path(settings.DOUBAO_CONTEXT_TEMPLATE_DIR)


def latest_context_template_path(account_index: int) -> Path:
    return context_template_dir() / f"account-{int(account_index)}-latest.json"


def archived_context_template_path(account_index: int, profile_id: str) -> Path:
    safe_profile = "".join(ch if ch.isalnum() or ch in "-_" else "-" for ch in str(profile_id))[:80]
    return context_template_dir() / (
        f"account-{int(account_index)}-{safe_profile}-{time.strftime('%Y%m%d-%H%M%S')}-{uuid.uuid4().hex[:8]}.json"
    )


def redact_url(url: str) -> str:
    try:
        parsed = urlparse(url)
        query = parse_qs(parsed.query, keep_blank_values=True)
        redacted: dict[str, list[str]] = {}
        for key, values in query.items():
            if key in SENSITIVE_QUERY_KEYS or "token" in key.lower() or "bogus" in key.lower():
                redacted[key] = ["[REDACTED]"]
            else:
                redacted[key] = values
        return parsed._replace(query=urlencode(redacted, doseq=True)).geturl()
    except Exception:
        return url


def redact_headers(headers: Mapping[str, Any] | None) -> dict[str, str]:
    safe: dict[str, str] = {}
    for key, value in (headers or {}).items():
        key_text = str(key)
        key_lower = key_text.lower()
        if key_lower in SENSITIVE_HEADER_NAMES or "token" in key_lower or "auth" in key_lower:
            safe[key_text] = "[REDACTED]"
        else:
            safe[key_text] = truncate_value(value, 1000)
    return safe


def truncate_value(value: Any, limit: int = 2000) -> str:
    text = str(value)
    return text if len(text) <= limit else f"{text[:limit]}..."


def maybe_json(value: Any) -> Any:
    if not isinstance(value, str):
        return value
    text = value.strip()
    if not text:
        return value
    try:
        return json.loads(text)
    except Exception:
        return value


def trim_nested(value: Any, *, limit: int = 2000, max_items: int = 80) -> Any:
    if isinstance(value, dict):
        return {str(key): trim_nested(child, limit=limit, max_items=max_items) for key, child in value.items()}
    if isinstance(value, list):
        return [trim_nested(child, limit=limit, max_items=max_items) for child in value[:max_items]]
    if isinstance(value, str):
        return value if len(value) <= limit else f"{value[:limit]}..."
    return value


def summarize_chat_completion_payload(payload: Any) -> dict[str, Any]:
    data = maybe_json(payload)
    if not isinstance(data, dict):
        return {"payload_type": type(data).__name__}

    client_meta = data.get("client_meta") if isinstance(data.get("client_meta"), dict) else {}
    messages = data.get("messages") if isinstance(data.get("messages"), list) else []
    first_message = messages[0] if messages and isinstance(messages[0], dict) else {}
    all_blocks: list[dict[str, Any]] = []
    all_attachments: list[Any] = []
    message_summaries: list[dict[str, Any]] = []
    for message in messages:
        if not isinstance(message, dict):
            continue
        message_blocks = message.get("content_block") if isinstance(message.get("content_block"), list) else []
        message_attachments = message.get("attachments") if isinstance(message.get("attachments"), list) else []
        block_types = [
            block.get("block_type", block.get("type"))
            for block in message_blocks
            if isinstance(block, dict)
        ]
        message_summaries.append(
            {
                "message_keys": sorted(str(key) for key in message.keys()),
                "block_types": block_types,
                "attachment_count": len(message_attachments),
                "content_block_attachment_count": sum(
                    1
                    for block in message_blocks
                    if isinstance(block, dict)
                    and (
                        block.get("block_type", block.get("type")) == 10052
                        or "attachment" in block
                        or "attachment_block" in (block.get("content") or {})
                    )
                ),
            }
        )
        all_blocks.extend(block for block in message_blocks if isinstance(block, dict))
        all_attachments.extend(message_attachments)
    message_ext = first_message.get("ext") if isinstance(first_message.get("ext"), dict) else {}
    top_ext = data.get("ext") if isinstance(data.get("ext"), dict) else {}
    chat_ability = data.get("chat_ability") if isinstance(data.get("chat_ability"), dict) else {}
    ability_param = maybe_json(chat_ability.get("ability_param"))
    input_skill = maybe_json(top_ext.get("input_skill") or message_ext.get("input_skill"))

    return {
        "payload_keys": sorted(str(key) for key in data.keys()),
        "client_meta": {
            "local_conversation_id": client_meta.get("local_conversation_id"),
            "conversation_id": client_meta.get("conversation_id"),
            "bot_id": client_meta.get("bot_id"),
            "last_section_id": client_meta.get("last_section_id"),
            "last_message_index": client_meta.get("last_message_index"),
        },
        "message_keys": sorted(str(key) for key in first_message.keys()),
        "message_count": len(messages),
        "message_summaries": message_summaries,
        "message_content_type": first_message.get("content_type"),
        "message_skill": first_message.get("skill"),
        "block_types": [
            block.get("block_type", block.get("type"))
            for block in all_blocks
            if isinstance(block, dict)
        ],
        "attachment_count": len(all_attachments),
        "content_block_attachment_count": sum(
            1
            for block in all_blocks
            if isinstance(block, dict)
            and (
                block.get("block_type", block.get("type")) == 10052
                or "attachment" in block
                or "attachment_block" in (block.get("content") or {})
            )
        ),
        "message_ext_keys": sorted(str(key) for key in message_ext.keys()),
        "top_level_ext_keys": sorted(str(key) for key in top_ext.keys()),
        "ability_type": chat_ability.get("ability_type"),
        "ability_param": ability_param if isinstance(ability_param, dict) else None,
        "input_skill": input_skill if isinstance(input_skill, dict) else None,
        "option_keys": sorted(str(key) for key in (data.get("option") or {}).keys())
        if isinstance(data.get("option"), dict)
        else [],
    }


def build_context_template(
    *,
    account_index: int,
    profile_id: str,
    request_url: str,
    method: str,
    headers: Mapping[str, Any] | None,
    payload: Any,
    source: str = "frontend_page",
) -> dict[str, Any]:
    parsed_payload = maybe_json(payload)
    return {
        "object": "doubao_chat_completion_context_template",
        "source": source,
        "account_index": int(account_index),
        "profile_id": profile_id,
        "captured_at": time.time(),
        "request": {
            "method": method,
            "url": redact_url(request_url),
            "headers": redact_headers(headers),
            "payload_summary": summarize_chat_completion_payload(parsed_payload),
            "payload": trim_nested(parsed_payload),
        },
    }


def save_context_template(template: dict[str, Any]) -> dict[str, str]:
    context_template_dir().mkdir(parents=True, exist_ok=True)
    account_index = int(template["account_index"])
    profile_id = str(template.get("profile_id") or "unknown")
    archived = archived_context_template_path(account_index, profile_id)
    latest = latest_context_template_path(account_index)
    text = json.dumps(template, ensure_ascii=False, indent=2)
    archived.write_text(text, encoding="utf-8")
    latest.write_text(text, encoding="utf-8")
    return {"archived_path": str(archived), "latest_path": str(latest)}


def load_latest_context_template(account_index: int) -> dict[str, Any] | None:
    path = latest_context_template_path(account_index)
    if not path.is_file():
        return None
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return None
    return data if isinstance(data, dict) else None


def context_summary_for_public(template: dict[str, Any] | None) -> dict[str, Any] | None:
    if not isinstance(template, dict):
        return None
    request = template.get("request") if isinstance(template.get("request"), dict) else {}
    summary = request.get("payload_summary") if isinstance(request.get("payload_summary"), dict) else {}
    return {
        "source": template.get("source"),
        "captured_at": template.get("captured_at"),
        "latest_path": str(latest_context_template_path(int(template.get("account_index") or 0))),
        "request_url": request.get("url"),
        "client_meta": summary.get("client_meta"),
        "ability_type": summary.get("ability_type"),
        "ability_param": summary.get("ability_param"),
        "block_types": summary.get("block_types"),
        "attachment_count": summary.get("attachment_count"),
        "content_block_attachment_count": summary.get("content_block_attachment_count"),
        "input_skill": summary.get("input_skill"),
    }


def compare_payload_to_template(payload: Any, template: dict[str, Any] | None) -> dict[str, Any]:
    current = summarize_chat_completion_payload(payload)
    if not isinstance(template, dict):
        return {
            "template_found": False,
            "current_summary": current,
            "differences": ["No recorded frontend context template exists for this account."],
        }

    request = template.get("request") if isinstance(template.get("request"), dict) else {}
    template_summary = request.get("payload_summary") if isinstance(request.get("payload_summary"), dict) else {}
    differences: list[str] = []

    def compare_value(path: str, left: Any, right: Any) -> None:
        if left != right:
            differences.append(f"{path}: current={left!r}, template={right!r}")

    current_meta = current.get("client_meta") or {}
    template_meta = template_summary.get("client_meta") or {}
    for key in ("conversation_id", "local_conversation_id", "bot_id", "last_section_id", "last_message_index"):
        compare_value(f"client_meta.{key}", current_meta.get(key), template_meta.get(key))

    for key in (
        "message_content_type",
        "message_skill",
        "block_types",
        "attachment_count",
        "content_block_attachment_count",
        "message_ext_keys",
        "top_level_ext_keys",
        "ability_type",
        "ability_param",
        "input_skill",
        "option_keys",
    ):
        compare_value(key, current.get(key), template_summary.get(key))

    return {
        "template_found": True,
        "template_source": template.get("source"),
        "template_captured_at": template.get("captured_at"),
        "template_request_url": request.get("url"),
        "current_summary": current,
        "template_summary": template_summary,
        "differences": differences[:80],
        "difference_count": len(differences),
    }
