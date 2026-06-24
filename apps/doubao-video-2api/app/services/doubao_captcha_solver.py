from __future__ import annotations

import base64
import importlib
import json
import os
import re
import sys
from pathlib import Path
from typing import Any

import httpx
from loguru import logger
from pydantic import BaseModel, Field

from app.core.config import settings
from app.services.doubao_challenge_probe import apply_doubao_drag_captcha_indices, probe_doubao_drag_captcha


OPENAI_BACKENDS = {"openai", "openai_compatible", "chat_completions"}
HTTP_JSON_BACKENDS = {"http_json", "json_http", "custom_http", "external_http"}
ZHENXUN_LLM_BACKENDS = {"zhenxun", "zhenxun_llm"}
ZHENXUN_PLUGIN_BACKENDS = {"zhenxun_plugin", "zhenxun-plugin", "plugin"}
SUPPORTED_BACKENDS = OPENAI_BACKENDS | HTTP_JSON_BACKENDS | ZHENXUN_LLM_BACKENDS | ZHENXUN_PLUGIN_BACKENDS


class CaptchaSolution(BaseModel):
    success: bool = Field(..., description="Whether the captcha was recognized.")
    indices: list[int] = Field(..., description="1-based image indices to drag.")


CAPTCHA_SYSTEM_PROMPT = """\
You solve Doubao drag captcha challenges for the currently logged-in browser session.
The screenshot shows a text prompt and a grid of candidate images.
Images are numbered from 1 to 9, left to right, top to bottom.

Return strict JSON only:
{"success": true, "indices": [1, 5, 8]}

If you cannot determine the answer, return:
{"success": false, "indices": []}
"""


def _env_first(*names: str) -> str:
    for name in names:
        value = os.environ.get(name, "").strip()
        if value:
            return value
    return ""


def _normalize_backend(value: str) -> str:
    backend = (value or "openai").strip().lower().replace("-", "_")
    if backend == "zhenxunplugin":
        return "zhenxun_plugin"
    return backend


def _solver_config() -> dict[str, Any]:
    backend = _normalize_backend(
        str(settings.DOUBAO_CAPTCHA_SOLVER_BACKEND or "").strip()
        or _env_first("DOUBAO_CAPTCHA_SOLVER_BACKEND", "CAPTCHA_SOLVER_BACKEND")
        or "openai"
    )
    base_url = (
        (settings.DOUBAO_CAPTCHA_SOLVER_BASE_URL or "").strip()
        or _env_first("DOUBAO_CAPTCHA_SOLVER_BASE_URL", "CAPTCHA_BASE_URL", "LOCAL_BASE_URL", "OPENAI_BASE_URL")
    )
    api_key = (
        (settings.DOUBAO_CAPTCHA_SOLVER_API_KEY or "").strip()
        or _env_first("DOUBAO_CAPTCHA_SOLVER_API_KEY", "CAPTCHA_API_KEY", "LOCAL_API_KEY", "OPENAI_API_KEY")
        or "EMPTY"
    )
    model = (
        (settings.DOUBAO_CAPTCHA_SOLVER_MODEL or "").strip()
        or _env_first("DOUBAO_CAPTCHA_SOLVER_MODEL", "CAPTCHA_MULTIMODAL_MODEL", "LOCAL_MODEL", "OPENAI_MODEL")
    )
    zhenxun_model = (
        (settings.DOUBAO_CAPTCHA_ZHENXUN_MODEL or "").strip()
        or _env_first("DOUBAO_CAPTCHA_ZHENXUN_MODEL", "AUXILIARY_LLM_MODEL", "auxiliary_llm_model")
        or model
    )
    zhenxun_import_path = (
        (settings.DOUBAO_CAPTCHA_ZHENXUN_IMPORT_PATH or "").strip()
        or _env_first("DOUBAO_CAPTCHA_ZHENXUN_IMPORT_PATH", "ZHENXUN_IMPORT_PATH")
    )
    zhenxun_plugin_module = (
        (settings.DOUBAO_CAPTCHA_ZHENXUN_PLUGIN_MODULE or "").strip()
        or _env_first("DOUBAO_CAPTCHA_ZHENXUN_PLUGIN_MODULE")
        or "ai_creation.engines.doubao.captcha_solver"
    )
    return {
        "backend": backend,
        "enabled": bool(settings.DOUBAO_CAPTCHA_AUTO_SOLVE),
        "base_url": base_url.rstrip("/"),
        "api_key": api_key,
        "model": model,
        "zhenxun_model": zhenxun_model,
        "zhenxun_import_path": zhenxun_import_path,
        "zhenxun_plugin_module": zhenxun_plugin_module,
        "timeout": float(settings.DOUBAO_CAPTCHA_SOLVER_TIMEOUT_SECONDS or 45),
        "retries": max(1, int(settings.DOUBAO_CAPTCHA_SOLVER_RETRIES or 2)),
    }


def _solver_is_configured(config: dict[str, Any]) -> bool:
    if not config.get("enabled"):
        return False
    backend = _normalize_backend(str(config.get("backend") or "openai"))
    if backend in OPENAI_BACKENDS:
        return bool(config.get("base_url") and config.get("model"))
    if backend in HTTP_JSON_BACKENDS:
        return bool(config.get("base_url"))
    if backend in ZHENXUN_LLM_BACKENDS or backend in ZHENXUN_PLUGIN_BACKENDS:
        return True
    return False


def _chat_completions_url(base_url: str) -> str:
    base = base_url.rstrip("/")
    if base.endswith("/chat/completions"):
        return base
    if base.endswith("/v1"):
        return f"{base}/chat/completions"
    return f"{base}/v1/chat/completions"


def _http_json_url(base_url: str) -> str:
    return base_url.rstrip("/")


def _extract_json(text: str) -> dict[str, Any]:
    cleaned = str(text or "").strip()
    match = re.search(r"```(?:json)?\s*(.*?)\s*```", cleaned, re.S | re.I)
    if match:
        cleaned = match.group(1).strip()
    else:
        start = cleaned.find("{")
        end = cleaned.rfind("}")
        if start >= 0 and end > start:
            cleaned = cleaned[start : end + 1]
    data = json.loads(cleaned)
    if not isinstance(data, dict):
        raise ValueError(f"Expected JSON object, got {type(data).__name__}")
    return data


def _indices_from_solution(solution: dict[str, Any]) -> list[int]:
    raw = solution.get("indices")
    if raw is None:
        raw = solution.get("objects")
    if raw is None:
        raw = solution.get("answer")
    if not isinstance(raw, list):
        return []

    values: list[int] = []
    for item in raw:
        try:
            value = int(item)
        except (TypeError, ValueError):
            continue
        values.append(value)
    if not values:
        return []

    # Some generic captcha classifiers return 0-based "objects". Doubao/zhenxun
    # uses 1-based indices, so normalize only when a zero is present.
    if 0 in values:
        values = [value + 1 for value in values]
    return [value for value in values if value >= 1]


def _classification_result(config: dict[str, Any]) -> dict[str, Any]:
    return {
        "object": "doubao_drag_captcha_classification",
        "configured": _solver_is_configured(config),
        "enabled": bool(config["enabled"]),
        "backend": config["backend"],
        "model": config["zhenxun_model"] if config["backend"] in ZHENXUN_LLM_BACKENDS else config["model"],
        "indices": [],
        "raw": None,
        "error": None,
    }


async def _classify_with_openai_compatible(
    prompt_text: str,
    screenshot_bytes: bytes,
    config: dict[str, Any],
    result: dict[str, Any],
) -> dict[str, Any]:
    image_url = "data:image/png;base64," + base64.b64encode(screenshot_bytes).decode("ascii")
    user_text = (
        "Question: "
        + (prompt_text or "")
        + "\nReturn only JSON with success and 1-based indices for all matching images."
    )
    payload = {
        "model": config["model"],
        "temperature": 0.05,
        "max_tokens": 256,
        "messages": [
            {"role": "system", "content": CAPTCHA_SYSTEM_PROMPT},
            {
                "role": "user",
                "content": [
                    {"type": "text", "text": user_text},
                    {"type": "image_url", "image_url": {"url": image_url, "detail": "high"}},
                ],
            },
        ],
    }

    headers = {"Authorization": f"Bearer {config['api_key']}"}
    last_error: Exception | None = None
    for attempt in range(config["retries"]):
        try:
            async with httpx.AsyncClient(timeout=config["timeout"]) as client:
                response = await client.post(_chat_completions_url(config["base_url"]), headers=headers, json=payload)
            response.raise_for_status()
            data = response.json()
            raw_text = str(data.get("choices", [{}])[0].get("message", {}).get("content") or "")
            parsed = _extract_json(raw_text)
            indices = _indices_from_solution(parsed)
            result["raw"] = parsed
            result["indices"] = indices
            result["success"] = bool(parsed.get("success") is not False and indices)
            return result
        except Exception as exc:
            last_error = exc
            logger.warning(f"Doubao captcha OpenAI-compatible classification attempt {attempt + 1} failed: {exc}")

    result["error"] = str(last_error or "classification failed")
    return result


async def _classify_with_http_json(
    prompt_text: str,
    screenshot_bytes: bytes,
    config: dict[str, Any],
    result: dict[str, Any],
) -> dict[str, Any]:
    payload = {
        "prompt": prompt_text or "",
        "image_base64": base64.b64encode(screenshot_bytes).decode("ascii"),
        "image_mime": "image/png",
    }
    headers: dict[str, str] = {}
    if config["api_key"] and config["api_key"] != "EMPTY":
        headers["Authorization"] = f"Bearer {config['api_key']}"

    last_error: Exception | None = None
    for attempt in range(config["retries"]):
        try:
            async with httpx.AsyncClient(timeout=config["timeout"]) as client:
                response = await client.post(_http_json_url(config["base_url"]), headers=headers, json=payload)
            response.raise_for_status()
            data = response.json()
            if not isinstance(data, dict):
                raise ValueError(f"Expected JSON object, got {type(data).__name__}")
            indices = _indices_from_solution(data)
            result["raw"] = data
            result["indices"] = indices
            result["success"] = bool(data.get("success") is not False and indices)
            return result
        except Exception as exc:
            last_error = exc
            logger.warning(f"Doubao captcha HTTP JSON classification attempt {attempt + 1} failed: {exc}")

    result["error"] = str(last_error or "classification failed")
    return result


def _extend_zhenxun_import_path(config: dict[str, Any]) -> None:
    raw_path = str(config.get("zhenxun_import_path") or "").strip()
    if not raw_path:
        return
    for value in [part.strip() for part in raw_path.split(";") if part.strip()]:
        path = Path(value).expanduser()
        try:
            resolved = path.resolve()
        except Exception:
            resolved = path
        candidate = resolved.parent if resolved.name == "ai_creation" else resolved
        if str(candidate) not in sys.path:
            sys.path.insert(0, str(candidate))


async def _classify_with_zhenxun_llm(
    prompt_text: str,
    screenshot_bytes: bytes,
    config: dict[str, Any],
    result: dict[str, Any],
) -> dict[str, Any]:
    try:
        _extend_zhenxun_import_path(config)
        llm = importlib.import_module("zhenxun.services.llm")
        create_multimodal_message = getattr(llm, "create_multimodal_message")
        generate_structured = getattr(llm, "generate_structured")
        message = create_multimodal_message(text=f"Question: '{prompt_text or ''}'", images=[screenshot_bytes])
        kwargs: dict[str, Any] = {
            "response_model": CaptchaSolution,
            "instruction": CAPTCHA_SYSTEM_PROMPT,
        }
        if config.get("zhenxun_model"):
            kwargs["model"] = config["zhenxun_model"]
        solution = await generate_structured(message, **kwargs)
        if hasattr(solution, "model_dump"):
            parsed = solution.model_dump()
        elif hasattr(solution, "dict"):
            parsed = solution.dict()
        elif isinstance(solution, dict):
            parsed = solution
        else:
            parsed = {"success": bool(getattr(solution, "success", False)), "indices": getattr(solution, "indices", [])}
        indices = _indices_from_solution(parsed)
        result["raw"] = parsed
        result["indices"] = indices
        result["success"] = bool(parsed.get("success") is not False and indices)
        return result
    except Exception as exc:
        result["error"] = str(exc)
        logger.warning(f"Doubao captcha zhenxun LLM classification failed: {exc}")
        return result


async def _solve_with_zhenxun_plugin(page: Any, config: dict[str, Any]) -> bool:
    _extend_zhenxun_import_path(config)
    module = importlib.import_module(str(config.get("zhenxun_plugin_module") or "ai_creation.engines.doubao.captcha_solver"))
    solver = getattr(module, "solve_drag_captcha_if_present")
    return bool(await solver(page))


async def classify_doubao_drag_captcha(prompt_text: str, screenshot_bytes: bytes) -> dict[str, Any]:
    config = _solver_config()
    result: dict[str, Any] = _classification_result(config)
    backend = _normalize_backend(str(config["backend"]))
    if not config["enabled"]:
        result["error"] = "DOUBAO_CAPTCHA_AUTO_SOLVE is disabled."
        return result
    if backend not in SUPPORTED_BACKENDS:
        result["error"] = f"Unsupported captcha solver backend: {backend}."
        return result
    if not _solver_is_configured(config):
        if backend in OPENAI_BACKENDS:
            result["error"] = (
                "Captcha solver is not configured. Set DOUBAO_CAPTCHA_SOLVER_BASE_URL "
                "and DOUBAO_CAPTCHA_SOLVER_MODEL, or compatible CAPTCHA_BASE_URL/CAPTCHA_MULTIMODAL_MODEL."
            )
        elif backend in HTTP_JSON_BACKENDS:
            result["error"] = "Captcha HTTP JSON solver is not configured. Set DOUBAO_CAPTCHA_SOLVER_BASE_URL."
        else:
            result["error"] = f"Captcha solver backend {backend} is not configured."
        return result
    if backend in ZHENXUN_PLUGIN_BACKENDS:
        result["error"] = (
            "The zhenxun_plugin backend solves directly from the browser page. "
            "Use solve_doubao_drag_captcha_if_present instead of classify_doubao_drag_captcha."
        )
        return result

    if backend in OPENAI_BACKENDS:
        return await _classify_with_openai_compatible(prompt_text, screenshot_bytes, config, result)
    if backend in HTTP_JSON_BACKENDS:
        return await _classify_with_http_json(prompt_text, screenshot_bytes, config, result)
    if backend in ZHENXUN_LLM_BACKENDS:
        return await _classify_with_zhenxun_llm(prompt_text, screenshot_bytes, config, result)

    result["error"] = f"Unsupported captcha solver backend: {backend}."
    return result


async def solve_doubao_drag_captcha_if_present(page: Any) -> dict[str, Any]:
    config = _solver_config()
    backend = _normalize_backend(str(config["backend"]))
    result: dict[str, Any] = {
        "object": "doubao_drag_captcha_auto_solve",
        "attempted": False,
        "solved": False,
        "backend": backend,
        "prompt_text": "",
        "classification": None,
        "drag_result": None,
        "probe": None,
        "error": None,
    }
    probe = await probe_doubao_drag_captcha(page)
    result["probe"] = probe
    if not probe.get("solver_compatible"):
        result["error"] = "No zhenxun-compatible visible Doubao drag captcha is present."
        return result

    result["attempted"] = True
    if backend in ZHENXUN_PLUGIN_BACKENDS:
        result["classification"] = {
            "object": "doubao_drag_captcha_classification",
            "configured": _solver_is_configured(config),
            "enabled": bool(config["enabled"]),
            "backend": backend,
            "model": None,
            "indices": [],
            "raw": None,
            "error": None,
        }
        if not config["enabled"]:
            result["error"] = "DOUBAO_CAPTCHA_AUTO_SOLVE is disabled."
            result["classification"]["error"] = result["error"]
            return result
        try:
            result["solved"] = await _solve_with_zhenxun_plugin(page, config)
            if not result["solved"]:
                result["error"] = "zhenxun-plugin captcha solver returned false."
        except Exception as exc:
            result["error"] = str(exc)
            result["classification"]["error"] = str(exc)
        return result

    try:
        frame = page.frame_locator("#captcha_container iframe")
        prompt_element = frame.locator(".captcha-prompt-bar .tit")
        prompt_text = " ".join(((await prompt_element.text_content()) or "").split())
        result["prompt_text"] = prompt_text
        captcha_box = frame.locator("#vc_captcha_box")
        screenshot = await captcha_box.screenshot()
        classification = await classify_doubao_drag_captcha(prompt_text, screenshot)
        result["classification"] = classification
        indices = classification.get("indices") if isinstance(classification, dict) else []
        if not indices:
            result["error"] = classification.get("error") or "Captcha solver returned no indices."
            return result
        drag_result = await apply_doubao_drag_captcha_indices(page, [int(item) for item in indices])
        result["drag_result"] = drag_result
        result["solved"] = bool(drag_result.get("submitted") and drag_result.get("challenge_hidden"))
        if not result["solved"]:
            result["error"] = drag_result.get("error") or "Captcha submit did not hide the challenge."
    except Exception as exc:
        result["error"] = str(exc)
    return result
