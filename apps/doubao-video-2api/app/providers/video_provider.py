import asyncio
import base64
from contextlib import suppress
from datetime import datetime, timedelta, timezone
import hashlib
import hmac
import json
import math
import mimetypes
import os
import re
import secrets
import shutil
import subprocess
import time
import uuid
import zlib
from pathlib import Path
from typing import Any, Dict, Iterable, Optional
from urllib.parse import quote, urlencode, urlparse

import httpx
import imageio.v3 as iio
import imageio_ffmpeg
import numpy as np
from fastapi import HTTPException
from fastapi.responses import JSONResponse
from loguru import logger

from app.core.config import normalize_doubao_cookie, settings
from app.services.credential_manager import (
    CredentialManager,
    VIDEO_HISTORY_NO_SIGNAL_MARKER,
    is_login_expired_error,
    is_quota_exhausted_error,
    is_verification_required_error,
    next_video_quota_reset_at,
    video_quota_day,
)
from app.services.doubao_context_template import compare_payload_to_template, load_latest_context_template
from app.services.manual_verification import ManualVerificationManager
from app.services.playwright_manager import PlaywrightManager


VIDEO_URL_RE = re.compile(r"https?://[^\s\"'<>]+?\.(?:mp4|mov|m3u8)(?:\?[^\s\"'<>]*)?", re.I)
DATA_IMAGE_RE = re.compile(r"^data:(image/[a-zA-Z0-9.+-]+);base64,(.+)$", re.S)
VIDEO_QUOTA_TEXT_MARKERS = (
    "\u89c6\u9891\u751f\u6210\u989d\u5ea6",
    "\u89c6\u9891\u751f\u6210\u5269\u4f59\u989d\u5ea6",
    "\u89c6\u9891\u989d\u5ea6",
    "\u751f\u6210\u6b21\u6570",
    "\u4eca\u5929\u7684\u751f\u6210\u6b21\u6570",
    "\u4eca\u65e5\u751f\u6210\u6b21\u6570",
    "Seedance",
    "seedance",
    "video generation quota",
    "video credits",
    "generation limit",
    "daily limit",
)
VIDEO_QUOTA_CONSUME_RE = re.compile(
    r"(?:\u9700\u8981\u6d88\u8017|\u5c06\u6d88\u8017|consume)\D{0,16}(\d+(?:\.\d+)?)",
    re.I,
)
VIDEO_QUOTA_REMAINING_RE = re.compile(
    r"(?:\u89c6\u9891\u751f\u6210)?(?:\u5269\u4f59\u989d\u5ea6|\u4eca\u65e5\u5269\u4f59|\u5269\u4f59|remaining)"
    r"\D{0,24}(?:\u4e3a|\u662f|:|\uff1a)?\D{0,12}(\d+(?:\.\d+)?)",
    re.I,
)
VIDEO_HISTORY_TITLE_MARKERS = (
    "\u89c6\u9891",
    "\u8df3\u821e",
    "\u52a8\u6001",
    "\u8fd0\u955c",
    "seedance",
)
SHANGHAI_TIMEZONE = timezone(timedelta(hours=8))
VIDEO_PROMPT_INTENT_MARKERS = (
    "视频",
    "动态",
    "动画",
    "镜头",
    "运镜",
    "clip",
    "video",
    "animate",
    "animation",
    "motion",
    "cinematic",
    "seedance",
)
TASK_KEYS = {
    "task_id",
    "creation_task_id",
    "async_task_id",
    "super_task_id",
    "aigc_task_id",
    "resource_id",
}
CONVERSATION_KEYS = {
    "conversation_id",
    "conv_id",
}
VIDEO_ID_KEYS = {
    "video_id",
    "videoid",
    "vid",
}
VIDEO_ID_RE = re.compile(r"\bv[0-9a-z]{16,}\b", re.I)
URL_KEYS = {
    "video_url",
    "videourl",
    "video_uri",
    "videouri",
    "play_url",
    "playurl",
    "download_url",
    "downloadurl",
    "download_uri",
    "downloaduri",
    "output_url",
    "outputurl",
    "output_uri",
    "outputuri",
    "origin_url",
    "originurl",
    "original_url",
    "originalurl",
    "source_url",
    "sourceurl",
    "no_watermark_url",
    "nowatermarkurl",
    "without_watermark_url",
    "withoutwatermarkurl",
    "watermark_free_url",
    "watermarkfreeurl",
    "wm_free_url",
    "wmfreeurl",
    "fife_url",
    "fifeurl",
    "fife_uri",
    "fifeuri",
    "serving_base_uri",
    "servingbaseuri",
    "resource_url",
    "url",
    "uri",
    "main",
    "main_url",
    "mainurl",
    "backup",
    "backup_url",
    "backupurl",
    "backup_url_1",
    "backupurl1",
    "back_url",
    "backurl",
}
DIRECT_VIDEO_URL_KEYS = {
    "video_url",
    "videourl",
    "video_uri",
    "videouri",
    "play_url",
    "playurl",
    "download_url",
    "downloadurl",
    "download_uri",
    "downloaduri",
    "output_url",
    "outputurl",
    "output_uri",
    "outputuri",
    "origin_url",
    "originurl",
    "original_url",
    "originalurl",
    "source_url",
    "sourceurl",
    "no_watermark_url",
    "nowatermarkurl",
    "without_watermark_url",
    "withoutwatermarkurl",
    "watermark_free_url",
    "watermarkfreeurl",
    "wm_free_url",
    "wmfreeurl",
    "fife_url",
    "fifeurl",
    "fife_uri",
    "fifeuri",
    "serving_base_uri",
    "servingbaseuri",
    "resource_url",
    "main",
    "main_url",
    "mainurl",
    "backup",
    "backup_url",
    "backupurl",
    "backup_url_1",
    "backupurl1",
    "back_url",
    "backurl",
    "fallback_api",
    "fallbackapi",
}
VIDEO_URL_PRIORITY_GROUPS = (
    (
        "no_watermark_url",
        "nowatermarkurl",
        "without_watermark_url",
        "withoutwatermarkurl",
        "watermark_free_url",
        "watermarkfreeurl",
        "wm_free_url",
        "wmfreeurl",
        "download_url",
        "downloadurl",
        "download_uri",
        "downloaduri",
    ),
    (
        "origin_url",
        "originurl",
        "original_url",
        "originalurl",
        "source_url",
        "sourceurl",
        "output_url",
        "outputurl",
        "output_uri",
        "outputuri",
    ),
    (
        "fife_url",
        "fifeurl",
        "fife_uri",
        "fifeuri",
        "serving_base_uri",
        "servingbaseuri",
        "main",
        "main_url",
        "mainurl",
    ),
    (
        "video_url",
        "videourl",
        "video_uri",
        "videouri",
        "resource_url",
    ),
    (
        "play_url",
        "playurl",
    ),
    (
        "backup",
        "backup_url",
        "backupurl",
        "backup_url_1",
        "backupurl1",
        "back_url",
        "backurl",
        "fallback_api",
        "fallbackapi",
    ),
)
VIDEO_URL_KEY_PRIORITY = {
    key: priority
    for priority, keys in enumerate(VIDEO_URL_PRIORITY_GROUPS)
    for key in keys
}
VIDEO_URL_DEFAULT_PRIORITY = len(VIDEO_URL_PRIORITY_GROUPS)
VIDEO_INTENT_TEXT_MARKERS = ("Seedance", "seedance", "视频生成", "动态视频", "生视频", "video generation")
NON_VIDEO_REQ_KEY_MARKERS = ("seedream", "text2image", "image_edit")
NON_VIDEO_TOOL_NAMES = {"image_edit", "text2image"}
COMPLETED_TOOL_STATUSES = {"2", "3", "4", "success", "succeeded", "finish", "finished"}
SUCCESS_CODES = {"", "0", "none", "null"}
NON_FAILURE_MESSAGES = {"success", "ok", "succeeded"}
NON_FAILURE_PROGRESS_MARKERS = (
    "\u5c06\u6d88\u8017",
    "\u9884\u8ba1\u7b49\u5f85",
    "\u89c6\u9891\u751f\u6210\u597d\u540e",
    "\u8fd9\u5c31\u4e3a\u60a8\u751f\u6210\u89c6\u9891",
    "\u8bf7\u7a0d\u7b49",
    "\u53ca\u65f6\u901a\u77e5",
    "\u4eca\u65e5\u5269\u4f59",
    "将消耗",
    "预计等待",
    "视频生成好后",
    "这就为您生成视频",
    "请稍等",
    "及时通知",
    "今日剩余",
    "will consume",
    "please wait",
)
FAILURE_TEXT_MARKERS = (
    "error",
    "fail",
    "failed",
    "failure",
    "无法生成",
    "不能生成",
    "不足",
    "系统错误",
    "生成失败",
    "失败",
    "异常",
    "服务过载",
    "something went wrong",
)
GENERIC_UPSTREAM_FAILURE_MESSAGE = "Upstream video generation failed."
UPSTREAM_FAILURE_CODE_MESSAGES = {
    "710022002": (
        "Doubao is receiving requests too frequently from the current browser or network. "
        "Retry later or use a verified Doubao browser session."
    ),
    "710022004": (
        "Doubao requires browser verification for the current session or network "
        "(rate limited, verify_scene=doubao_message_web)."
    ),
    "710082020": (
        "Doubao daily video generation limit reached for this account. "
        "今天的生成次数已经达到上限，明天再来免费生成吧～"
    ),
    "710082041": (
        "Doubao upstream rejected the video request (710082041). "
        "The prompt or reference image may not satisfy video generation requirements, "
        "or the requested duration, ratio, or resolution may not be supported."
    ),
}
HARD_CREDENTIAL_FAILURE_CODES = {"710022002", "710022004", "710082020"}
IMAGE_UPLOAD_EXTENSIONS = {".jpg", ".jpeg", ".png", ".webp"}
IMAGEX_REGION = "cn-north-1"
IMAGEX_SERVICE = "imagex"
DOUBAO_BLOCK_TEXT = 10000
DOUBAO_BLOCK_ATTACHMENT = 10052
DOUBAO_ATTACHMENT_TYPE_IMAGE = 1
DOUBAO_PARSE_STATE_SUCCESS = 1
DOUBAO_REVIEW_STATE_ACCESS = 1
DOUBAO_UPLOAD_STATUS_SUCCESS = 1
DEBUG_SSE_LINE_LIMIT = 80
DEBUG_EVENT_LIMIT = 50
DEBUG_TEXT_LIMIT = 2000
VERIFICATION_CONTEXT_KEYS = (
    "verify_scene",
    "log_id",
    "from",
    "type",
    "subtype",
    "region",
    "code",
    "detail",
)
VIDEO_DOWNLOAD_CHUNK_SIZE = 1024 * 1024
WATERMARK_URL_MARKERS = (
    "video_gen_watermark_dyn",
    "logo_type=video_gen_watermark",
    "lr=video_gen_watermark",
    "watermark=true",
)
SENSITIVE_HEADER_NAMES = {
    "authorization",
    "cookie",
    "set-cookie",
    "x-ms-token",
    "x-amz-security-token",
    "x-amz-date",
    "x-amz-content-sha256",
}


class VideoQuotaInsufficientError(RuntimeError):
    """Selected account has video quota, but not enough for the current request."""

    def __init__(self, message: str, remaining: Optional[float] = None, required: Optional[float] = None) -> None:
        super().__init__(message)
        self.remaining = remaining
        self.required = required


class RetryableUploadAuthError(RuntimeError):
    """The selected account could not prepare image upload auth; try another account."""


def write_mock_mp4(path: Path, prompt: str, task_id: str, width: int, height: int, reference_image: Optional[Dict[str, Any]] = None) -> None:
    """Write a tiny playable MP4 so local tests exercise a real video artifact."""
    digest = hashlib.sha256(f"{task_id}:{prompt}".encode("utf-8")).digest()
    base = np.array([digest[0], digest[7], digest[15]], dtype=np.uint8)
    accent = np.array([digest[23], digest[3], digest[11]], dtype=np.uint8)
    image_frame = prepare_reference_frame(reference_image, width, height)

    fps, seconds = 12, 2
    frames = []
    x = np.linspace(0, 1, width, dtype=np.float32)
    y = np.linspace(0, 1, height, dtype=np.float32)[:, None]
    for index in range(fps * seconds):
        phase = index / (fps * seconds)
        wave = ((np.sin((x + phase) * np.pi * 4) + 1) * 0.5)[None, :, None]
        gradient = ((x[None, :, None] + y[:, :, None]) * 0.5)
        color = base * (1 - gradient) + accent * gradient
        frame = np.clip(color * (0.7 + 0.3 * wave), 0, 255).astype(np.uint8)
        if image_frame is not None:
            frame = np.clip(frame * 0.35 + image_frame * 0.65, 0, 255).astype(np.uint8)
        marker_x = int((width - 42) * phase)
        frame[height // 2 - 12:height // 2 + 12, marker_x:marker_x + 42] = 255 - frame[
            height // 2 - 12:height // 2 + 12,
            marker_x:marker_x + 42,
        ]
        frames.append(frame)

    iio.imwrite(path, np.stack(frames), fps=fps, codec="libx264")


def prepare_reference_frame(reference_image: Optional[Dict[str, Any]], width: int, height: int) -> Optional[np.ndarray]:
    if not reference_image or not reference_image.get("bytes"):
        return None

    try:
        image = iio.imread(reference_image["bytes"])
    except Exception as exc:
        raise ValueError(f"Unable to read reference image: {exc}") from exc

    if image.ndim == 2:
        image = np.repeat(image[:, :, None], 3, axis=2)
    if image.shape[2] == 4:
        alpha = image[:, :, 3:4].astype(np.float32) / 255
        image = image[:, :, :3].astype(np.float32) * alpha + 255 * (1 - alpha)
    image = image[:, :, :3].astype(np.uint8)
    return resize_nearest(image, width, height)


def resize_nearest(image: np.ndarray, width: int, height: int) -> np.ndarray:
    y_index = np.linspace(0, image.shape[0] - 1, height).astype(np.int32)
    x_index = np.linspace(0, image.shape[1] - 1, width).astype(np.int32)
    return image[y_index][:, x_index]


def preview_dimensions(width: int, height: int, max_edge: int = 320) -> tuple[int, int]:
    scale = min(max_edge / max(width, height), 1)
    preview_width = max(2, int(round(width * scale / 2) * 2))
    preview_height = max(2, int(round(height * scale / 2) * 2))
    return preview_width, preview_height


def inspect_image_dimensions(raw: bytes) -> tuple[Optional[int], Optional[int]]:
    try:
        image = iio.imread(raw)
    except Exception:
        return None, None
    if getattr(image, "ndim", 0) < 2:
        return None, None
    return int(image.shape[1]), int(image.shape[0])


def random_upload_nonce() -> str:
    alphabet = "abcdefghijklmnopqrstuvwxyz0123456789"
    return "".join(secrets.choice(alphabet) for _ in range(11))


def normalized_object_key(key: Any) -> str:
    return re.sub(r"[^a-z0-9]", "", str(key or "").lower())


def iter_dicts(value: Any) -> Iterable[Dict[str, Any]]:
    if isinstance(value, dict):
        yield value
        for child in value.values():
            yield from iter_dicts(child)
    elif isinstance(value, list):
        for child in value:
            yield from iter_dicts(child)


def mapping_value(mapping: Dict[str, Any], *keys: str) -> Any:
    wanted = {normalized_object_key(key) for key in keys}
    for key, value in mapping.items():
        if normalized_object_key(key) in wanted and value not in (None, ""):
            return value
    return None


def normalize_upload_auth_token(value: Any) -> Dict[str, str]:
    for mapping in iter_dicts(value):
        access_key = mapping_value(
            mapping,
            "access_key",
            "accessKey",
            "access_key_id",
            "accessKeyId",
            "AccessKeyId",
            "AccessKeyID",
            "ak",
        )
        secret_key = mapping_value(
            mapping,
            "secret_key",
            "secretKey",
            "secret_access_key",
            "secretAccessKey",
            "SecretAccessKey",
            "sk",
        )
        session_token = mapping_value(
            mapping,
            "session_token",
            "sessionToken",
            "SessionToken",
            "sts_token",
            "security_token",
            "securityToken",
        )
        if access_key and secret_key and session_token:
            return {
                "access_key": str(access_key),
                "secret_key": str(secret_key),
                "session_token": str(session_token),
            }
    return {}


def normalize_prepare_upload_data(value: Any) -> Dict[str, Any]:
    service_id = None
    auth_source: Any = None

    for mapping in iter_dicts(value):
        if service_id is None:
            service_id = mapping_value(
                mapping,
                "service_id",
                "serviceId",
                "ServiceId",
                "serviceID",
                "image_service_id",
                "imagex_service_id",
            )
        if auth_source is None:
            auth_source = mapping_value(
                mapping,
                "upload_auth_token",
                "uploadAuthToken",
                "uploadAuth",
                "auth_token",
                "authToken",
                "auth",
                "token",
                "sts",
            )
        if service_id is not None and auth_source is not None:
            break

    auth_token = normalize_upload_auth_token(auth_source if auth_source is not None else value)
    return {
        "service_id": str(service_id) if service_id is not None else None,
        "upload_auth_token": auth_token,
    }


def redact_prepare_upload_response(value: Any) -> Any:
    if isinstance(value, dict):
        redacted: Dict[str, Any] = {}
        for key, child in value.items():
            normalized = normalized_object_key(key)
            if any(marker in normalized for marker in ("token", "secret", "auth", "accesskey", "session")):
                redacted[str(key)] = "[REDACTED]"
            else:
                redacted[str(key)] = redact_prepare_upload_response(child)
        return redacted
    if isinstance(value, list):
        return [redact_prepare_upload_response(child) for child in value[:5]]
    return value


def prepare_upload_response_summary(value: Dict[str, Any]) -> Dict[str, Any]:
    data = value.get("data") if isinstance(value.get("data"), dict) else {}
    return {
        "code": value.get("code"),
        "message": value.get("msg") or value.get("message"),
        "top_level_keys": sorted(str(key) for key in value.keys()),
        "data_keys": sorted(str(key) for key in data.keys()),
        "redacted": redact_prepare_upload_response(value),
    }


def canonical_query(params: Dict[str, Any]) -> str:
    pairs = []
    for key, value in params.items():
        if value is None:
            continue
        pairs.append((quote(str(key), safe="-_.~"), quote(str(value), safe="-_.~")))
    return "&".join(f"{key}={value}" for key, value in sorted(pairs))


def sign_imagex_request(
    method: str,
    url: str,
    query_params: Dict[str, Any],
    body: bytes,
    auth_token: Dict[str, str],
    include_content_sha256: bool = False,
) -> Dict[str, str]:
    access_key = auth_token.get("access_key")
    secret_key = auth_token.get("secret_key")
    session_token = auth_token.get("session_token")
    if not access_key or not secret_key or not session_token:
        raise RetryableUploadAuthError("prepare_upload did not return a complete upload auth token.")

    now = datetime.now(timezone.utc)
    amz_date = now.strftime("%Y%m%dT%H%M%SZ")
    date_stamp = now.strftime("%Y%m%d")
    payload_hash = hashlib.sha256(body).hexdigest()

    signed_header_values = {
        "x-amz-date": amz_date,
        "x-amz-security-token": session_token,
    }
    if include_content_sha256:
        signed_header_values["x-amz-content-sha256"] = payload_hash

    signed_header_names = sorted(signed_header_values)
    canonical_headers = "".join(
        f"{name}:{' '.join(str(signed_header_values[name]).strip().split())}\n"
        for name in signed_header_names
    )
    signed_headers = ";".join(signed_header_names)
    parsed = urlparse(url)
    canonical_uri = quote(parsed.path or "/", safe="/-_.~")
    canonical_request = "\n".join(
        [
            method.upper(),
            canonical_uri,
            canonical_query(query_params),
            canonical_headers,
            signed_headers,
            payload_hash,
        ]
    )

    credential_scope = f"{date_stamp}/{IMAGEX_REGION}/{IMAGEX_SERVICE}/aws4_request"
    string_to_sign = "\n".join(
        [
            "AWS4-HMAC-SHA256",
            amz_date,
            credential_scope,
            hashlib.sha256(canonical_request.encode("utf-8")).hexdigest(),
        ]
    )

    def sign(key: bytes, message: str) -> bytes:
        return hmac.new(key, message.encode("utf-8"), hashlib.sha256).digest()

    signing_key = sign(
        sign(
            sign(
                sign(("AWS4" + secret_key).encode("utf-8"), date_stamp),
                IMAGEX_REGION,
            ),
            IMAGEX_SERVICE,
        ),
        "aws4_request",
    )
    signature = hmac.new(signing_key, string_to_sign.encode("utf-8"), hashlib.sha256).hexdigest()
    authorization = (
        "AWS4-HMAC-SHA256 "
        f"Credential={access_key}/{credential_scope}, "
        f"SignedHeaders={signed_headers}, Signature={signature}"
    )

    headers = {
        "Authorization": authorization,
        "X-Amz-Date": amz_date,
        "X-Amz-Security-Token": session_token,
    }
    if include_content_sha256:
        headers["X-Amz-Content-Sha256"] = payload_hash
    return headers


def iter_values(value: Any) -> Iterable[tuple[str, Any]]:
    if isinstance(value, dict):
        for key, child in value.items():
            yield str(key), child
            yield from iter_values(child)
    elif isinstance(value, list):
        for child in value:
            yield from iter_values(child)


def maybe_json(value: Any) -> Any:
    if not isinstance(value, str):
        return value
    text = value.strip()
    if not text or text[0] not in "[{":
        return value
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        return value


def maybe_base64_url(value: Any) -> Optional[str]:
    if not isinstance(value, str):
        return None
    text = value.strip()
    if not text or text.startswith(("http://", "https://")):
        return None
    try:
        padded = text + "=" * (-len(text) % 4)
        decoded = base64.b64decode(padded).decode("utf-8")
    except Exception:
        return None
    decoded = decoded.strip()
    if decoded.startswith(("http://", "https://")):
        return decoded
    return None


def _video_url_priority(key: str = "") -> int:
    return VIDEO_URL_KEY_PRIORITY.get(str(key or "").lower(), VIDEO_URL_DEFAULT_PRIORITY)


def _is_watermarked_video_url(url: Any) -> bool:
    if not isinstance(url, str):
        return False
    text = url.lower()
    return any(marker in text for marker in WATERMARK_URL_MARKERS)


def _record_video_url(
    signals: Dict[str, Any],
    url: Any,
    key: str = "",
    *,
    priority: Optional[int] = None,
) -> None:
    if not isinstance(url, str):
        return
    normalized_url = url.strip()
    if not normalized_url:
        return

    url_priority = _video_url_priority(key) if priority is None else int(priority)
    if priority is None and _is_watermarked_video_url(normalized_url):
        url_priority += VIDEO_URL_DEFAULT_PRIORITY
    urls = signals.setdefault("video_urls", [])
    priorities = signals.setdefault("_video_url_priorities", {})

    if normalized_url in urls:
        existing_priority = int(priorities.get(normalized_url, VIDEO_URL_DEFAULT_PRIORITY))
        if url_priority >= existing_priority:
            return
        urls.remove(normalized_url)

    priorities[normalized_url] = min(
        url_priority,
        int(priorities.get(normalized_url, VIDEO_URL_DEFAULT_PRIORITY)),
    )
    insert_at = len(urls)
    for index, existing_url in enumerate(urls):
        existing_priority = int(priorities.get(existing_url, VIDEO_URL_DEFAULT_PRIORITY))
        if priorities[normalized_url] < existing_priority:
            insert_at = index
            break
    urls.insert(insert_at, normalized_url)


def _media_info_items(value: Any) -> Iterable[Dict[str, Any]]:
    if isinstance(value, dict):
        yield value
    elif isinstance(value, list):
        for item in value:
            if isinstance(item, dict):
                yield item


def _media_meta_int(meta: Any, key: str) -> int:
    if not isinstance(meta, dict):
        return 0
    try:
        return int(float(str(meta.get(key) or "0")))
    except (TypeError, ValueError):
        return 0


def _media_definition_score(meta: Any) -> int:
    if not isinstance(meta, dict):
        return 0
    match = re.search(r"(\d+)", str(meta.get("definition") or ""))
    return int(match.group(1)) if match else 0


def _doubao_original_media_candidates(payload: Any) -> list[Dict[str, Any]]:
    data = payload.get("data") if isinstance(payload, dict) else None
    if not isinstance(data, dict):
        return []

    candidates: list[Dict[str, Any]] = []
    # Mirrors ihmily/doubao-nomark: use original_media_info.main_url from
    # /samantha/media/get_play_info instead of post-processing the video.
    for item in _media_info_items(data.get("original_media_info")):
        meta = item.get("meta") if isinstance(item.get("meta"), dict) else {}
        area = _media_meta_int(meta, "width") * _media_meta_int(meta, "height")
        definition = _media_definition_score(meta)
        for key_index, key in enumerate(("main_url", "main", "backup_url", "backup_url_1", "back_url")):
            url = item.get(key)
            if not isinstance(url, str) or not url.startswith(("http://", "https://")):
                continue
            candidates.append(
                {
                    "url": url.strip(),
                    "source": "samantha_media_get_play_info.original_media_info",
                    "url_key": key,
                    "meta": meta,
                    "sort_key": (
                        1 if _is_watermarked_video_url(url) else 0,
                        key_index,
                        -area,
                        -definition,
                    ),
                }
            )
    candidates.sort(key=lambda item: item["sort_key"])
    return candidates


def _record_video_id(signals: Dict[str, Any], value: Any) -> None:
    if not isinstance(value, (str, int)):
        return
    text = str(value).strip()
    if not text:
        return
    matches = VIDEO_ID_RE.findall(text)
    video_ids = signals.setdefault("video_ids", [])
    for match in matches:
        video_id = match.strip()
        if video_id and video_id not in video_ids:
            video_ids.append(video_id)


def truncate_debug_text(value: Any, limit: int = DEBUG_TEXT_LIMIT) -> str:
    text = str(value)
    if len(text) <= limit:
        return text
    return text[:limit] + f"...[truncated {len(text) - limit} chars]"


def is_failure_text(text: str, key: str = "") -> bool:
    normalized = text.strip()
    if not normalized:
        return False
    text_lower = normalized.lower()
    if text_lower in NON_FAILURE_MESSAGES:
        return False
    key_lower = key.lower()
    if _has_explicit_failure_marker(normalized):
        return True
    if _is_current_task_quota_progress_text(normalized):
        return False
    if is_quota_exhausted_error(normalized):
        return True
    if _has_non_failure_progress_marker(normalized):
        return False
    return key_lower == "error_msg"


def _has_text_marker(text: str, markers: tuple[str, ...]) -> bool:
    lowered = text.lower()
    return any(marker in lowered or marker in text for marker in markers)


def _has_explicit_failure_marker(text: str) -> bool:
    return _has_text_marker(text, FAILURE_TEXT_MARKERS)


def _has_non_failure_progress_marker(text: str) -> bool:
    return _has_text_marker(text, NON_FAILURE_PROGRESS_MARKERS)


def _is_current_task_quota_progress_text(text: str) -> bool:
    return _has_non_failure_progress_marker(text) and not _has_explicit_failure_marker(text)


def normalize_prompt_text(value: Any) -> Optional[str]:
    if not isinstance(value, str):
        return None
    text = value.strip()
    if not text:
        return None
    for _ in range(2):
        try:
            parsed = json.loads(text)
        except (TypeError, json.JSONDecodeError):
            parsed = None
        if isinstance(parsed, str) and parsed.strip() and parsed.strip() != text:
            text = parsed.strip()
            continue
        break
    return text


def _number_from_match(match: Optional[re.Match[str]]) -> Optional[float]:
    if not match:
        return None
    try:
        value = float(match.group(1))
    except (TypeError, ValueError):
        return None
    return int(value) if value.is_integer() else value


def _quota_message_text(value: str) -> str:
    text = value.strip()
    parsed = maybe_json(text)
    if parsed is text:
        return " ".join(text.split())

    candidates = []
    for _, child in iter_values(parsed):
        if not isinstance(child, str):
            continue
        candidate = " ".join(child.strip().split())
        if candidate and any(marker in candidate for marker in VIDEO_QUOTA_TEXT_MARKERS):
            candidates.append(candidate)
    if not candidates:
        return " ".join(text.split())

    def score(candidate: str) -> tuple[int, int]:
        important = int(
            "剩余" in candidate
            or "remaining" in candidate.lower()
            or "达到上限" in candidate
            or "daily limit" in candidate.lower()
            or "generation limit" in candidate.lower()
        )
        return important, -len(candidate)

    return max(candidates, key=score)


def extract_video_quota_text(text: Any) -> Optional[Dict[str, Any]]:
    if not isinstance(text, str):
        return None
    normalized = _quota_message_text(text)
    if not normalized:
        return None
    if not any(marker in normalized for marker in VIDEO_QUOTA_TEXT_MARKERS):
        return None

    cost = _number_from_match(VIDEO_QUOTA_CONSUME_RE.search(normalized))
    remaining = _number_from_match(VIDEO_QUOTA_REMAINING_RE.search(normalized))

    exhausted = False
    if remaining is not None and remaining <= 0 and not _is_current_task_quota_progress_text(normalized):
        exhausted = True
    if remaining is None and str(normalized).strip() and is_quota_exhausted_error(normalized):
        exhausted = True
    if cost is None and remaining is None and not exhausted:
        return None

    return {
        "total": None,
        "remaining": remaining,
        "used": None,
        "cost": cost,
        "unit": settings.DOUBAO_QUOTA_UNIT,
        "source": "video_signal",
        "exhausted": exhausted,
        "message": normalized[:500],
    }


def video_quota_from_failure_code(code: Any, message: Any = "") -> Optional[Dict[str, Any]]:
    code_text = str(code or "").strip()
    if code_text != "710082020":
        return None
    text = str(message or "").strip() or _failure_message_for_code(code_text)
    return {
        "total": None,
        "remaining": 0,
        "used": None,
        "cost": None,
        "unit": settings.DOUBAO_QUOTA_UNIT,
        "source": "video_signal",
        "exhausted": True,
        "message": text[:500],
    }


def upstream_failure_message(code: Optional[object], fallback: Optional[str] = None) -> str:
    code_text = str(code).strip() if code is not None else ""
    if code_text in UPSTREAM_FAILURE_CODE_MESSAGES:
        return _failure_message_for_code(code_text)
    fallback_text = str(fallback or "").strip()
    if fallback_text and fallback_text.lower() not in NON_FAILURE_MESSAGES:
        return fallback_text[:500]
    return _failure_message_for_code(code_text)


def redact_response_headers(headers: httpx.Headers) -> Dict[str, str]:
    safe_headers: Dict[str, str] = {}
    for key, value in headers.items():
        key_lower = key.lower()
        if key_lower in SENSITIVE_HEADER_NAMES or "token" in key_lower or "auth" in key_lower:
            safe_headers[key] = "[REDACTED]"
        else:
            safe_headers[key] = truncate_debug_text(value, 500)
    return safe_headers


def _append_unique(items: list, item: Any) -> None:
    if item not in items:
        items.append(item)


def _normalize_verification_context_value(key: str, value: Any) -> str:
    limit = DEBUG_TEXT_LIMIT if key == "detail" else 500
    return truncate_debug_text(value, limit)


def _verification_context_from_dict(value: Dict[str, Any]) -> Optional[Dict[str, str]]:
    decision = maybe_json(value.get("decision"))
    if isinstance(decision, dict):
        context = _verification_context_from_dict(decision)
        if context:
            return context

    extra = value.get("extra")
    if isinstance(extra, dict):
        context = _verification_context_from_dict(extra)
        if context:
            return context

    context = {
        key: _normalize_verification_context_value(key, value[key])
        for key in VERIFICATION_CONTEXT_KEYS
        if key in value and value.get(key) not in (None, "")
    }
    if not context:
        return None

    looks_like_doubao_verify = (
        bool(context.get("verify_scene"))
        or context.get("from") == "shark_admin"
        or context.get("type") == "verify"
        or bool(context.get("log_id"))
    )
    return context if looks_like_doubao_verify else None


def _extract_verification_context(value: Any) -> Optional[Dict[str, str]]:
    parsed = maybe_json(value)
    if isinstance(parsed, dict):
        context = _verification_context_from_dict(parsed)
        if context:
            return context
        for _, child in iter_values(parsed):
            if child is parsed:
                continue
            context = _extract_verification_context(child)
            if context:
                return context
    elif isinstance(parsed, list):
        for item in parsed:
            context = _extract_verification_context(item)
            if context:
                return context
    return None


def _looks_like_video_intent(text: str) -> bool:
    return any(marker in text for marker in VIDEO_INTENT_TEXT_MARKERS)


def _has_video_prompt_intent(text: str) -> bool:
    normalized = text.strip().lower()
    return any(marker in normalized for marker in VIDEO_PROMPT_INTENT_MARKERS)


def _non_video_detail(message: str, *, code: Optional[str] = None) -> Dict[str, Any]:
    return {
        "code": code,
        "message": message,
        "type": "non_video_result",
    }


def _record_non_video_detail(signals: Dict[str, Any], message: str, *, code: Optional[str] = None) -> None:
    _append_unique(signals["non_video_results"], _non_video_detail(message, code=code))


def _is_completed_tool_status(value: Any) -> bool:
    if value is None:
        return False
    return str(value).strip().lower() in COMPLETED_TOOL_STATUSES


def _is_success_code(value: Any) -> bool:
    if value is None:
        return True
    return str(value).strip().lower() in SUCCESS_CODES


def _failure_message_for_code(code: Any) -> str:
    return UPSTREAM_FAILURE_CODE_MESSAGES.get(str(code).strip(), GENERIC_UPSTREAM_FAILURE_MESSAGE)


def _select_failure(failures: list[Dict[str, Any]]) -> Dict[str, Any]:
    for failure in failures:
        if str(failure.get("code") or "").strip() in HARD_CREDENTIAL_FAILURE_CODES:
            return failure
    for failure in failures:
        message = str(failure.get("message") or "")
        if is_login_expired_error(message) or is_quota_exhausted_error(message):
            return failure
    for failure in failures:
        if failure.get("message") and failure.get("message") != GENERIC_UPSTREAM_FAILURE_MESSAGE:
            return failure
    return failures[0]


def _inspect_creation_value(signals: Dict[str, Any], value: Any) -> None:
    if not isinstance(value, dict):
        return
    creations = value.get("creations") if "creations" in value else [value]
    if not isinstance(creations, list):
        return

    for creation in creations:
        if not isinstance(creation, dict):
            continue
        creation_id = creation.get("id") or creation.get("task_id")
        if creation_id is not None:
            _append_unique(signals["task_ids"], str(creation_id))
        if creation.get("video"):
            continue
        creation_type = str(creation.get("type") or "").strip()
        if creation_type == "1" and creation.get("image") and not creation.get("video"):
            placeholder = ((creation.get("image") or {}).get("placeholder") or {}).get("description")
            suffix = f" ({placeholder})" if placeholder else ""
            _record_non_video_detail(signals, f"Upstream completed an image creation instead of a video{suffix}.")


def _inspect_tool_value(signals: Dict[str, Any], value: Any) -> None:
    if not isinstance(value, dict):
        return
    task_id = value.get("task_id")
    if task_id is not None:
        _append_unique(signals["task_ids"], str(task_id))

    tool_name = str(value.get("tool_name") or "").strip().lower()
    req_key = str(value.get("req_key") or "").strip().lower()
    dispatcher = str(value.get("dispatcher_agent") or value.get("agent_name") or "")
    status = value.get("status")
    fail_code = value.get("fail_code")
    if fail_code is not None and not _is_success_code(fail_code):
        message = (
            value.get("fail_msg")
            or value.get("fail_message")
            or value.get("error_msg")
            or value.get("message")
            or value.get("msg")
            or value.get("status_msg")
        )
        failure = {"code": str(fail_code), "message": upstream_failure_message(fail_code, message)}
        _append_unique(signals["failures"], failure)
    if _is_completed_tool_status(status) and _is_success_code(fail_code):
        is_non_video_tool = (
            tool_name in NON_VIDEO_TOOL_NAMES
            or any(marker in req_key for marker in NON_VIDEO_REQ_KEY_MARKERS)
            or "图片" in dispatcher
        )
        if is_non_video_tool:
            label = tool_name or req_key or dispatcher or "image generation"
            _record_non_video_detail(
                signals,
                f"Upstream completed {label} instead of a video.",
                code=str(fail_code) if fail_code is not None else None,
            )


def extract_video_signals(value: Any) -> Dict[str, Any]:
    signals: Dict[str, Any] = empty_video_signals()
    candidates = [value]

    for _, child in iter_values(value):
        parsed = maybe_json(child)
        if parsed is not child:
            candidates.append(parsed)

    for candidate in candidates:
        if isinstance(candidate, list):
            for item in candidate:
                if isinstance(item, dict):
                    _inspect_tool_value(signals, item)
                    _inspect_creation_value(signals, item)
        elif isinstance(candidate, dict):
            _inspect_tool_value(signals, candidate)
            _inspect_creation_value(signals, candidate)
            verification_context = _extract_verification_context(candidate)
            if verification_context:
                _append_unique(signals["verification"], verification_context)
            direct_code = (
                candidate.get("fail_code")
                or candidate.get("ai_creation_res_code")
                or candidate.get("error_code")
            )
            direct_message = (
                candidate.get("fail_msg")
                or candidate.get("fail_message")
                or candidate.get("error_msg")
                or candidate.get("message")
                or candidate.get("msg")
            )
            if direct_code not in (None, "", 0, "0") and direct_message:
                failure = {
                    "code": str(direct_code),
                    "message": upstream_failure_message(direct_code, str(direct_message)),
                }
                if verification_context:
                    failure["verification"] = verification_context
                _append_unique(
                    signals["failures"],
                    failure,
                )

        for key, child in iter_values(candidate):
            key_lower = key.lower()
            if key_lower in TASK_KEYS and isinstance(child, (str, int)):
                task_id = str(child)
                if task_id and task_id not in signals["task_ids"]:
                    signals["task_ids"].append(task_id)
            if key_lower in CONVERSATION_KEYS and isinstance(child, (str, int)):
                conversation_id = str(child)
                if conversation_id and conversation_id not in signals["conversation_ids"]:
                    signals["conversation_ids"].append(conversation_id)
            if key_lower in VIDEO_ID_KEYS and isinstance(child, (str, int)):
                _record_video_id(signals, child)
            if key_lower in URL_KEYS and isinstance(child, str):
                if key_lower in DIRECT_VIDEO_URL_KEYS and child.startswith(("http://", "https://")):
                    _record_video_url(signals, child, key_lower)
                else:
                    match = VIDEO_URL_RE.search(child)
                    if match:
                        _record_video_url(signals, match.group(0), key_lower)
            if key_lower in DIRECT_VIDEO_URL_KEYS and isinstance(child, str):
                decoded_url = maybe_base64_url(child)
                if decoded_url:
                    _record_video_url(signals, decoded_url, key_lower)
            if key_lower in {"status", "task_status", "state"} and isinstance(child, (str, int)):
                signals["status"] = str(child)
            if key_lower in {"fail_code", "ai_creation_res_code", "error_code"} and isinstance(child, (str, int)):
                code = str(child)
                if code not in {"", "0"}:
                    failure = {"code": code, "message": _failure_message_for_code(code)}
                    verification_context = _extract_verification_context(candidate)
                    if verification_context:
                        failure["verification"] = verification_context
                        _append_unique(signals["verification"], verification_context)
                    _append_unique(signals["failures"], failure)
                    quota = video_quota_from_failure_code(code, failure["message"])
                    if quota:
                        _append_unique(signals["quota"], quota)
            if key_lower in {"error_msg", "message", "msg"} and isinstance(child, str):
                text = child.strip()
                if is_failure_text(text, key_lower):
                    failure = {"code": None, "message": text[:500]}
                    _append_unique(signals["failures"], failure)
            if isinstance(child, str):
                text = child.strip()
                _record_video_id(signals, text)
                quota = extract_video_quota_text(text)
                if quota:
                    _append_unique(signals["quota"], quota)
                if text[:1] not in "[{" and is_failure_text(text, key_lower):
                    failure = {"code": None, "message": text[:500]}
                    _append_unique(signals["failures"], failure)
                if _looks_like_video_intent(text):
                    signals["saw_video_intent"] = True
                for match in VIDEO_URL_RE.findall(child):
                    _record_video_url(signals, match, key_lower)
            if key_lower == "creation_block" and isinstance(child, dict):
                _inspect_creation_value(signals, child)
            if key_lower == "creations" and isinstance(child, list):
                _inspect_creation_value(signals, {"creations": child})
            if key_lower in {"ai_creation_tool_list", "tool_list"} and isinstance(child, list):
                for tool in child:
                    _inspect_tool_value(signals, tool)

    return signals


def empty_video_signals() -> Dict[str, Any]:
    return {
        "task_ids": [],
        "video_ids": [],
        "video_urls": [],
        "conversation_ids": [],
        "failures": [],
        "non_video_results": [],
        "quota": [],
        "verification": [],
        "status": None,
        "saw_video_intent": False,
    }


class VideoProvider:
    def __init__(self) -> None:
        self.tasks: Dict[str, Dict[str, Any]] = {}
        self.output_dir = Path(settings.VIDEO_OUTPUT_DIR)
        self.credential_manager: Optional[CredentialManager] = None
        self.playwright_manager: Optional[PlaywrightManager] = None
        self.manual_verification_manager = ManualVerificationManager.shared()
        self.client: Optional[httpx.AsyncClient] = None
        self._quota_refresh_task: Optional[asyncio.Task] = None
        self._quota_auto_refresh_task: Optional[asyncio.Task] = None
        self._quota_daily_reset_task: Optional[asyncio.Task] = None
        self._task_cleanup_task: Optional[asyncio.Task] = None
        self._quota_ensure_lock = asyncio.Lock()
        self._quota_refresh_semaphore: Optional[asyncio.Semaphore] = None
        self._quota_refresh_semaphore_limit: Optional[int] = None
        self._quota_refresh_active_count = 0
        self._frontend_stage_limiters: Dict[str, Dict[str, Any]] = {}
        self._video_submit_slots: Dict[int, tuple[Dict[str, Any], Dict[str, Any]]] = {}
        self._quota_auto_refresh_cursor = -1
        self._quota_unknown_refresh_last_at = time.time()
        self._quota_refresh_state: Dict[str, Any] = {
            "enabled": False,
            "in_progress": False,
            "interval_seconds": None,
            "timeout_seconds": None,
            "batch_size": None,
            "min_available_accounts": None,
            "unknown_refresh_interval_seconds": None,
            "started_at": None,
            "completed_at": None,
            "next_run_at": None,
            "last_error": None,
            "last_result": None,
            "requested_indexes": None,
        }

    async def initialize(self) -> None:
        self.output_dir.mkdir(parents=True, exist_ok=True)
        self.client = httpx.AsyncClient(timeout=settings.API_REQUEST_TIMEOUT, follow_redirects=True)
        self._task_cleanup_task = asyncio.create_task(self._video_task_cleanup_loop())
        if settings.VIDEO_PROVIDER == "doubao_web":
            if not settings.DOUBAO_COOKIES:
                logger.warning("Doubao video provider started without credentials; add a Doubao cookie before generating videos.")
                logger.info(f"Video provider initialized in {settings.VIDEO_PROVIDER} mode.")
                return
            await self.attach_credential_manager(
                CredentialManager.shared(),
                run_initial_refresh=bool(settings.DOUBAO_VIDEO_QUOTA_INITIAL_REFRESH),
            )
        logger.info(f"Video provider initialized in {settings.VIDEO_PROVIDER} mode.")

    async def attach_credential_manager(
        self,
        manager: CredentialManager,
        *,
        run_initial_refresh: bool = False,
    ) -> None:
        if settings.VIDEO_PROVIDER != "doubao_web":
            return
        if self.credential_manager is not manager:
            self.credential_manager = manager
            snapshot = manager.snapshot() if callable(getattr(manager, "snapshot", None)) else {}
            account_count = snapshot.get("account_count")
            if account_count is None:
                account_count = len(getattr(manager, "active_credentials", []) or [])
            logger.info(
                "Doubao video provider attached credential manager: "
                f"accounts={account_count}."
            )

        active_credentials = manager.active_credentials
        if not active_credentials:
            logger.warning("Doubao video credential manager is empty; quota refresh is idle.")
            return

        if not self.playwright_manager:
            self.playwright_manager = PlaywrightManager()
        await self.playwright_manager.initialize(active_credentials)
        self._ensure_quota_refresh_tasks(run_initial_refresh=run_initial_refresh)

    def _ensure_quota_refresh_tasks(self, *, run_initial_refresh: bool = False) -> None:
        self._quota_refresh_state.update(
            {
                "enabled": bool(settings.DOUBAO_VIDEO_QUOTA_AUTO_REFRESH),
                "interval_seconds": self._video_quota_refresh_interval(),
                "timeout_seconds": self._video_quota_refresh_timeout(),
                "batch_size": self._quota_auto_refresh_batch_size(),
                "min_available_accounts": self._quota_refresh_min_available_accounts(),
                "unknown_refresh_interval_seconds": self._quota_unknown_refresh_interval(),
                "next_reset_at": next_video_quota_reset_at(),
            }
        )
        if not self._quota_daily_reset_task or self._quota_daily_reset_task.done():
            self._quota_daily_reset_task = asyncio.create_task(self._daily_video_quota_reset_loop())
        if settings.DOUBAO_VIDEO_QUOTA_AUTO_REFRESH:
            if (
                run_initial_refresh
                and settings.DOUBAO_VIDEO_QUOTA_INITIAL_REFRESH
                and (not self._quota_refresh_task or self._quota_refresh_task.done())
            ):
                self._quota_refresh_task = asyncio.create_task(
                    self.refresh_stale_video_quotas(
                        confirmed_only=False,
                        limit=self._quota_auto_refresh_batch_size(),
                        rotate=True,
                    )
                )
                self._quota_refresh_task.add_done_callback(self._log_quota_refresh_result)
            elif run_initial_refresh:
                logger.info("Initial video quota refresh skipped; quota will be refreshed on schedule and on demand.")
            if not self._quota_auto_refresh_task or self._quota_auto_refresh_task.done():
                self._quota_auto_refresh_task = asyncio.create_task(self._auto_video_quota_refresh_loop())
        else:
            logger.info("Initial video quota refresh skipped; quota will be refreshed on demand.")

    async def close(self) -> None:
        if self._quota_refresh_task and not self._quota_refresh_task.done():
            self._quota_refresh_task.cancel()
            try:
                await self._quota_refresh_task
            except asyncio.CancelledError:
                pass
        if self._quota_daily_reset_task and not self._quota_daily_reset_task.done():
            self._quota_daily_reset_task.cancel()
            try:
                await self._quota_daily_reset_task
            except asyncio.CancelledError:
                pass
        if self._quota_auto_refresh_task and not self._quota_auto_refresh_task.done():
            self._quota_auto_refresh_task.cancel()
            try:
                await self._quota_auto_refresh_task
            except asyncio.CancelledError:
                pass
        if self._task_cleanup_task and not self._task_cleanup_task.done():
            self._task_cleanup_task.cancel()
            try:
                await self._task_cleanup_task
            except asyncio.CancelledError:
                pass
        if self.client:
            await self.client.aclose()
        if settings.VIDEO_PROVIDER == "doubao_web" and self.playwright_manager:
            await self.playwright_manager.close()

    @staticmethod
    def _log_quota_refresh_result(task: asyncio.Task) -> None:
        if task.cancelled():
            return
        try:
            result = task.result()
        except Exception as exc:
            logger.warning(f"Initial video quota refresh failed: {exc}")
            return
        logger.info(
            "Initial video quota refresh completed: "
            f"checked={result.get('checked_count', 0)}, "
            f"available={result.get('available_count', 0)}, "
            f"exhausted={result.get('exhausted_count', 0)}, "
            f"unknown={result.get('unknown_count', 0)}"
        )

    async def _daily_video_quota_reset_loop(self) -> None:
        while True:
            reset_at = next_video_quota_reset_at()
            delay = max(1.0, reset_at - time.time() + 1.0)
            try:
                await asyncio.sleep(delay)
                if not self.credential_manager:
                    continue
                reset_indexes = await self.credential_manager.reset_expired_video_quotas()
                if reset_indexes:
                    logger.info(
                        "Daily Doubao video quota reset restored credential indexes="
                        f"{reset_indexes}."
                    )
                    if settings.DOUBAO_VIDEO_QUOTA_AUTO_REFRESH:
                        await self.refresh_stale_video_quotas(
                            confirmed_only=False,
                            limit=self._quota_auto_refresh_batch_size(),
                            rotate=True,
                        )
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                logger.warning(f"Daily Doubao video quota reset failed: {exc}")
                await asyncio.sleep(60)

    async def _auto_video_quota_refresh_loop(self) -> None:
        interval = self._video_quota_refresh_interval()
        self._quota_refresh_state["interval_seconds"] = interval
        self._quota_refresh_state["batch_size"] = self._quota_auto_refresh_batch_size()
        self._quota_refresh_state["min_available_accounts"] = self._quota_refresh_min_available_accounts()
        self._quota_refresh_state["unknown_refresh_interval_seconds"] = self._quota_unknown_refresh_interval()
        while True:
            try:
                self._quota_refresh_state["next_run_at"] = time.time() + interval
                await asyncio.sleep(interval)
                self._quota_refresh_state["next_run_at"] = None
                if self._has_active_video_tasks():
                    logger.info("Automatic Doubao video quota refresh skipped while video tasks are active.")
                    continue
                refresh_plan = self._auto_quota_refresh_plan()
                if refresh_plan.get("skip"):
                    self._quota_refresh_state.update(
                        {
                            "completed_at": time.time(),
                            "last_error": None,
                            "last_result": {
                                "checked_count": 0,
                                "available_count": 0,
                                "exhausted_count": 0,
                                "unknown_count": 0,
                                "skipped": True,
                                "mode": refresh_plan["mode"],
                                "confirmed_count": refresh_plan["confirmed_count"],
                            },
                            "requested_indexes": [],
                        }
                    )
                    continue
                result = await self.refresh_stale_video_quotas(
                    confirmed_only=refresh_plan["confirmed_only"],
                    limit=refresh_plan["limit"],
                    rotate=refresh_plan["rotate"],
                )
                if result.get("checked_count"):
                    logger.info(
                        "Automatic Doubao video quota refresh completed: "
                        f"checked={result.get('checked_count', 0)}, "
                        f"available={result.get('available_count', 0)}, "
                        f"exhausted={result.get('exhausted_count', 0)}, "
                        f"unknown={result.get('unknown_count', 0)}, "
                        f"mode={refresh_plan['mode']}, "
                        f"confirmed={refresh_plan['confirmed_count']}"
                    )
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                self._quota_refresh_state["last_error"] = str(exc)
                logger.warning(f"Automatic Doubao video quota refresh failed: {exc}")

    def _has_active_video_tasks(self) -> bool:
        return any(
            str(task.get("status") or "").lower() in {"queued", "running"}
            for task in self.tasks.values()
        )

    async def _video_task_cleanup_loop(self) -> None:
        interval = max(10.0, float(settings.VIDEO_TASK_CLEANUP_INTERVAL_SECONDS or 300))
        while True:
            try:
                await asyncio.sleep(interval)
                removed = self.cleanup_video_tasks()
                if removed:
                    logger.info(f"Cleaned {removed} retained video task records from memory.")
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                logger.warning(f"Video task cleanup failed: {exc}")

    def cleanup_video_tasks(self) -> int:
        now = time.time()
        retention = max(1.0, float(settings.VIDEO_TASK_RETENTION_SECONDS or 3600))
        max_retained = max(1, int(settings.VIDEO_TASK_MAX_RETAINED or 500))
        terminal_statuses = {"succeeded", "failed", "cancelled"}
        active_statuses = {"queued", "running", "polling", "submitted"}

        removable: list[tuple[float, str]] = []
        retained_terminal: list[tuple[float, str]] = []
        for task_id, task in self.tasks.items():
            status = str(task.get("status") or "").lower()
            if status in active_statuses or status not in terminal_statuses:
                continue
            finished_at = self._task_finished_at(task)
            retained_terminal.append((finished_at, task_id))
            if now - finished_at >= retention:
                removable.append((finished_at, task_id))

        if len(retained_terminal) - len(removable) > max_retained:
            removable_ids = {task_id for _, task_id in removable}
            overflow = len(retained_terminal) - len(removable) - max_retained
            for _, task_id in sorted(retained_terminal)[:overflow]:
                if task_id not in removable_ids:
                    removable.append((0.0, task_id))
                    removable_ids.add(task_id)

        removed = 0
        for _, task_id in removable:
            if self.tasks.pop(task_id, None) is not None:
                removed += 1
        return removed

    @staticmethod
    def _task_finished_at(task: Dict[str, Any]) -> float:
        for key in ("completed_at", "updated_at", "created"):
            value = task.get(key)
            if value is not None:
                try:
                    return float(value)
                except (TypeError, ValueError):
                    continue
        return 0.0

    @staticmethod
    def _mark_task_terminal(task: Dict[str, Any]) -> None:
        timestamp = time.time()
        task["completed_at"] = timestamp
        task["updated_at"] = timestamp

    def quota_refresh_status(self) -> Dict[str, Any]:
        status = dict(self._quota_refresh_state)
        status.update(
            {
                "enabled": bool(settings.DOUBAO_VIDEO_QUOTA_AUTO_REFRESH),
                "interval_seconds": self._video_quota_refresh_interval(),
                "timeout_seconds": self._video_quota_refresh_timeout(),
                "batch_size": self._quota_auto_refresh_batch_size(),
                "min_available_accounts": self._quota_refresh_min_available_accounts(),
                "unknown_refresh_interval_seconds": self._quota_unknown_refresh_interval(),
                "allow_unknown_quota_on_generate": bool(settings.DOUBAO_VIDEO_ALLOW_UNKNOWN_QUOTA_ON_GENERATE),
                "initial_refresh_running": bool(
                    self._quota_refresh_task and not self._quota_refresh_task.done()
                ),
                "auto_refresh_running": bool(
                    self._quota_auto_refresh_task and not self._quota_auto_refresh_task.done()
                ),
                "daily_reset_running": bool(
                    self._quota_daily_reset_task and not self._quota_daily_reset_task.done()
                ),
                "next_reset_at": next_video_quota_reset_at(),
            }
        )
        return status

    @staticmethod
    def _video_quota_refresh_interval() -> float:
        return max(5.0, float(settings.DOUBAO_VIDEO_QUOTA_REFRESH_INTERVAL_SECONDS or 30))

    @staticmethod
    def _quota_auto_refresh_batch_size() -> int:
        return max(1, int(settings.DOUBAO_VIDEO_QUOTA_REFRESH_BATCH_SIZE or 1))

    @staticmethod
    def _quota_refresh_min_available_accounts() -> int:
        return max(1, int(settings.DOUBAO_VIDEO_QUOTA_REFRESH_MIN_AVAILABLE_ACCOUNTS or 3))

    @staticmethod
    def _quota_unknown_refresh_interval() -> float:
        return max(30.0, float(settings.DOUBAO_VIDEO_QUOTA_UNKNOWN_REFRESH_INTERVAL_SECONDS or 600))

    @staticmethod
    def _quota_auto_refresh_required_quota() -> float:
        return max(1.0, float(settings.DOUBAO_VIDEO_QUOTA_COST or 1))

    def _confirmed_video_quota_count(self, required_quota: Optional[float] = None) -> int:
        if not self.credential_manager:
            return 0
        required = self._quota_auto_refresh_required_quota() if required_quota is None else required_quota
        return sum(
            self._account_has_video_quota(account, required)
            for account in self.credential_manager.snapshot().get("accounts") or []
        )

    def _auto_quota_refresh_plan(self) -> Dict[str, Any]:
        now = time.time()
        batch_size = self._quota_auto_refresh_batch_size()
        confirmed_count = self._confirmed_video_quota_count()
        min_available = self._quota_refresh_min_available_accounts()
        unknown_due = now - self._quota_unknown_refresh_last_at >= self._quota_unknown_refresh_interval()

        if confirmed_count < min_available:
            self._quota_unknown_refresh_last_at = now
            return {
                "skip": False,
                "confirmed_only": False,
                "limit": batch_size,
                "rotate": True,
                "mode": "low_confirmed_quota",
                "confirmed_count": confirmed_count,
            }
        if unknown_due:
            self._quota_unknown_refresh_last_at = now
            return {
                "skip": False,
                "confirmed_only": False,
                "limit": 1,
                "rotate": True,
                "mode": "periodic_unknown_probe",
                "confirmed_count": confirmed_count,
            }
        return {
            "skip": True,
            "confirmed_only": True,
            "limit": 0,
            "rotate": False,
            "mode": "healthy_confirmed_quota",
            "confirmed_count": confirmed_count,
        }

    @staticmethod
    def _video_quota_refresh_timeout() -> float:
        return max(5.0, float(settings.DOUBAO_VIDEO_QUOTA_REFRESH_TIMEOUT_SECONDS or 30))

    def _shared_quota_refresh_semaphore(self) -> asyncio.Semaphore:
        limit = max(1, int(settings.DOUBAO_VIDEO_QUOTA_REFRESH_CONCURRENCY or 1))
        if self._quota_refresh_semaphore is None or self._quota_refresh_semaphore_limit != limit:
            self._quota_refresh_semaphore = asyncio.Semaphore(limit)
            self._quota_refresh_semaphore_limit = limit
        return self._quota_refresh_semaphore

    @staticmethod
    def _frontend_stage_limit(stage: str) -> int:
        if stage == "video_submit":
            return max(1, int(settings.DOUBAO_VIDEO_SUBMIT_CONCURRENCY or 15))
        if stage == "verification_submit":
            return max(1, int(settings.DOUBAO_FRONTEND_SUBMIT_CONCURRENCY or 5))
        if stage == "result_wait":
            return max(1, int(settings.DOUBAO_FRONTEND_RESULT_WAIT_CONCURRENCY or 20))
        raise ValueError(f"Unknown frontend stage: {stage}")

    def _frontend_stage_limiter(self, stage: str) -> Dict[str, Any]:
        limit = self._frontend_stage_limit(stage)
        state = self._frontend_stage_limiters.get(stage)
        if state is None:
            state = {
                "limit": limit,
                "semaphore": asyncio.Semaphore(limit),
                "active": 0,
                "waiting": 0,
                "peak_active": 0,
                "total_acquired": 0,
            }
            self._frontend_stage_limiters[stage] = state
        elif state["limit"] != limit and not state["active"] and not state["waiting"]:
            state.update(
                {
                    "limit": limit,
                    "semaphore": asyncio.Semaphore(limit),
                    "peak_active": 0,
                    "total_acquired": 0,
                }
            )
        return state

    def frontend_queue_status(self) -> Dict[str, Any]:
        result: Dict[str, Any] = {}
        for stage in ("video_submit", "verification_submit", "result_wait"):
            state = self._frontend_stage_limiter(stage)
            result[stage] = {
                key: state[key]
                for key in ("limit", "active", "waiting", "peak_active", "total_acquired")
            }
        return result

    async def _acquire_frontend_stage(
        self,
        stage: str,
        recovery: Dict[str, Any],
    ) -> tuple[Dict[str, Any], Dict[str, Any]]:
        state = self._frontend_stage_limiter(stage)
        queued_at = time.time()
        state["waiting"] += 1
        try:
            await state["semaphore"].acquire()
        finally:
            state["waiting"] = max(0, state["waiting"] - 1)
        acquired_at = time.time()
        state["active"] += 1
        state["peak_active"] = max(state["peak_active"], state["active"])
        state["total_acquired"] += 1
        slot = {
            "stage": stage,
            "limit": state["limit"],
            "queued_at": queued_at,
            "acquired_at": acquired_at,
            "queue_wait_seconds": round(max(0.0, acquired_at - queued_at), 3),
            "active_at_acquire": state["active"],
        }
        recovery[f"frontend_{stage}_slot"] = slot
        logger.info(
            f"Frontend {stage} slot acquired for account #{recovery.get('account_index')}: "
            f"active={state['active']}/{state['limit']}, waiting={state['waiting']}, "
            f"queued={slot['queue_wait_seconds']}s."
        )
        return state, slot

    @staticmethod
    def _release_frontend_stage(
        state: Dict[str, Any],
        slot: Dict[str, Any],
    ) -> None:
        state["active"] = max(0, state["active"] - 1)
        state["semaphore"].release()
        released_at = time.time()
        slot["released_at"] = released_at
        slot["held_seconds"] = round(max(0.0, released_at - slot["acquired_at"]), 3)

    async def _complete_doubao_web_segment_with_submit_slot(
        self,
        task: Dict[str, Any],
        request_data: Dict[str, Any],
        log_task_id: str,
        cookie: str,
    ) -> Dict[str, Any]:
        queue_debug = task.setdefault("debug", {}).setdefault("frontend_queues", {})
        queue_debug["account_index"] = task.get("credential_index")
        state, slot = await self._acquire_frontend_stage("video_submit", queue_debug)
        self._video_submit_slots[id(task)] = (state, slot)
        try:
            return await self._complete_doubao_web_segment_with_cookie(
                task,
                request_data,
                log_task_id,
                cookie,
            )
        finally:
            self._release_video_submit_slot(task)

    def _release_video_submit_slot(self, task: Dict[str, Any]) -> None:
        acquired = self._video_submit_slots.pop(id(task), None)
        if not acquired:
            return
        state, slot = acquired
        if "released_at" not in slot:
            self._release_frontend_stage(state, slot)

    def _begin_quota_refresh(self, requested: Optional[set[int]]) -> None:
        self._quota_refresh_active_count += 1
        self._quota_refresh_state.update(
            {
                "enabled": bool(settings.DOUBAO_VIDEO_QUOTA_AUTO_REFRESH),
                "in_progress": True,
                "started_at": time.time(),
                "completed_at": None,
                "last_error": None,
                "requested_indexes": sorted(requested) if requested is not None else None,
            }
        )

    def _finish_quota_refresh(
        self,
        *,
        requested: Optional[set[int]],
        result: Optional[Dict[str, Any]] = None,
        error: Optional[BaseException] = None,
    ) -> None:
        self._quota_refresh_active_count = max(0, self._quota_refresh_active_count - 1)
        updates: Dict[str, Any] = {
            "in_progress": self._quota_refresh_active_count > 0,
            "completed_at": time.time(),
            "requested_indexes": sorted(requested) if requested is not None else None,
        }
        if error is not None:
            updates["last_error"] = str(error)
        else:
            updates["last_error"] = None
        if result is not None:
            updates["last_result"] = {
                key: result.get(key, 0)
                for key in ("checked_count", "available_count", "exhausted_count", "unknown_count")
            }
        self._quota_refresh_state.update(updates)

    async def refresh_account_video_quota(self, index: int) -> Dict[str, Any]:
        if not self.credential_manager or not self.playwright_manager:
            raise RuntimeError("doubao_web provider is not initialized.")

        timeout = self._video_quota_refresh_timeout()
        try:
            return await asyncio.wait_for(
                self._refresh_account_video_quota(index),
                timeout=timeout,
            )
        except asyncio.TimeoutError:
            message = f"Video quota refresh timed out after {timeout:g}s."
            account = await self.credential_manager.mark_quota_error(index, message, source="video_history")
            return {
                "account": account,
                "supported": True,
                "found": False,
                "source": "video_history",
                "checked_conversations": 0,
                "message": message,
            }

    async def _refresh_account_video_quota(self, index: int) -> Dict[str, Any]:
        cookie = await self.credential_manager.get_cookie(index)
        timeout = self._video_quota_refresh_timeout()
        try:
            recent_response = await self.playwright_manager.post_json(
                "https://www.doubao.com/im/chain/recent_conv",
                cookie,
                self._history_base_params(),
                self._prepare_recent_conversation_payload(),
                headers=self._prepare_history_headers(),
                timeout_seconds=timeout,
            )
            recent_data = self._browser_json_response(recent_response, "recent conversation history")
            candidates = self._video_history_candidates(recent_data)
            checked_conversations = 0

            for conversation in candidates:
                conversation_id = conversation["conversation_id"]
                chain_response = await self.playwright_manager.post_json(
                    "https://www.doubao.com/im/chain/single",
                    cookie,
                    self._history_base_params(),
                    self._prepare_chain_payload(conversation_id),
                    headers=self._prepare_history_headers(),
                    timeout_seconds=timeout,
                )
                chain_data = self._browser_json_response(chain_response, "conversation history")
                checked_conversations += 1
                signals = extract_video_signals(chain_data)
                quota = self._latest_quota_signal(signals.get("quota") or [])
                if not quota:
                    continue

                remaining = quota.get("remaining")
                message = str(quota.get("message") or "")
                if quota.get("exhausted") or (remaining is not None and float(remaining) <= 0):
                    account = await self.credential_manager.disable_for_quota_exhausted(
                        index,
                        message or "Doubao daily video generation limit reached.",
                        source="video_history",
                    )
                else:
                    account = await self.credential_manager.update_quota(
                        index,
                        total=quota.get("total"),
                        remaining=remaining,
                        used=quota.get("used"),
                        unit=quota.get("unit") or settings.DOUBAO_QUOTA_UNIT,
                        source="video_history",
                        status="available",
                        error=None,
                    )
                return {
                    "account": account,
                    "supported": True,
                    "found": True,
                    "source": "video_history",
                    "conversation_id": conversation_id,
                    "conversation_title": conversation.get("title"),
                    "conversation_updated_at": conversation.get("updated_at"),
                    "checked_conversations": checked_conversations,
                    "message": "Video quota synchronized from today's Doubao conversation history.",
                }

            account = self.credential_manager.snapshot()["accounts"][index]
            if (account.get("quota") or {}).get("status") not in {
                "available",
                "estimated",
                "exhausted",
                "pending_refresh",
            }:
                account = await self.credential_manager.update_quota(
                    index,
                    unit=settings.DOUBAO_QUOTA_UNIT,
                    source="video_history",
                    status="unknown",
                    error="No current-day video quota signal was found in Doubao conversation history.",
                )
            return {
                "account": account,
                "supported": True,
                "found": False,
                "source": "video_history",
                "checked_conversations": checked_conversations,
                "message": "No current-day video quota signal was found in Doubao conversation history.",
            }
        except Exception as exc:
            message = f"Unable to refresh video quota from Doubao history: {exc}"
            account = self.credential_manager.snapshot()["accounts"][index]
            if (account.get("quota") or {}).get("status") != "pending_refresh":
                account = await self.credential_manager.mark_quota_error(index, message, source="video_history")
            return {
                "account": account,
                "supported": True,
                "found": False,
                "source": "video_history",
                "checked_conversations": 0,
                "message": message,
            }
        finally:
            close_account_session = getattr(self.playwright_manager, "close_account_session", None)
            if close_account_session:
                with suppress(Exception):
                    await close_account_session(cookie)

    async def refresh_video_quotas(self, indexes: Optional[Iterable[int]] = None) -> Dict[str, Any]:
        if not self.credential_manager:
            raise RuntimeError("doubao_web provider is not initialized.")

        requested = set(int(index) for index in indexes) if indexes is not None else None
        self._begin_quota_refresh(requested)
        try:
            await self.credential_manager.reset_expired_video_quotas()
            accounts = self.credential_manager.snapshot().get("accounts") or []
            target_indexes = [
                int(account["index"])
                for account in accounts
                if (requested is None or int(account["index"]) in requested)
                and account.get("status") not in {"disabled", "login_required"}
                and (requested is not None or account.get("status") == "available")
                and not (
                    requested is None
                    and self._quota_refresh_should_skip_for_today(account.get("quota") or {}, time.time())
                )
            ]
            concurrency = max(1, int(settings.DOUBAO_VIDEO_QUOTA_REFRESH_CONCURRENCY or 1))
            semaphore = self._shared_quota_refresh_semaphore()

            async def refresh(index: int) -> Dict[str, Any]:
                async with semaphore:
                    return await self.refresh_account_video_quota(index)

            results = []
            for offset in range(0, len(target_indexes), concurrency):
                batch = target_indexes[offset : offset + concurrency]
                results.extend(await asyncio.gather(*(refresh(index) for index in batch)))

            statuses = [
                str(((result.get("account") or {}).get("quota") or {}).get("status") or "unknown")
                for result in results
            ]
            result = {
                "checked_count": len(results),
                "available_count": sum(status in {"available", "estimated"} for status in statuses),
                "exhausted_count": sum(status == "exhausted" for status in statuses),
                "unknown_count": sum(
                    status not in {"available", "estimated", "exhausted"} for status in statuses
                ),
                "results": results,
            }
        except Exception as exc:
            self._finish_quota_refresh(requested=requested, error=exc)
            raise

        self._finish_quota_refresh(requested=requested, result=result)
        return result

    async def refresh_stale_video_quotas(
        self,
        *,
        confirmed_only: bool = False,
        limit: Optional[int] = None,
        rotate: bool = False,
    ) -> Dict[str, Any]:
        if not self.credential_manager:
            raise RuntimeError("doubao_web provider is not initialized.")

        await self.credential_manager.reset_expired_video_quotas()
        accounts = self.credential_manager.snapshot().get("accounts") or []
        now = time.time()
        max_age = float(settings.DOUBAO_VIDEO_QUOTA_MAX_AGE_SECONDS or 300)
        target_indexes = []
        for account in accounts:
            if account.get("status") != "available":
                continue
            quota = account.get("quota") if isinstance(account.get("quota"), dict) else {}
            status = str(quota.get("status") or "unknown")
            if status == "exhausted":
                continue
            if confirmed_only and status not in {"available", "estimated", "pending_refresh"}:
                continue
            updated_at = quota.get("updated_at")
            if self._quota_refresh_should_skip_for_today(quota, now):
                continue
            stale = True
            if updated_at is not None:
                try:
                    stale = now - float(updated_at) > max_age
                except (TypeError, ValueError):
                    stale = True
            if status not in {"available", "estimated"} or stale:
                target_indexes.append(int(account["index"]))

        target_indexes = sorted(set(target_indexes))
        if limit is not None:
            refresh_limit = max(1, int(limit))
            if rotate:
                target_indexes = self._select_quota_refresh_batch(target_indexes, refresh_limit)
            else:
                target_indexes = target_indexes[:refresh_limit]

        if not target_indexes:
            return {
                "checked_count": 0,
                "available_count": 0,
                "exhausted_count": 0,
                "unknown_count": 0,
                "results": [],
            }
        return await self.refresh_video_quotas(target_indexes)

    def _select_quota_refresh_batch(self, indexes: Iterable[int], limit: int) -> list[int]:
        ordered = sorted(set(int(index) for index in indexes))
        if len(ordered) <= limit:
            batch = ordered
        else:
            after_cursor = [index for index in ordered if index > self._quota_auto_refresh_cursor]
            before_cursor = [index for index in ordered if index <= self._quota_auto_refresh_cursor]
            batch = (after_cursor + before_cursor)[:limit]
        if batch:
            self._quota_auto_refresh_cursor = batch[-1]
        return batch

    @staticmethod
    def _quota_refresh_should_skip_for_today(quota: Dict[str, Any], now: Optional[float] = None) -> bool:
        status = str(quota.get("status") or "unknown")
        source = str(quota.get("source") or "")
        error = str(quota.get("last_error") or quota.get("error") or "")
        updated_at = quota.get("updated_at")
        if status != "unknown" or source != "video_history" or not updated_at:
            return False
        if VIDEO_HISTORY_NO_SIGNAL_MARKER not in error:
            return False
        try:
            return video_quota_day(float(updated_at)) == video_quota_day(time.time() if now is None else now)
        except (TypeError, ValueError):
            return False

    @staticmethod
    def _account_has_video_quota(account: Dict[str, Any], required_quota: float) -> bool:
        quota = account.get("quota") or {}
        remaining = quota.get("remaining")
        return (
            account.get("status") == "available"
            and quota.get("status") in {"available", "estimated"}
            and remaining is not None
            and float(remaining) >= required_quota
        )

    @staticmethod
    def _account_allows_provisional_video_quota(
        account: Dict[str, Any],
        now: Optional[float] = None,
        allowed_statuses: Optional[set[str]] = None,
    ) -> bool:
        allowed_statuses = {"available"} if allowed_statuses is None else allowed_statuses
        if account.get("status") not in allowed_statuses:
            return False
        quota = account.get("quota") if isinstance(account.get("quota"), dict) else {}
        if str(quota.get("source") or "") != "video_history":
            return False
        error = str(quota.get("last_error") or quota.get("error") or "")
        quota_status = str(quota.get("status") or "")
        if quota_status == "unknown":
            expected_error = VIDEO_HISTORY_NO_SIGNAL_MARKER in error
        elif quota_status == "pending_refresh":
            expected_error = "timed out" in error.lower()
        else:
            return False
        if not expected_error:
            return False
        updated_at = quota.get("updated_at")
        if not updated_at:
            return False
        try:
            return video_quota_day(float(updated_at)) == video_quota_day(time.time() if now is None else now)
        except (TypeError, ValueError):
            return False

    @staticmethod
    def _merge_quota_refresh_results(target: Dict[str, Any], result: Dict[str, Any]) -> None:
        for key in ("checked_count", "available_count", "exhausted_count", "unknown_count"):
            target[key] += int(result.get(key) or 0)
        target["results"].extend(result.get("results") or [])

    async def _refresh_until_video_quota(
        self,
        indexes: Iterable[int],
        required_quota: float,
    ) -> Dict[str, Any]:
        result: Dict[str, Any] = {
            "checked_count": 0,
            "available_count": 0,
            "exhausted_count": 0,
            "unknown_count": 0,
            "results": [],
        }
        for index in indexes:
            refreshed = await self.refresh_video_quotas([index])
            self._merge_quota_refresh_results(result, refreshed)
            accounts = self.credential_manager.snapshot().get("accounts") or []
            account = next((item for item in accounts if int(item["index"]) == int(index)), None)
            if account and self._account_has_video_quota(account, required_quota):
                break
        return result

    async def ensure_video_quota(
        self,
        required_quota: float,
        *,
        probe_unknown: Optional[bool] = None,
    ) -> Dict[str, Any]:
        if not self.credential_manager or required_quota <= 0:
            return {"refreshed": False, "eligible": True}

        if probe_unknown is None:
            probe_unknown = bool(settings.DOUBAO_VIDEO_ALLOW_UNKNOWN_QUOTA_ON_GENERATE)

        async with self._quota_ensure_lock:
            await self.credential_manager.reset_expired_video_quotas()
            now = time.time()
            accounts = self.credential_manager.snapshot().get("accounts") or []
            eligible_count = sum(self._account_has_video_quota(account, required_quota) for account in accounts)
            if eligible_count:
                return {
                    "refreshed": False,
                    "eligible": True,
                    "eligible_count": eligible_count,
                    "provisional_allowed": bool(probe_unknown),
                }

            refresh_result: Dict[str, Any] = {
                "checked_count": 0,
                "available_count": 0,
                "exhausted_count": 0,
                "unknown_count": 0,
                "results": [],
            }
            if self._quota_refresh_task and not self._quota_refresh_task.done():
                self._merge_quota_refresh_results(refresh_result, await self._quota_refresh_task)
                accounts = self.credential_manager.snapshot().get("accounts") or []
                eligible_count = sum(
                    self._account_has_video_quota(account, required_quota) for account in accounts
                )
                if eligible_count:
                    return {
                        "refreshed": True,
                        "eligible": True,
                        "eligible_count": eligible_count,
                        "provisional_allowed": bool(probe_unknown),
                        **refresh_result,
                    }

            now = time.time()
            accounts = self.credential_manager.snapshot().get("accounts") or []
            provisional_count = sum(
                self._account_allows_provisional_video_quota(account, now)
                for account in accounts
            )
            if not probe_unknown:
                return {
                    "refreshed": bool(refresh_result.get("checked_count")),
                    "eligible": False,
                    "eligible_count": 0,
                    "provisional": provisional_count > 0,
                    "provisional_allowed": False,
                    "provisional_count": provisional_count,
                    **refresh_result,
                }

            candidate_indexes = [
                int(account["index"])
                for account in accounts
                if account.get("status") == "available"
                and (account.get("quota") or {}).get("status") != "exhausted"
                and not self._quota_refresh_should_skip_for_today(account.get("quota") or {}, now)
                and (
                    (account.get("quota") or {}).get("status") not in {"available", "estimated"}
                    or now - float((account.get("quota") or {}).get("updated_at") or 0)
                    > settings.DOUBAO_VIDEO_QUOTA_MAX_AGE_SECONDS
                )
            ]
            candidate_indexes = candidate_indexes[: settings.DOUBAO_VIDEO_ACCOUNT_RETRY_LIMIT]
            selective_result = await self._refresh_until_video_quota(candidate_indexes, required_quota)
            self._merge_quota_refresh_results(refresh_result, selective_result)

            accounts = self.credential_manager.snapshot().get("accounts") or []
            eligible_count = sum(
                self._account_has_video_quota(account, required_quota) for account in accounts
            )
            provisional_count = sum(
                self._account_allows_provisional_video_quota(account, time.time())
                for account in accounts
            )
            return {
                "refreshed": True,
                "eligible": eligible_count > 0,
                "eligible_count": eligible_count,
                "provisional": eligible_count <= 0 and provisional_count > 0,
                "provisional_allowed": bool(probe_unknown and provisional_count > 0),
                "provisional_count": provisional_count,
                **refresh_result,
            }

    @staticmethod
    def _browser_json_response(response: Dict[str, Any], operation: str) -> Dict[str, Any]:
        status_code = int(response.get("status_code") or 0)
        text = str(response.get("text") or "")
        if status_code != 200:
            raise RuntimeError(f"Doubao {operation} returned HTTP {status_code}: {text[:300]}")
        try:
            data = json.loads(text)
        except json.JSONDecodeError as exc:
            raise RuntimeError(f"Doubao {operation} returned invalid JSON.") from exc
        if not isinstance(data, dict):
            raise RuntimeError(f"Doubao {operation} returned an unexpected payload.")
        return data

    @staticmethod
    def _prepare_recent_conversation_payload() -> Dict[str, Any]:
        return {
            "cmd": 3200,
            "uplink_body": {
                "pull_recent_conv_chain_uplink_body": {
                    "limit": max(50, settings.DOUBAO_VIDEO_QUOTA_HISTORY_CONVERSATIONS),
                    "message_count_per_conv": 10,
                    "api_version": 1,
                    "conv_version": 0,
                    "direction": 3,
                    "option": {
                        "not_need_message": True,
                        "need_complete_conversation": True,
                        "need_coco_conversation": True,
                        "need_coco_bot": True,
                        "need_pc_pin_chain": True,
                        "pc_pin_query_type": 0,
                    },
                }
            },
            "sequence_id": str(uuid.uuid4()),
            "channel": 2,
            "version": "1",
        }

    @staticmethod
    def _video_history_candidates(payload: Dict[str, Any]) -> list[Dict[str, Any]]:
        cells = (
            ((payload.get("downlink_body") or {}).get("pull_recent_conv_chain_downlink_body") or {}).get("cells")
            or []
        )
        today = datetime.now(SHANGHAI_TIMEZONE).date()
        candidates = []
        for cell in cells:
            if not isinstance(cell, dict):
                continue
            conversation = cell.get("conversation") or {}
            conversation_id = str(conversation.get("conversation_id") or "")
            title = str(conversation.get("name") or "")
            try:
                updated_at = int(conversation.get("update_time") or conversation.get("create_time") or 0)
            except (TypeError, ValueError):
                updated_at = 0
            if not conversation_id or not updated_at:
                continue
            if datetime.fromtimestamp(updated_at, SHANGHAI_TIMEZONE).date() != today:
                continue
            candidates.append(
                {
                    "conversation_id": conversation_id,
                    "title": title,
                    "updated_at": updated_at,
                    "video_title": any(marker.lower() in title.lower() for marker in VIDEO_HISTORY_TITLE_MARKERS),
                }
            )
        candidates.sort(key=lambda item: (item["updated_at"], item["video_title"]), reverse=True)
        return candidates[: settings.DOUBAO_VIDEO_QUOTA_HISTORY_CONVERSATIONS]

    @staticmethod
    def _latest_quota_signal(quota_items: Iterable[Any]) -> Optional[Dict[str, Any]]:
        usable = [
            quota
            for quota in quota_items
            if isinstance(quota, dict)
            and (quota.get("remaining") is not None or quota.get("exhausted"))
        ]
        return usable[-1] if usable else None

    async def create_generation(self, request_data: Dict[str, Any], base_url: str) -> JSONResponse:
        model = request_data.get("model", settings.DEFAULT_VIDEO_MODEL)
        model_mapping = self._model_mapping()
        if model not in model_mapping:
            raise HTTPException(status_code=400, detail=f"Unsupported video model: {model}")

        prompt = normalize_prompt_text(request_data.get("prompt"))
        if not prompt:
            raise HTTPException(status_code=400, detail="Field 'prompt' is required.")

        reference_image = self._extract_reference_image(request_data)
        reference_image_meta = self._reference_image_meta(reference_image)
        params = self._normalize_video_params(request_data, model)
        task_id = f"vid-{uuid.uuid4().hex}"
        now = int(time.time())
        self.tasks[task_id] = {
            "id": task_id,
            "object": "video.generation",
            "created": now,
            "model": model,
            "status": "queued",
            "prompt": prompt,
            "params": params,
            "reference_image": reference_image,
            "source_reference_image": reference_image,
            "reference_image_meta": reference_image_meta,
            "error": None,
            "result": None,
            "debug": {"events": [], "signals": empty_video_signals()},
        }
        if self._is_long_form_params(params):
            self.tasks[task_id]["long_form"] = self._long_form_plan(params)

        if self.tasks[task_id].get("long_form"):
            asyncio.create_task(self._complete_long_form_task(task_id, request_data, base_url.rstrip("/")))
        elif settings.VIDEO_PROVIDER == "mock":
            asyncio.create_task(self._complete_mock_task(task_id, base_url.rstrip("/")))
        else:
            asyncio.create_task(self._complete_doubao_web_task(task_id, request_data, base_url.rstrip("/")))
        return JSONResponse(status_code=202, content=self._public_task(self.tasks[task_id]))

    async def get_generation(self, task_id: str) -> JSONResponse:
        task = self._get_task(task_id)
        return JSONResponse(content=self._public_task(task))

    async def get_video_response(self, task_id: str):
        task = self.tasks.get(task_id)
        if not task:
            cached_path = self.output_dir / f"{task_id}.mp4"
            if cached_path.is_file():
                return cached_path
            task = self._get_task(task_id)
        if task["status"] != "succeeded" or not task["result"]:
            raise HTTPException(status_code=409, detail=f"Video task is {task['status']}.")

        result = task["result"]
        if result.get("file_path"):
            return Path(result["file_path"])
        if result.get("upstream_url"):
            return result["upstream_url"]
        raise HTTPException(status_code=404, detail="Generated video content is missing.")

    async def upload_reference_image_from_request(self, request_data: Dict[str, Any]) -> JSONResponse:
        reference_image = self._extract_reference_image(request_data)
        if not reference_image:
            raise HTTPException(status_code=400, detail="reference_image, data, or path is required.")

        if reference_image.get("file_key"):
            uploaded = self._normalize_attachment_state(reference_image, 0)
            uploaded["kind"] = "doubao_uploaded"
            return JSONResponse(content={"object": "video.upload", "data": uploaded})

        if settings.VIDEO_PROVIDER == "mock":
            uploaded = self._mock_uploaded_reference_image(reference_image)
        else:
            uploaded = await self._upload_reference_image_to_doubao(reference_image)
        return JSONResponse(content={"object": "video.upload", "data": uploaded})

    async def _complete_mock_task(self, task_id: str, base_url: str) -> None:
        await asyncio.sleep(settings.VIDEO_TASK_DELAY_SECONDS)
        task = self.tasks.get(task_id)
        if not task:
            return

        try:
            await self._complete_mock_segment(task, task_id, base_url, self.output_dir / f"{task_id}.mp4")
            logger.info(f"Mock video generation completed: {task_id}")
        except Exception as exc:
            self._fail_task(task, exc, "Mock video generation failed")

    async def _complete_mock_segment(self, task: Dict[str, Any], task_id: str, base_url: str, path: Path) -> Dict[str, Any]:
        path.parent.mkdir(parents=True, exist_ok=True)
        width, height = preview_dimensions(task["params"]["width"], task["params"]["height"])
        write_mock_mp4(path, task["prompt"], task_id, width, height, task.get("reference_image"))
        result = {
            "url": f"{base_url}/v1/video/generations/{task_id}/content",
            "file_path": str(path),
            "content_type": "video/mp4",
        }
        task["status"] = "succeeded"
        task["result"] = result
        self._mark_task_terminal(task)
        return result

    async def _complete_doubao_web_task(self, task_id: str, request_data: Dict[str, Any], base_url: str) -> None:
        task = self.tasks.get(task_id)
        if not task:
            return

        task["status"] = "running"
        timeout = self._video_task_timeout(request_data)
        try:
            await asyncio.wait_for(
                self._run_doubao_web_task(task, task_id, request_data, base_url),
                timeout=timeout,
            )
        except asyncio.TimeoutError:
            self._fail_task(
                task,
                RuntimeError(f"Doubao video task timed out after {timeout:g}s."),
                "doubao_web video generation timed out",
            )

    async def _run_doubao_web_task(
        self,
        task: Dict[str, Any],
        task_id: str,
        request_data: Dict[str, Any],
        base_url: str,
    ) -> None:
        try:
            probe_unknown = bool(settings.DOUBAO_VIDEO_ALLOW_UNKNOWN_QUOTA_ON_GENERATE)
            quota_check = await self.ensure_video_quota(
                self._required_video_quota(task),
                probe_unknown=probe_unknown,
            )
            task.setdefault("debug", {})["quota_preflight"] = quota_check
            await self._complete_doubao_web_segment(
                task,
                request_data,
                task_id,
                allow_unknown_quota=bool(
                    quota_check.get("provisional") and quota_check.get("provisional_allowed")
                ),
            )
            if task["result"]:
                logger.info(f"doubao_web video task completed: {task_id}")
                return
            if task["status"] == "submitted":
                logger.warning(f"doubao_web task submitted but not ready: {task_id}: {task['error']}")
                return
            if task["error"]:
                task["status"] = "failed"
                self._mark_task_terminal(task)
                logger.warning(f"doubao_web video task failed upstream: {task['error']}")
                return
        except TimeoutError as exc:
            task["status"] = "failed"
            task["error"] = {"message": str(exc), "type": "rate_limit_error", "code": "credential_pool_busy"}
            self._mark_task_terminal(task)
            logger.warning(f"doubao_web video generation delayed by credential pool: {task_id}: {exc}")
        except Exception as exc:
            self._fail_task(task, exc, "doubao_web video generation failed")

    def _video_task_timeout(self, request_data: Dict[str, Any]) -> float:
        default = max(60.0, float(settings.DOUBAO_VIDEO_TASK_TIMEOUT_SECONDS or 900))
        return self._bounded_float(
            request_data.get("task_timeout") or request_data.get("poll_timeout"),
            default,
            minimum=60,
            maximum=3600,
        )

    async def _complete_doubao_web_segment(
        self,
        task: Dict[str, Any],
        request_data: Dict[str, Any],
        log_task_id: str,
        *,
        allow_unknown_quota: bool = False,
    ) -> Dict[str, Any]:
        if not self.client or not self.credential_manager or not self.playwright_manager:
            raise RuntimeError("doubao_web provider is not initialized.")

        account_count = max(1, int(self.credential_manager.snapshot().get("account_count") or 1))
        max_attempts = min(account_count, settings.DOUBAO_VIDEO_ACCOUNT_RETRY_LIMIT)
        last_hard_error: Optional[BaseException] = None
        last_quota_error: Optional[VideoQuotaInsufficientError] = None

        for attempt in range(1, max_attempts + 1):
            required_quota = self._required_video_quota(task)
            async with self.credential_manager.acquire_for_quota(
                required_quota,
                allow_unknown=allow_unknown_quota,
            ) as lease:
                self._begin_credential_attempt(task, lease.index, attempt)
                task["credential_index"] = lease.index
                try:
                    task["status"] = "running"
                    task["error"] = None
                    result = await self._complete_doubao_web_segment_with_submit_slot(
                        task,
                        request_data,
                        log_task_id,
                        lease.cookie,
                    )
                except Exception as exc:
                    if self._is_retryable_upload_error(exc):
                        lease.mark_failure(exc)
                        last_hard_error = exc
                        request_data = self._reuse_uploaded_reference(task, request_data)
                        self._record_credential_retry(task, lease.index, exc, attempt, max_attempts)
                        if self._can_retry_with_another_credential(
                            required_quota,
                            allow_unknown=allow_unknown_quota,
                        ):
                            await self._close_credential_browser_session(lease.cookie, error=exc)
                            continue
                    if self._is_hard_credential_error(exc):
                        lease.mark_failure(exc)
                        last_hard_error = exc
                        request_data = self._reuse_uploaded_reference(task, request_data)
                        self._record_credential_retry(task, lease.index, exc, attempt, max_attempts)
                        if self._verification_retry_limit_reached(task, exc):
                            await self._close_credential_browser_session(lease.cookie, error=exc)
                            raise
                        if await self._auto_recover_credential_verification(
                            task,
                            lease.index,
                            lease.cookie,
                            exc,
                        ):
                            result = await self._continue_after_verification_recovery(
                                task,
                                request_data,
                                log_task_id,
                                lease.index,
                                lease.cookie,
                                attempt,
                            )
                            if result and not task.get("error"):
                                if required_quota > 0 and not self._task_has_confirmed_quota_signal(task, lease.index):
                                    await self._record_unconfirmed_video_usage(lease.index, required_quota)
                                self.credential_manager.report_success(lease.index)
                                await self._close_credential_browser_session(lease.cookie)
                                return result
                        semantic_context = self._semantic_reasoning_verification_context(task, lease.index, exc)
                        if semantic_context:
                            self._record_semantic_reasoning_rotation_stop(
                                task,
                                lease.index,
                                exc,
                                semantic_context,
                            )
                            await self._close_credential_browser_session(lease.cookie, error=exc)
                            raise
                        if is_quota_exhausted_error(exc):
                            await self._refresh_confirmed_quota_before_retry(task, required_quota)
                        if self._can_retry_with_another_credential(
                            required_quota,
                            allow_unknown=allow_unknown_quota,
                        ):
                            await self._close_credential_browser_session(lease.cookie, error=exc)
                            continue
                    await self._close_credential_browser_session(lease.cookie, error=exc)
                    raise

                if task.get("error"):
                    error = task.get("error") or {}
                    if error.get("code") == "video_quota_insufficient":
                        remaining = error.get("remaining")
                        required = error.get("required")
                        exc = VideoQuotaInsufficientError(
                            str(error.get("message") or "Doubao video quota is insufficient for this task."),
                            remaining=remaining,
                            required=required,
                        )
                        last_quota_error = exc
                        lease.mark_neutral()
                        request_data = self._reuse_uploaded_reference(task, request_data)
                        self._record_credential_retry(task, lease.index, exc, attempt, max_attempts)
                        await self._refresh_confirmed_quota_before_retry(task, required_quota)
                        if self._can_retry_with_another_credential(
                            required_quota,
                            allow_unknown=allow_unknown_quota,
                        ):
                            await self._close_credential_browser_session(lease.cookie)
                            continue
                        await self._close_credential_browser_session(lease.cookie)
                        raise exc
                    if self._is_hard_credential_error(error):
                        message = str(error.get("message") or error)
                        exc = RuntimeError(message)
                        if isinstance(error.get("verification"), dict):
                            setattr(exc, "verification_context", error["verification"])
                        lease.mark_failure(exc)
                        last_hard_error = exc
                        request_data = self._reuse_uploaded_reference(task, request_data)
                        self._record_credential_retry(task, lease.index, exc, attempt, max_attempts)
                        if self._verification_retry_limit_reached(task, error):
                            await self._close_credential_browser_session(lease.cookie, error=error)
                            raise exc
                        if await self._auto_recover_credential_verification(
                            task,
                            lease.index,
                            lease.cookie,
                            error,
                        ):
                            result = await self._continue_after_verification_recovery(
                                task,
                                request_data,
                                log_task_id,
                                lease.index,
                                lease.cookie,
                                attempt,
                            )
                            if result and not task.get("error"):
                                if required_quota > 0 and not self._task_has_confirmed_quota_signal(task, lease.index):
                                    await self._record_unconfirmed_video_usage(lease.index, required_quota)
                                self.credential_manager.report_success(lease.index)
                                await self._close_credential_browser_session(lease.cookie)
                                return result
                        semantic_context = self._semantic_reasoning_verification_context(task, lease.index, error)
                        if semantic_context:
                            self._record_semantic_reasoning_rotation_stop(
                                task,
                                lease.index,
                                error,
                                semantic_context,
                            )
                            await self._close_credential_browser_session(lease.cookie, error=error)
                            raise exc
                        if self._can_retry_with_another_credential(
                            required_quota,
                            allow_unknown=allow_unknown_quota,
                        ):
                            await self._close_credential_browser_session(lease.cookie, error=error)
                            continue
                        await self._close_credential_browser_session(lease.cookie, error=error)
                        raise exc

                if result and required_quota > 0 and not self._task_has_confirmed_quota_signal(task, lease.index):
                    await self._record_unconfirmed_video_usage(lease.index, required_quota)
                await self._close_credential_browser_session(lease.cookie)
                return result

        if last_quota_error:
            raise last_quota_error
        if last_hard_error:
            raise last_hard_error
        return {}

    async def _close_credential_browser_session(self, cookie: str, *, error: Optional[object] = None) -> None:
        if not self.playwright_manager:
            return
        if is_verification_required_error(error):
            logger.info("Preserving Doubao browser session because the account requires manual verification.")
            return
        close_account_session = getattr(self.playwright_manager, "close_account_session", None)
        if not close_account_session:
            return
        with suppress(Exception):
            await close_account_session(cookie)

    def _is_hard_credential_error(self, value: object) -> bool:
        if isinstance(value, dict):
            code = str(value.get("code") or "").strip()
            if code in HARD_CREDENTIAL_FAILURE_CODES:
                return True
            return self._is_hard_credential_error(value.get("message") or value.get("error") or "")
        return is_login_expired_error(value) or is_quota_exhausted_error(value) or is_verification_required_error(value)

    def _semantic_reasoning_verification_context(
        self,
        task: Dict[str, Any],
        account_index: int,
        error: object,
    ) -> Optional[Dict[str, Any]]:
        if not is_verification_required_error(error):
            return None
        context = self._verification_context_for_recovery(task, account_index, error)
        subtype = str(context.get("subtype") or "").strip().lower()
        if subtype != "semantic_reasoning":
            return None
        return context

    def _record_semantic_reasoning_rotation_stop(
        self,
        task: Dict[str, Any],
        account_index: int,
        error: object,
        context: Dict[str, Any],
    ) -> None:
        stops = task.setdefault("debug", {}).setdefault("semantic_reasoning_rotation_stops", [])
        stops.append(
            {
                "account_index": account_index,
                "stopped_at": time.time(),
                "reason": str(error),
                "context": self._debug_browser_trigger_context(context),
            }
        )
        if len(stops) > 20:
            del stops[:-20]
        logger.warning(
            "Doubao semantic_reasoning verification hit for video task "
            f"{task.get('id')} on account #{account_index}; stopping credential rotation "
            "and preserving the current account for verification recovery."
        )

    def _is_retryable_upload_error(self, value: object) -> bool:
        if isinstance(value, RetryableUploadAuthError):
            return True
        if isinstance(value, dict):
            return self._is_retryable_upload_error(value.get("message") or value.get("error") or "")
        text = str(value or "")
        markers = (
            "prepare_upload did not return service_id",
            "prepare_upload did not return a complete upload auth token",
            "prepare_upload failed",
            "Unable to generate a_bogus signature for prepare_upload",
            "TOS image upload network error",
            "All TOS image upload hosts failed",
            "No address associated with hostname",
            "Name or service not known",
            "Temporary failure in name resolution",
            "ConnectError",
        )
        return any(marker in text for marker in markers)

    def _required_video_quota(self, task: Dict[str, Any]) -> float:
        params = task.get("params") or {}
        duration = int(params.get("duration") or settings.VIDEO_LONG_FORM_SEGMENT_SECONDS)
        segment_seconds = max(1, int(settings.VIDEO_LONG_FORM_SEGMENT_SECONDS or duration or 1))
        return max(
            0.0,
            float(settings.DOUBAO_VIDEO_QUOTA_COST or 0) * duration / segment_seconds,
        )

    @staticmethod
    def _required_video_quota_from_signal(quota: Dict[str, Any], fallback: float) -> float:
        cost = quota.get("cost") if isinstance(quota, dict) else None
        if cost is not None:
            try:
                return max(0.0, float(cost))
            except (TypeError, ValueError):
                pass
        return max(0.0, float(fallback or 0))

    def _can_retry_with_another_credential(
        self,
        required_quota: float = 0,
        *,
        allow_unknown: bool = False,
    ) -> bool:
        if not self.credential_manager:
            return False
        required_quota = max(0.0, float(required_quota or 0))
        accounts = self.credential_manager.snapshot().get("accounts") or []
        for account in accounts:
            if account.get("status") not in {"available", "busy"}:
                continue
            if required_quota <= 0:
                return True
            quota = account.get("quota") if isinstance(account.get("quota"), dict) else {}
            if allow_unknown and self._account_allows_provisional_video_quota(
                account,
                allowed_statuses={"available", "busy"},
            ):
                return True
            if quota.get("status") not in {"available", "estimated"}:
                continue
            remaining = quota.get("remaining")
            if remaining is not None and float(remaining) >= required_quota:
                return True
        return False

    async def _refresh_confirmed_quota_before_retry(
        self,
        task: Dict[str, Any],
        required_quota: float,
    ) -> Dict[str, Any]:
        if not self.credential_manager:
            return {
                "checked_count": 0,
                "available_count": 0,
                "exhausted_count": 0,
                "unknown_count": 0,
                "results": [],
            }

        now = time.time()
        accounts = self.credential_manager.snapshot().get("accounts") or []
        candidate_indexes = [
            int(account["index"])
            for account in accounts
            if account.get("status") == "available"
            and (account.get("quota") or {}).get("status") != "exhausted"
            and not self._quota_refresh_should_skip_for_today(account.get("quota") or {}, now)
            and not self._account_has_video_quota(account, required_quota)
            and (
                (account.get("quota") or {}).get("status") not in {"available", "estimated"}
                or now - float((account.get("quota") or {}).get("updated_at") or 0)
                > settings.DOUBAO_VIDEO_QUOTA_MAX_AGE_SECONDS
            )
        ]
        candidate_indexes = candidate_indexes[: settings.DOUBAO_VIDEO_ACCOUNT_RETRY_LIMIT]
        result = await self._refresh_until_video_quota(candidate_indexes, required_quota)
        refreshes = task.setdefault("debug", {}).setdefault("quota_retry_refreshes", [])
        refreshes.append(result)
        if len(refreshes) > 20:
            del refreshes[:-20]
        return result

    async def _record_unconfirmed_video_usage(self, account_index: int, required_quota: float) -> None:
        account = self.credential_manager.snapshot()["accounts"][account_index]
        quota = account.get("quota") or {}
        if quota.get("status") in {"available", "estimated"} and quota.get("remaining") is not None:
            await self.credential_manager.consume_quota(
                account_index,
                required_quota,
                source="local_estimate",
                reason="video",
            )
            return
        await self.credential_manager.record_quota_usage_without_balance(
            account_index,
            required_quota,
            source="video_success_without_balance",
            reason="video",
        )

    @staticmethod
    def _task_has_confirmed_quota_signal(task: Dict[str, Any], account_index: int) -> bool:
        return any(
            isinstance(item, dict)
            and item.get("account_index") == account_index
            and item.get("remaining") is not None
            for item in (task.get("debug", {}).get("quota_sync") or [])
        )

    def _reuse_uploaded_reference(self, task: Dict[str, Any], request_data: Dict[str, Any]) -> Dict[str, Any]:
        reference = task.get("reference_image")
        if not isinstance(reference, dict) or not reference.get("file_key"):
            return request_data
        updated = dict(request_data)
        updated["reference_image"] = self._uploaded_reference_for_request(reference)
        return updated

    def _uploaded_reference_for_request(self, reference: Dict[str, Any]) -> Dict[str, Any]:
        file_key = reference.get("fileKey") or reference.get("file_key")
        local_key = reference.get("localKey") or reference.get("local_key") or file_key
        file_name = reference.get("fileName") or reference.get("file_name") or reference.get("name") or "reference.png"
        mime_type = reference.get("mimeType") or reference.get("mime_type") or "image/png"
        width = int(reference.get("imageWidth") or reference.get("image_width") or 0)
        height = int(reference.get("imageHeight") or reference.get("image_height") or 0)
        return {
            "fileKey": file_key,
            "file_key": file_key,
            "localKey": local_key,
            "local_key": local_key,
            "fileName": file_name,
            "file_name": file_name,
            "mimeType": mime_type,
            "mime_type": mime_type,
            "size": int(reference.get("size") or 0),
            "imageWidth": width,
            "image_width": width,
            "imageHeight": height,
            "image_height": height,
            "md5": reference.get("md5") or reference.get("ImageMd5"),
            "kind": "doubao_uploaded",
        }

    def _verification_completion_ready(self, verification: Dict[str, Any]) -> bool:
        if not isinstance(verification, dict) or verification.get("login_required"):
            return False
        if verification.get("manual_success_detected"):
            return True
        bdturing_result = (
            verification.get("bdturing_result")
            if isinstance(verification.get("bdturing_result"), dict)
            else {}
        )
        if str(bdturing_result.get("status") or "").lower() == "success":
            return True
        auto_solve = (
            verification.get("auto_solve_result")
            if isinstance(verification.get("auto_solve_result"), dict)
            else {}
        )
        solution = auto_solve.get("captcha_solution") if isinstance(auto_solve.get("captcha_solution"), dict) else {}
        return bool(solution.get("solved"))

    def _verification_context_for_recovery(
        self,
        task: Dict[str, Any],
        account_index: int,
        error: object,
    ) -> Dict[str, Any]:
        context: Optional[Dict[str, Any]] = None
        if isinstance(error, dict):
            if isinstance(error.get("verification"), dict):
                context = dict(error["verification"])
            else:
                extracted = _extract_verification_context(error)
                if extracted:
                    context = dict(extracted)
        if context is None:
            attr_context = getattr(error, "verification_context", None)
            if isinstance(attr_context, dict):
                context = dict(attr_context)
        if context is None and self.credential_manager:
            accounts = self.credential_manager.snapshot().get("accounts") or []
            account = next((item for item in accounts if int(item.get("index", -1)) == int(account_index)), None)
            account_context = account.get("verification_context") if isinstance(account, dict) else None
            if isinstance(account_context, dict):
                context = dict(account_context)
        if not context:
            return {}
        return self._verification_context_with_trigger_context(task, context)

    def _verification_recovery_already_attempted(self, task: Dict[str, Any], account_index: int) -> bool:
        return any(
            isinstance(item, dict) and int(item.get("account_index", -1)) == int(account_index)
            for item in task.get("debug", {}).get("verification_auto_recoveries") or []
        )

    def _verification_recovery_summary(self, verification: Dict[str, Any]) -> Dict[str, Any]:
        keys = (
            "status",
            "message",
            "manual_success_detected",
            "visual_challenge_seen",
            "login_required",
            "bdturing_result",
            "bdturing_render",
            "auto_solve_result",
            "captcha_probe",
            "snapshot_url",
            "url",
        )
        return {
            key: verification.get(key)
            for key in keys
            if key in verification and verification.get(key) is not None
        }

    async def _auto_recover_credential_verification(
        self,
        task: Dict[str, Any],
        account_index: int,
        cookie: str,
        error: object,
    ) -> bool:
        if not settings.DOUBAO_CAPTCHA_AUTO_SOLVE:
            return False
        if not self.credential_manager or not self.playwright_manager:
            return False
        if not getattr(self.playwright_manager, "_initialized", False):
            return False
        if not is_verification_required_error(error):
            return False
        if self._verification_recovery_already_attempted(task, account_index):
            return False

        context = self._verification_context_for_recovery(task, account_index, error)
        recoveries = task.setdefault("debug", {}).setdefault("verification_auto_recoveries", [])
        recovery: Dict[str, Any] = {
            "account_index": account_index,
            "started_at": time.time(),
            "status": "running",
            "context": self._debug_browser_trigger_context(context) if context else {},
        }
        recoveries.append(recovery)
        if len(recoveries) > 20:
            del recoveries[:-20]

        try:
            prompt = str(task.get("prompt") or "Generate a simple product showcase video.")
            image_path = await self._verification_recovery_image_path(task)
            mode = "image_video" if image_path else "video"
            submit_state, submit_slot = await self._acquire_frontend_stage(
                "verification_submit",
                recovery,
            )
            try:
                await self.manual_verification_manager.start(
                    account_index,
                    cookie,
                    verification_context=context,
                )
                verification = await self.manual_verification_manager.auto_verify(
                    account_index,
                    context,
                    prompt=prompt,
                    mode=mode,
                    image_path=image_path,
                    solve=True,
                )
            finally:
                self._release_frontend_stage(submit_state, submit_slot)
            recovery["verification"] = self._verification_recovery_summary(verification)
            conversation_id = self._verification_conversation_id(verification)
            frontend_conversation_ready = self._verification_frontend_conversation_ready(verification)
            if not self._verification_completion_ready(verification) and not frontend_conversation_ready:
                recovery["status"] = "not_solved"
                recovery["completed_at"] = time.time()
                recovery["message"] = verification.get("message") or "Verification is still pending."
                return False

            frontend_signals = self._verification_video_signals(verification)
            if frontend_conversation_ready and not frontend_signals.get("video_urls"):
                recovery["detached_result_polling"] = True
                recovery["frontend_accepted_at"] = time.time()

            finished = await self.manual_verification_manager.complete(account_index)
            recovery["completion"] = self._verification_recovery_summary(finished)
            conversation_id = self._verification_conversation_id(finished, verification) or conversation_id
            if conversation_id:
                recovery["conversation_id"] = conversation_id
            frontend_signals = self._verification_video_signals(
                finished,
                verification,
            )
            if frontend_signals.get("video_urls"):
                recovery["frontend_video_signals"] = frontend_signals
            cookie_header = normalize_doubao_cookie(finished.pop("cookie_header", None) or "")
            if cookie_header:
                await self.credential_manager.update_account_cookie(account_index, cookie_header)
                await self.playwright_manager.register_account(cookie_header)
            await self.credential_manager.clear_cooldown(account_index)
            account = await self.credential_manager.reset_health(account_index)
            recovery["status"] = "recovered"
            recovery["completed_at"] = time.time()
            recovery["account_status"] = account.get("status") if isinstance(account, dict) else None
            recovery_action = (
                f"resuming accepted frontend conversation {conversation_id}"
                if conversation_id
                else "retrying same account"
            )
            logger.info(
                "Auto-recovered Doubao browser verification for video task "
                f"{task.get('id')} on account #{account_index}; {recovery_action}."
            )
            return True
        except Exception as exc:
            recovery["status"] = "error"
            recovery["completed_at"] = time.time()
            recovery["error"] = str(exc)
            logger.warning(
                "Auto recovery for Doubao browser verification failed for video task "
                f"{task.get('id')} on account #{account_index}: {exc}"
            )
            return False

    @staticmethod
    def _verification_conversation_id(*verifications: object) -> Optional[str]:
        for verification in verifications:
            if not isinstance(verification, dict):
                continue
            url = str(verification.get("url") or "").strip()
            if not url:
                continue
            with suppress(Exception):
                parsed = urlparse(url)
                if parsed.netloc and not parsed.netloc.endswith("doubao.com"):
                    continue
                match = re.search(r"(?:^|/)chat/(\d+)(?:$|[/?#])", parsed.path or url)
                if match:
                    return match.group(1)
        return None

    def _verification_frontend_conversation_ready(self, verification: object) -> bool:
        if not isinstance(verification, dict):
            return False
        if not self._verification_conversation_id(verification):
            return False
        auto_solve = (
            verification.get("auto_solve_result")
            if isinstance(verification.get("auto_solve_result"), dict)
            else {}
        )
        frontend_triggered = any(
            isinstance(step, dict) and step.get("name") == "frontend_video_trigger"
            for step in auto_solve.get("steps") or []
        )
        confirmation_accepted = any(
            isinstance(step, dict)
            and step.get("name") == "frontend_video_confirmation"
            and bool(step.get("accepted"))
            for step in auto_solve.get("steps") or []
        )
        return frontend_triggered and bool(
            verification.get("manual_success_detected")
            or verification.get("manual_success_terms")
            or confirmation_accepted
        )

    @staticmethod
    def _verification_video_signals(*verifications: object) -> Dict[str, Any]:
        merged = empty_video_signals()
        for verification in verifications:
            if not isinstance(verification, dict):
                continue
            signals = verification.get("video_signals")
            if not isinstance(signals, dict):
                continue
            for key in (
                "task_ids",
                "video_ids",
                "video_urls",
                "conversation_ids",
                "failures",
                "non_video_results",
                "quota",
                "verification",
            ):
                for item in signals.get(key) or []:
                    if item not in merged[key]:
                        merged[key].append(item)
            merged["status"] = signals.get("status") or merged.get("status")
            merged["saw_video_intent"] = bool(
                merged.get("saw_video_intent") or signals.get("saw_video_intent")
            )
        return merged

    def _recovered_verification_conversation_id(
        self,
        task: Dict[str, Any],
        account_index: int,
    ) -> Optional[str]:
        recoveries = task.get("debug", {}).get("verification_auto_recoveries") or []
        for recovery in reversed(recoveries):
            if not isinstance(recovery, dict):
                continue
            if int(recovery.get("account_index", -1)) != int(account_index):
                continue
            if recovery.get("status") != "recovered":
                continue
            conversation_id = str(recovery.get("conversation_id") or "").strip()
            if conversation_id:
                return conversation_id
        return None

    def _recovered_verification_video_signals(
        self,
        task: Dict[str, Any],
        account_index: int,
    ) -> Dict[str, Any]:
        recoveries = task.get("debug", {}).get("verification_auto_recoveries") or []
        for recovery in reversed(recoveries):
            if not isinstance(recovery, dict):
                continue
            if int(recovery.get("account_index", -1)) != int(account_index):
                continue
            if recovery.get("status") != "recovered":
                continue
            signals = recovery.get("frontend_video_signals")
            if isinstance(signals, dict) and signals.get("video_urls"):
                return signals
        return {}

    async def _continue_after_verification_recovery(
        self,
        task: Dict[str, Any],
        request_data: Dict[str, Any],
        log_task_id: str,
        account_index: int,
        cookie: str,
        attempt: int,
    ) -> Dict[str, Any]:
        self._begin_credential_attempt(task, account_index, attempt)
        task["status"] = "running"
        task["error"] = None
        task["result"] = None

        frontend_signals = self._recovered_verification_video_signals(task, account_index)
        if frontend_signals:
            self._merge_signals(task, frontend_signals)
            self._set_result_from_signals(task)
            if task.get("result"):
                await self._resolve_no_watermark_result(task, cookie)
                task["status"] = "succeeded"
                self._mark_task_terminal(task)
                self._write_upstream_debug(task)
                return task["result"]

        conversation_id = self._recovered_verification_conversation_id(task, account_index)
        if conversation_id:
            task["status"] = "polling"
            await self._poll_doubao_chain(task, cookie, conversation_id, request_data)
            if task.get("result"):
                await self._resolve_no_watermark_result(task, cookie)
                task["status"] = "succeeded"
                self._mark_task_terminal(task)
                self._write_upstream_debug(task)
                return task["result"]
            return {}

        return await self._complete_doubao_web_segment_with_submit_slot(
            task,
            request_data,
            log_task_id,
            cookie,
        )

    async def _verification_recovery_image_path(self, task: Dict[str, Any]) -> Optional[str]:
        reference = task.get("source_reference_image") if isinstance(task.get("source_reference_image"), dict) else None
        if not reference:
            reference = task.get("reference_image") if isinstance(task.get("reference_image"), dict) else None
        if not reference:
            return None
        path = reference.get("path")
        if path and Path(str(path)).expanduser().is_file():
            return str(Path(str(path)).expanduser().resolve())
        raw = reference.get("bytes")
        if isinstance(raw, bytes) and raw:
            file_name = str(reference.get("file_name") or "reference.png")
            return str(self._write_verification_reference_file(task, raw, file_name, reference.get("mime_type")))
        url = reference.get("url")
        if url and self.client:
            response = await self.client.get(str(url), timeout=settings.API_REQUEST_TIMEOUT)
            response.raise_for_status()
            file_name = str(reference.get("file_name") or Path(str(url).split("?", 1)[0]).name or "reference.png")
            return str(
                self._write_verification_reference_file(
                    task,
                    response.content,
                    file_name,
                    response.headers.get("content-type") or reference.get("mime_type"),
                )
            )
        return None

    def _write_verification_reference_file(
        self,
        task: Dict[str, Any],
        raw: bytes,
        file_name: str,
        mime_type: Optional[str],
    ) -> Path:
        extension = Path(file_name).suffix.lower()
        if extension not in IMAGE_UPLOAD_EXTENSIONS:
            extension = f".{self._extension_from_mime(str(mime_type or 'image/png'))}"
        safe_name = re.sub(r"[^A-Za-z0-9_.-]+", "_", Path(file_name).stem).strip("._") or "reference"
        path = self.output_dir.parent / "verification-inputs" / f"{task.get('id', 'video')}-{safe_name}{extension}"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(raw)
        return path

    def _record_credential_retry(
        self,
        task: Dict[str, Any],
        index: int,
        exc: BaseException,
        attempt: int,
        max_attempts: int,
    ) -> None:
        retries = task.setdefault("debug", {}).setdefault("credential_retries", [])
        retries.append(
            {
                "account_index": index,
                "attempt": attempt,
                "max_attempts": max_attempts,
                "reason": str(exc),
            }
        )
        if len(retries) > 20:
            del retries[:-20]
        task["status"] = "running"
        task["error"] = None
        logger.warning(
            f"doubao_web video task {task.get('id')} retrying with another credential "
            f"after account #{index} failed: {exc}"
        )

    def _verification_retry_limit_reached(self, task: Dict[str, Any], error: object) -> bool:
        if not is_verification_required_error(error):
            return False
        limit = max(1, int(settings.DOUBAO_VIDEO_VERIFICATION_RETRY_LIMIT or 3))
        retries = task.get("debug", {}).get("credential_retries") or []
        verification_retries = sum(
            1
            for retry in retries
            if isinstance(retry, dict) and is_verification_required_error(retry.get("reason"))
        )
        if verification_retries < limit:
            return False
        logger.warning(
            f"doubao_web video task {task.get('id')} reached browser verification retry limit "
            f"({verification_retries}/{limit}); stopping credential rotation."
        )
        return True

    def _begin_credential_attempt(self, task: Dict[str, Any], account_index: int, attempt: int) -> None:
        debug = task.setdefault("debug", {})
        active = debug.get("active_credential_attempt")
        if isinstance(active, dict):
            history = debug.setdefault("credential_attempts", [])
            history.append(
                {
                    **active,
                    "response": debug.get("response"),
                    "signals": debug.get("signals"),
                    "quota_sync": debug.get("quota_sync"),
                    "error": task.get("error"),
                }
            )
            if len(history) > 20:
                del history[:-20]

        for key in (
            "response",
            "polling",
            "chain_events",
            "upstream_request",
            "quota_sync",
            "not_ready",
            "sse_lines",
        ):
            debug.pop(key, None)
        debug["events"] = []
        debug["signals"] = empty_video_signals()
        debug["active_credential_attempt"] = {
            "account_index": account_index,
            "attempt": attempt,
            "started_at": time.time(),
        }
        task["result"] = None
        task["error"] = None

    async def _complete_doubao_web_segment_with_cookie(
        self,
        task: Dict[str, Any],
        request_data: Dict[str, Any],
        log_task_id: str,
        base_cookie: str,
    ) -> Dict[str, Any]:
        if not self.client or not self.playwright_manager:
            raise RuntimeError("doubao_web provider is not initialized.")

        upstream_url = "https://www.doubao.com/chat/completion"
        params = self._base_params()

        device_fingerprint = await self.playwright_manager.get_account_device_fingerprint(base_cookie)
        final_cookie = await self._effective_doubao_cookie(base_cookie)
        headers = self._prepare_headers(final_cookie)
        request_data = await self._ensure_doubao_uploaded_reference(task, request_data, final_cookie)
        payload = self._prepare_doubao_video_payload(
            request_data,
            task["prompt"],
            task["model"],
            request_fingerprint=device_fingerprint.get("fp"),
        )
        task["debug"]["upstream_request"] = self._debug_request_summary(payload)
        self._attach_context_template_comparison(task, payload)

        log_headers = headers.copy()
        log_headers["Cookie"] = "[REDACTED]"
        logger.info(f"Submitting doubao_web video task {log_task_id} to /chat/completion")
        logger.debug(f"doubao_web headers: {json.dumps(log_headers, ensure_ascii=False)}")
        logger.debug(f"doubao_web payload: {json.dumps(payload, ensure_ascii=False)}")

        if settings.DOUBAO_VIDEO_TRANSPORT == "browser":
            response = await self.playwright_manager.post_json(
                upstream_url,
                final_cookie,
                params,
                payload,
                headers=headers,
                timeout_seconds=settings.API_REQUEST_TIMEOUT,
            )
            transport = "playwright_browser"
        else:
            signed_url = await self.playwright_manager.get_signed_url(upstream_url, final_cookie, params)
            if not signed_url:
                raise RuntimeError("Unable to generate a_bogus signature.")
            upstream_response = await self.client.post(
                signed_url,
                headers=headers,
                json=payload,
                timeout=settings.API_REQUEST_TIMEOUT,
            )
            response = {
                "status_code": upstream_response.status_code,
                "headers": dict(upstream_response.headers),
                "text": upstream_response.text,
                "url": str(upstream_response.url),
            }
            transport = "httpx_signed"
        response_headers = {
            str(key).lower(): str(value)
            for key, value in (response.get("headers") or {}).items()
        }
        browser_trigger_context = response.get("browser_trigger_context")
        if isinstance(browser_trigger_context, dict):
            task["debug"]["browser_trigger_context"] = self._debug_browser_trigger_context(browser_trigger_context)
        status_code = int(response.get("status_code") or 0)
        body_text = str(response.get("text") or "")
        task["debug"]["response"] = {
            "status_code": status_code,
            "headers": redact_response_headers(response_headers),
            "content_type": response_headers.get("content-type", ""),
            "transport": transport,
        }
        new_ms_token = response_headers.get("x-ms-token")
        if new_ms_token:
            self.playwright_manager.update_ms_token(new_ms_token, base_cookie)
        if response_headers.get("x-tt-agw-login") == "0":
            self._write_upstream_debug(task)
            raise RuntimeError(
                "doubao_web upstream returned x-tt-agw-login=0 and did not recognize "
                "the selected account as logged in. Refresh the selected Doubao cookie."
            )

        if status_code != 200:
            task["debug"]["response"]["body_preview"] = truncate_debug_text(body_text, 4000)
            self._write_upstream_debug(task)
            raise RuntimeError(f"upstream returned {status_code}: {body_text[:800]}")

        saw_line = False
        for line in body_text.splitlines():
            saw_line = True
            self._record_sse_line(task, line)
            await self._consume_sse_line(task, line)
            if task["result"]:
                break
        task["debug"]["response"]["saw_stream_line"] = saw_line
        self._write_upstream_debug(task)

        if task["result"]:
            await self._resolve_no_watermark_result(task, final_cookie)
            task["status"] = "succeeded"
            self._mark_task_terminal(task)
            self._write_upstream_debug(task)
            return task["result"]
        if task["error"]:
            task["status"] = "failed"
            self._mark_task_terminal(task)
            return {}

        signals = task["debug"].get("signals", {})
        conversation_id = self._choose_conversation_id(signals, request_data)
        if conversation_id:
            await self._poll_doubao_chain(task, final_cookie, conversation_id, request_data)
        if task["result"]:
            await self._resolve_no_watermark_result(task, final_cookie)
            task["status"] = "succeeded"
            self._mark_task_terminal(task)
            self._write_upstream_debug(task)
            return task["result"]
        if task["error"]:
            task["status"] = "failed"
            self._mark_task_terminal(task)
            return {}

        if signals.get("task_ids") or conversation_id:
            message = "Upstream accepted the request, but no final video URL was found before polling completed."
            task["status"] = "failed"
            task["error"] = {"message": message, "type": "timeout_error", "code": "video_not_ready"}
            self._mark_task_terminal(task)
            self._write_upstream_debug(task)
            logger.warning(f"doubao_web task submitted but no video URL found: {signals}")
            return {}

        raise RuntimeError("No conversation_id, task_id, or video URL found in upstream SSE response.")

    async def _complete_long_form_task(self, task_id: str, request_data: Dict[str, Any], base_url: str) -> None:
        task = self.tasks.get(task_id)
        if not task:
            return

        task["status"] = "running"
        plan = task.get("long_form") or {}
        segment_dir = self.output_dir / task_id
        segment_dir.mkdir(parents=True, exist_ok=True)
        segment_paths: list[Path] = []

        try:
            if settings.VIDEO_PROVIDER == "doubao_web":
                await self._complete_doubao_web_long_form_task(task, request_data, base_url, segment_dir, segment_paths)
            else:
                for index, segment in enumerate(plan.get("segments", []), start=1):
                    segment["status"] = "running"
                    task["status"] = "running"
                    task["long_form"]["current_segment"] = index
                    task["long_form"]["completed_segments"] = index - 1
                    logger.info(
                        f"Generating long-form segment {index}/{plan.get('total_segments')} "
                        f"for {task_id}: {segment['duration']}s"
                    )

                    segment_request = dict(request_data)
                    segment_request["duration"] = segment["duration"]
                    segment_task = self._new_segment_task(task, segment, f"{task_id}-seg-{index:04d}")
                    await asyncio.sleep(settings.VIDEO_TASK_DELAY_SECONDS)
                    segment_path = segment_dir / f"segment-{index:04d}.mp4"
                    await self._complete_mock_segment(segment_task, segment_task["id"], base_url, segment_path)

                    segment["status"] = "succeeded"
                    segment["file_path"] = str(segment_path)
                    segment["source_url"] = (segment_task.get("result") or {}).get("upstream_url")
                    task["long_form"]["completed_segments"] = index
                    segment_paths.append(segment_path)

            output_path = self.output_dir / f"{task_id}.mp4"
            await asyncio.to_thread(self._concat_video_segments, segment_paths, output_path)
            task["status"] = "succeeded"
            task["result"] = {
                "url": f"{base_url}/v1/video/generations/{task_id}/content",
                "file_path": str(output_path),
                "content_type": "video/mp4",
            }
            task["long_form"]["output_file"] = str(output_path)
            self._mark_task_terminal(task)
            logger.info(f"Long-form video generation completed: {task_id}")
        except Exception as exc:
            for segment in plan.get("segments", []):
                if segment.get("status") == "running":
                    segment["status"] = "failed"
            self._fail_task(task, exc, "Long-form video generation failed")

    async def _complete_doubao_web_long_form_task(
        self,
        task: Dict[str, Any],
        request_data: Dict[str, Any],
        base_url: str,
        segment_dir: Path,
        segment_paths: list[Path],
    ) -> None:
        if not self.credential_manager:
            raise RuntimeError("doubao_web provider is not initialized.")

        probe_unknown = bool(settings.DOUBAO_VIDEO_ALLOW_UNKNOWN_QUOTA_ON_GENERATE)
        quota_check = await self.ensure_video_quota(
            self._required_video_quota(task),
            probe_unknown=probe_unknown,
        )
        task.setdefault("debug", {})["quota_preflight"] = quota_check
        async with self.credential_manager.acquire_for_quota(
            self._required_video_quota(task),
            allow_unknown=bool(quota_check.get("provisional") and quota_check.get("provisional_allowed")),
        ) as lease:
            task["credential_index"] = lease.index
            request_data = await self._ensure_doubao_uploaded_reference(
                task,
                request_data,
                self._get_dynamic_cookie(lease.cookie),
            )
            for index, segment in enumerate((task.get("long_form") or {}).get("segments", []), start=1):
                segment["status"] = "running"
                task["status"] = "running"
                task["long_form"]["current_segment"] = index
                task["long_form"]["completed_segments"] = index - 1
                logger.info(
                    f"Generating long-form segment {index}/{task['long_form'].get('total_segments')} "
                    f"for {task['id']}: {segment['duration']}s"
                )

                segment_request = dict(request_data)
                segment_request["duration"] = segment["duration"]
                segment_task = self._new_segment_task(task, segment, f"{task['id']}-seg-{index:04d}")
                segment_task["credential_index"] = lease.index
                await self._complete_doubao_web_segment_with_submit_slot(
                    segment_task,
                    segment_request,
                    segment_task["id"],
                    lease.cookie,
                )
                if not segment_task.get("result"):
                    error_message = (
                        segment_task.get("error", {}).get("message")
                        or f"Segment {index} did not produce a video URL."
                    )
                    if is_login_expired_error(error_message) or is_quota_exhausted_error(error_message):
                        lease.mark_failure(RuntimeError(error_message))
                    raise RuntimeError(error_message)
                segment_quota = self._required_video_quota(segment_task)
                if segment_quota > 0 and not self._task_has_confirmed_quota_signal(segment_task, lease.index):
                    await self._record_unconfirmed_video_usage(lease.index, segment_quota)

                segment_path = segment_dir / f"segment-{index:04d}.mp4"
                await self._download_video_result(segment_task["result"], segment_path)
                segment["status"] = "succeeded"
                segment["file_path"] = str(segment_path)
                segment["source_url"] = (segment_task.get("result") or {}).get("upstream_url")
                task["long_form"]["completed_segments"] = index
                segment_paths.append(segment_path)

    def _new_segment_task(self, task: Dict[str, Any], segment: Dict[str, Any], segment_id: str) -> Dict[str, Any]:
        params = dict(task["params"])
        params["duration"] = segment["duration"]
        return {
            "id": segment_id,
            "object": task["object"],
            "created": int(time.time()),
            "model": task["model"],
            "status": "queued",
            "prompt": self._segment_prompt(task["prompt"], segment),
            "params": params,
            "reference_image": task.get("reference_image"),
            "source_reference_image": task.get("source_reference_image"),
            "reference_image_meta": task.get("reference_image_meta"),
            "credential_index": task.get("credential_index"),
            "error": None,
            "result": None,
            "debug": {"events": [], "signals": empty_video_signals()},
        }

    def _segment_prompt(self, prompt: str, segment: Dict[str, Any]) -> str:
        total = segment.get("total_segments")
        index = segment.get("index")
        if not total or total == 1:
            return prompt
        return (
            f"{prompt}\n\n"
            f"Long video segment {index} of {total}. Keep the same subject, style, lighting, "
            "and camera language as the surrounding segments. Do not add titles, subtitles, "
            "logos, or end cards."
        )

    async def _resolve_no_watermark_result(self, task: Dict[str, Any], cookie: str) -> None:
        params = task.get("params") or {}
        if bool(params.get("watermark")):
            return

        result = task.get("result") or {}
        if result.get("file_path"):
            return

        upstream_url = result.get("upstream_url") or result.get("url")
        if not _is_watermarked_video_url(upstream_url):
            return

        signals = task.setdefault("debug", {}).setdefault("signals", empty_video_signals())
        for key, default in empty_video_signals().items():
            signals.setdefault(key, [] if isinstance(default, list) else default)

        video_ids = list(signals.get("video_ids") or [])
        if not video_ids:
            probe_signals = empty_video_signals()
            _record_video_id(probe_signals, upstream_url)
            video_ids = probe_signals.get("video_ids") or []

        resolution_debug = task.setdefault("debug", {}).setdefault("no_watermark_resolution", {})
        resolution_debug.update(
            {
                "enabled": True,
                "source_url_marker": "video_gen_watermark",
                "attempted_video_ids": video_ids,
                "started_at": time.time(),
            }
        )
        attempts = resolution_debug.setdefault("attempts", [])

        for video_id in video_ids[:5]:
            clean_url, attempt = await self._fetch_doubao_original_media_url(cookie, video_id)
            attempts.append(attempt)
            if clean_url:
                no_watermark_source = attempt.get("candidate_source") or "samantha_media_get_play_info"
                result.update(
                    {
                        "url": clean_url,
                        "upstream_url": clean_url,
                        "content_type": "video/mp4",
                        "no_watermark_source": no_watermark_source,
                    }
                )
                resolution_debug.update(
                    {
                        "resolved": True,
                        "selected_video_id": video_id,
                        "completed_at": time.time(),
                    }
                )
                self._write_upstream_debug(task)
                return

        resolution_debug.update(
            {
                "resolved": False,
                "completed_at": time.time(),
            }
        )
        self._write_upstream_debug(task)

    async def _fetch_doubao_original_media_url(self, cookie: str, video_id: str) -> tuple[Optional[str], Dict[str, Any]]:
        attempt: Dict[str, Any] = {
            "video_id": video_id,
            "endpoint": "/samantha/media/get_play_info",
            "started_at": time.time(),
        }
        if not self.playwright_manager:
            attempt["error"] = "Playwright manager is not initialized."
            return None, attempt

        try:
            response = await self.playwright_manager.post_json(
                "https://www.doubao.com/samantha/media/get_play_info",
                cookie,
                self._base_params(include_fp=False),
                {"key": video_id, "type": "video"},
                headers=self._prepare_headers(cookie),
                timeout_seconds=settings.API_REQUEST_TIMEOUT,
            )
            status_code = int(response.get("status_code") or 0)
            attempt["status_code"] = status_code
            body_text = str(response.get("text") or "")
            data = json.loads(body_text)
        except Exception as exc:
            attempt["error"] = str(exc)[:500]
            attempt["completed_at"] = time.time()
            return None, attempt

        attempt["code"] = data.get("code") if isinstance(data, dict) else None
        attempt["message"] = (
            data.get("msg") or data.get("message")
            if isinstance(data, dict)
            else None
        )
        if status_code != 200 or attempt["code"] not in (None, 0, "0"):
            attempt["completed_at"] = time.time()
            return None, attempt

        signals = extract_video_signals(data)
        urls = signals.get("video_urls") or []
        attempt["url_count"] = len(urls)
        candidates = _doubao_original_media_candidates(data)
        attempt["candidate_count"] = len(candidates)
        for candidate in candidates:
            candidate_url = candidate["url"]
            if _is_watermarked_video_url(candidate_url):
                continue
            attempt.update(
                {
                    "resolved": True,
                    "candidate_without_marker": True,
                    "candidate_source": candidate["source"],
                    "candidate_url_key": candidate["url_key"],
                    "candidate_meta": candidate["meta"],
                    "visual_watermark_unverified": True,
                }
            )
            attempt["completed_at"] = time.time()
            return candidate_url, attempt

        attempt["resolved"] = False
        if candidates:
            attempt["reason"] = "All original_media_info URL candidates still include watermark markers."
        elif urls:
            attempt["reason"] = "No original_media_info URL candidate was returned by media get_play_info."
        attempt["completed_at"] = time.time()
        return None, attempt

    async def _download_video_result(self, result: Dict[str, Any], path: Path) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        if result.get("file_path"):
            shutil.copyfile(result["file_path"], path)
            return

        url = result.get("upstream_url") or result.get("url")
        if not url:
            raise RuntimeError("Segment result does not include a downloadable video URL.")
        if ".m3u8" in url.lower().split("?", 1)[0]:
            await asyncio.to_thread(self._ffmpeg_download_video, url, path)
            return
        if not self.client:
            raise RuntimeError("HTTP client is not initialized.")

        headers = {
            "User-Agent": getattr(self.playwright_manager, "browser_user_agent", None)
            or "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
            "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
            "Referer": "https://www.doubao.com/",
        }
        async with self.client.stream("GET", url, headers=headers) as response:
            response.raise_for_status()
            with path.open("wb") as output:
                async for chunk in response.aiter_bytes(VIDEO_DOWNLOAD_CHUNK_SIZE):
                    output.write(chunk)

    def _concat_video_segments(self, segment_paths: list[Path], output_path: Path) -> None:
        if not segment_paths:
            raise RuntimeError("No video segments to concatenate.")
        output_path.parent.mkdir(parents=True, exist_ok=True)
        list_path = output_path.with_suffix(".concat.txt")
        list_path.write_text(
            "".join(f"file '{self._ffmpeg_concat_path(path)}'\n" for path in segment_paths),
            encoding="utf-8",
        )
        copy_command = [
            self._ffmpeg_executable(),
            "-y",
            "-f",
            "concat",
            "-safe",
            "0",
            "-i",
            str(list_path),
            "-c",
            "copy",
            str(output_path),
        ]
        completed = self._run_ffmpeg(copy_command)
        if completed.returncode != 0:
            logger.warning(f"ffmpeg stream-copy concat failed, retrying with re-encode: {completed.stderr[-1000:]}")
            reencode_command = [
                self._ffmpeg_executable(),
                "-y",
                "-f",
                "concat",
                "-safe",
                "0",
                "-i",
                str(list_path),
                "-map",
                "0:v:0",
                "-c:v",
                "libx264",
                "-tune",
                "fastdecode",
                "-crf",
                "18",
                "-pix_fmt",
                "yuv420p",
                "-movflags",
                "+faststart",
                "-an",
                str(output_path),
            ]
            completed = self._run_ffmpeg(reencode_command)
            if completed.returncode != 0:
                raise RuntimeError(f"ffmpeg concat failed: {completed.stderr[-2000:]}")
        if not output_path.exists() or output_path.stat().st_size == 0:
            raise RuntimeError("ffmpeg concat did not produce an output file.")

    def _ffmpeg_download_video(self, url: str, path: Path) -> None:
        command = [
            self._ffmpeg_executable(),
            "-y",
            "-i",
            url,
            "-c",
            "copy",
            str(path),
        ]
        completed = self._run_ffmpeg(command)
        if completed.returncode != 0:
            raise RuntimeError(f"ffmpeg download failed: {completed.stderr[-2000:]}")
        if not path.exists() or path.stat().st_size == 0:
            raise RuntimeError("ffmpeg download did not produce an output file.")

    def _run_ffmpeg(self, command: list[str]) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            command,
            capture_output=True,
            text=True,
            timeout=settings.VIDEO_LONG_FORM_CONCAT_TIMEOUT_SECONDS,
            check=False,
        )

    def _ffmpeg_executable(self) -> str:
        configured = os.getenv("FFMPEG_BINARY")
        if configured:
            return configured
        discovered = shutil.which("ffmpeg")
        if discovered:
            return discovered
        return imageio_ffmpeg.get_ffmpeg_exe()

    @staticmethod
    def _ffmpeg_concat_path(path: Path) -> str:
        return str(path.resolve()).replace("\\", "/").replace("'", "'\\''")

    async def _ensure_doubao_uploaded_reference(
        self,
        task: Dict[str, Any],
        request_data: Dict[str, Any],
        cookie: Optional[str] = None,
    ) -> Dict[str, Any]:
        references = self._extract_reference_images(request_data)
        if not references:
            return request_data

        # 逐张确保已上传到豆包（已有 file_key 的直接复用），全部转成 attachmentStates，
        # 下游 _prepare_reference_attachment_states 据此构造豆包多图 ref_images。
        uploaded_list: list[Dict[str, Any]] = []
        for reference in references:
            if reference.get("file_key"):
                uploaded_list.append(reference)
            else:
                uploaded_list.append(
                    await self._upload_reference_image_to_doubao(reference, cookie=cookie)
                )

        attachment_states = [
            self._normalize_attachment_state(item, index)
            for index, item in enumerate(uploaded_list)
        ]

        updated_request = dict(request_data)
        updated_request["attachmentStates"] = attachment_states
        # 保留单数 reference_image 以兼容 meta / mock / 旧逻辑（用第一张）
        updated_request["reference_image"] = uploaded_list[0]
        updated_request.pop("images", None)
        task["reference_image"] = self._extract_reference_image(updated_request)
        task["reference_image_meta"] = self._reference_image_meta(task["reference_image"])
        return updated_request

    async def _upload_reference_image_to_doubao(
        self,
        reference_image: Dict[str, Any],
        cookie: Optional[str] = None,
    ) -> Dict[str, Any]:
        if not self.client or not self.credential_manager or not self.playwright_manager:
            raise RuntimeError("doubao_web provider is not initialized.")

        if cookie is None:
            account_count = max(1, int(self.credential_manager.snapshot().get("account_count") or 1))
            max_attempts = min(account_count, settings.DOUBAO_VIDEO_ACCOUNT_RETRY_LIMIT)
            last_upload_error: Optional[BaseException] = None
            for attempt in range(1, max_attempts + 1):
                async with self.credential_manager.acquire() as lease:
                    try:
                        return await self._upload_reference_image_to_doubao(
                            reference_image,
                            self._get_dynamic_cookie(lease.cookie),
                        )
                    except Exception as exc:
                        if self._is_retryable_upload_error(exc):
                            lease.mark_failure(exc)
                            last_upload_error = exc
                            logger.warning(
                                "Reference image upload auth failed for account "
                                f"#{lease.index} on attempt {attempt}/{max_attempts}; retrying: {exc}"
                            )
                            if self._can_retry_with_another_credential(0):
                                continue
                        raise
            if last_upload_error:
                raise last_upload_error
            raise RuntimeError("No available Doubao credential for reference image upload.")

        raw = await self._reference_image_bytes(reference_image)
        file_name = reference_image.get("file_name") or "reference.jpg"
        file_size = len(raw)
        mime_type = reference_image.get("mime_type") or mimetypes.guess_type(file_name)[0] or "image/jpeg"
        extension = Path(file_name).suffix.lower() or f".{self._extension_from_mime(mime_type)}"
        if extension == ".jpeg":
            extension = ".jpg"
        if extension not in IMAGE_UPLOAD_EXTENSIONS:
            raise HTTPException(status_code=400, detail=f"Unsupported reference image extension: {extension}")

        logger.info(f"Uploading reference image to doubao_web: name={file_name}, size={file_size}")
        prepare = await self._prepare_doubao_image_upload(cookie)
        service_id = prepare.get("service_id")
        auth_token = prepare.get("upload_auth_token") or {}
        if not service_id:
            raise RetryableUploadAuthError("prepare_upload did not return service_id.")
        if not auth_token.get("access_key") or not auth_token.get("secret_key") or not auth_token.get("session_token"):
            raise RetryableUploadAuthError("prepare_upload did not return a complete upload auth token.")

        upload_address = await self._apply_doubao_image_upload(
            service_id=service_id,
            auth_token=auth_token,
            file_size=file_size,
            extension=extension,
        )
        upload_candidates = self._upload_address_candidates(upload_address)
        last_upload_error: Optional[BaseException] = None
        committed: Optional[Dict[str, Any]] = None
        store_uri = ""
        for store_info, upload_host, session_key in upload_candidates:
            store_uri = str(store_info.get("StoreUri") or "")
            store_auth = str(store_info.get("Auth") or "")
            if not store_uri or not store_auth:
                continue
            try:
                await self._post_doubao_image_bytes(upload_host, store_uri, store_auth, raw)
                committed = await self._commit_doubao_image_upload(service_id, auth_token, session_key)
                break
            except Exception as exc:
                if self._is_retryable_upload_error(exc):
                    last_upload_error = exc
                    logger.warning(f"TOS image upload failed through host {upload_host}; trying next host: {exc}")
                    continue
                raise
        if committed is None:
            if last_upload_error:
                raise RetryableUploadAuthError(f"All TOS image upload hosts failed: {last_upload_error}") from last_upload_error
            raise RuntimeError("ApplyImageUpload did not return a usable upload address.")
        plugin_result = self._select_commit_plugin_result(committed)

        image_uri = plugin_result.get("ImageUri") or plugin_result.get("SourceUri") or store_uri
        width = plugin_result.get("ImageWidth")
        height = plugin_result.get("ImageHeight")
        if not width or not height:
            width, height = inspect_image_dimensions(raw)

        local_key = f"local_{uuid.uuid4().hex}"
        uploaded = {
            "fileKey": image_uri,
            "file_key": image_uri,
            "localKey": local_key,
            "local_key": local_key,
            "fileName": file_name,
            "file_name": file_name,
            "mimeType": mime_type,
            "mime_type": mime_type,
            "size": file_size,
            "imageWidth": int(width or 0),
            "imageHeight": int(height or 0),
            "image_width": int(width or 0),
            "image_height": int(height or 0),
            "md5": plugin_result.get("ImageMd5") or hashlib.md5(raw).hexdigest(),
            "imageFormat": plugin_result.get("ImageFormat"),
            "kind": "doubao_uploaded",
        }
        logger.info(
            "Reference image uploaded to doubao_web: "
            f"uri={image_uri}, width={uploaded['imageWidth']}, height={uploaded['imageHeight']}"
        )
        return uploaded

    async def _prepare_doubao_image_upload(self, cookie: str) -> Dict[str, Any]:
        if not self.client or not self.playwright_manager:
            raise RuntimeError("doubao_web provider is not initialized.")

        url = "https://www.doubao.com/alice/resource/prepare_upload"
        signed_url = await self.playwright_manager.get_signed_url(url, cookie, self._base_params(include_fp=False))
        if not signed_url:
            raise RuntimeError("Unable to generate a_bogus signature for prepare_upload.")

        headers = self._prepare_json_headers(cookie)
        response = await self.client.post(
            signed_url,
            headers=headers,
            json={"tenant_id": "5", "scene_id": "5", "resource_type": 2},
        )
        new_ms_token = response.headers.get("x-ms-token")
        if new_ms_token:
            self.playwright_manager.update_ms_token(new_ms_token, cookie)
        data = self._checked_json_response(response, "prepare_upload")
        if data.get("code") not in (None, 0, "0"):
            summary = prepare_upload_response_summary(data)
            logger.warning(f"prepare_upload failed response: {json.dumps(summary, ensure_ascii=False)[:2000]}")
            raise RetryableUploadAuthError(
                f"prepare_upload failed: {data.get('msg') or data.get('message') or data.get('code')}"
            )

        payload = data.get("data") if isinstance(data.get("data"), dict) else data
        prepared = normalize_prepare_upload_data(payload)
        if not prepared.get("service_id") or not (prepared.get("upload_auth_token") or {}).get("access_key"):
            summary = prepare_upload_response_summary(data)
            logger.warning(f"prepare_upload missing upload auth fields: {json.dumps(summary, ensure_ascii=False)[:2000]}")
        return prepared

    async def _apply_doubao_image_upload(
        self,
        service_id: str,
        auth_token: Dict[str, str],
        file_size: int,
        extension: str,
    ) -> Dict[str, Any]:
        if not self.client:
            raise RuntimeError("doubao_web provider is not initialized.")

        url = "https://www.doubao.com/top/v1"
        params = {
            "Action": "ApplyImageUpload",
            "Version": "2018-08-01",
            "ServiceId": service_id,
            "NeedFallback": "true",
            "FileSize": str(file_size),
            "FileExtension": extension,
            "s": random_upload_nonce(),
        }
        headers = sign_imagex_request("GET", url, params, b"", auth_token, include_content_sha256=False)
        headers["Referer"] = "https://www.doubao.com/chat/"
        response = await self.client.get(url, params=params, headers=headers)
        return self._checked_json_response(response, "ApplyImageUpload")

    async def _post_doubao_image_bytes(
        self,
        upload_host: str,
        store_uri: str,
        store_auth: str,
        raw: bytes,
    ) -> None:
        if not self.client:
            raise RuntimeError("doubao_web provider is not initialized.")

        host = upload_host if upload_host.startswith(("http://", "https://")) else f"https://{upload_host}"
        upload_url = f"{host.rstrip('/')}/upload/v1/{store_uri}"
        headers = {
            "Authorization": store_auth,
            "Content-Type": "application/octet-stream",
            "Content-CRC32": format(zlib.crc32(raw) & 0xFFFFFFFF, "08x"),
            "Referer": "https://www.doubao.com/",
        }
        try:
            response = await self.client.post(upload_url, headers=headers, content=raw)
        except httpx.TransportError as exc:
            raise RetryableUploadAuthError(f"TOS image upload network error: {exc}") from exc
        data = self._checked_json_response(response, "TOS image upload")
        if data.get("code") != 2000:
            raise RuntimeError(f"TOS image upload failed: {data.get('message') or data.get('code')}")

    async def _commit_doubao_image_upload(
        self,
        service_id: str,
        auth_token: Dict[str, str],
        session_key: str,
    ) -> Dict[str, Any]:
        if not self.client:
            raise RuntimeError("doubao_web provider is not initialized.")

        url = "https://www.doubao.com/top/v1"
        params = {
            "Action": "CommitImageUpload",
            "Version": "2018-08-01",
            "ServiceId": service_id,
        }
        body = json.dumps({"SessionKey": session_key}, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
        headers = sign_imagex_request("POST", url, params, body, auth_token, include_content_sha256=True)
        headers.update({
            "Content-Type": "application/json",
            "Referer": "https://www.doubao.com/chat/",
        })
        response = await self.client.post(url, params=params, headers=headers, content=body)
        return self._checked_json_response(response, "CommitImageUpload")

    def _upload_address_candidates(self, data: Dict[str, Any]) -> list[tuple[Dict[str, Any], str, str]]:
        result = data.get("Result") or {}
        candidates: list[tuple[Dict[str, Any], str, str]] = []
        seen: set[tuple[str, str, str]] = set()

        def add_address(address: Dict[str, Any]) -> None:
            store_infos = address.get("StoreInfos") or []
            upload_hosts = address.get("UploadHosts") or []
            session_key = str(address.get("SessionKey") or "")
            if not store_infos or not upload_hosts or not session_key:
                return
            for store_info in store_infos:
                store_uri = str(store_info.get("StoreUri") or "")
                for upload_host in upload_hosts:
                    key = (store_uri, str(upload_host), session_key)
                    if key not in seen:
                        seen.add(key)
                        candidates.append((store_info, str(upload_host), session_key))

        add_address(result.get("UploadAddress") or {})
        for inner in (((result.get("InnerUploadAddress") or {}).get("UploadNodes")) or []):
            if isinstance(inner, dict):
                add_address(inner)

        if not candidates:
            raise RuntimeError("ApplyImageUpload returned an incomplete upload address.")
        return candidates

    def _select_upload_address(self, data: Dict[str, Any]) -> tuple[Dict[str, Any], str, str]:
        return self._upload_address_candidates(data)[0]

    def _select_commit_plugin_result(self, data: Dict[str, Any]) -> Dict[str, Any]:
        plugin_results = ((data.get("Result") or {}).get("PluginResult")) or []
        if not plugin_results:
            raise RuntimeError("CommitImageUpload did not return PluginResult.")
        return plugin_results[0]

    def _checked_json_response(self, response: httpx.Response, label: str) -> Dict[str, Any]:
        if response.status_code != 200:
            raise RuntimeError(f"{label} returned {response.status_code}: {response.text[:500]}")
        try:
            return response.json()
        except Exception as exc:
            raise RuntimeError(f"{label} returned non-JSON response: {response.text[:500]}") from exc

    async def _reference_image_bytes(self, reference_image: Dict[str, Any]) -> bytes:
        if reference_image.get("bytes"):
            return reference_image["bytes"]
        if reference_image.get("path"):
            return Path(reference_image["path"]).read_bytes()
        if reference_image.get("url"):
            if not self.client:
                raise RuntimeError("HTTP client is not initialized.")
            response = await self.client.get(reference_image["url"])
            response.raise_for_status()
            return response.content
        raise HTTPException(status_code=400, detail="reference_image must include image bytes, path, or URL.")

    def _mock_uploaded_reference_image(self, reference_image: Dict[str, Any]) -> Dict[str, Any]:
        raw = reference_image.get("bytes") or b""
        width, height = inspect_image_dimensions(raw) if raw else (None, None)
        file_name = reference_image.get("file_name") or "reference.png"
        file_key = f"mock://image/{hashlib.sha256(raw or file_name.encode('utf-8')).hexdigest()[:24]}"
        local_key = f"local_{uuid.uuid4().hex}"
        return {
            "fileKey": file_key,
            "file_key": file_key,
            "localKey": local_key,
            "local_key": local_key,
            "fileName": file_name,
            "file_name": file_name,
            "mimeType": reference_image.get("mime_type") or "image/png",
            "mime_type": reference_image.get("mime_type") or "image/png",
            "size": int(reference_image.get("size") or len(raw)),
            "imageWidth": int(width or 0),
            "imageHeight": int(height or 0),
            "image_width": int(width or 0),
            "image_height": int(height or 0),
            "md5": hashlib.md5(raw).hexdigest() if raw else "",
            "kind": "doubao_uploaded",
        }

    async def _consume_sse_line(self, task: Dict[str, Any], line: str) -> None:
        if not line or not line.startswith("data:"):
            return
        content = line[len("data:"):].strip()
        if not content:
            return

        event = maybe_json(content)
        if isinstance(event, str):
            task["debug"]["events"].append({"raw": content[:2000]})
            return

        task["debug"]["events"].append(event)
        if len(task["debug"]["events"]) > 50:
            task["debug"]["events"] = task["debug"]["events"][-50:]

        signals = extract_video_signals(event)
        self._merge_signals(task, signals)
        await self._sync_video_quota_from_task(task)
        self._set_result_from_signals(task)

    def _record_sse_line(self, task: Dict[str, Any], line: str) -> None:
        lines = task["debug"].setdefault("sse_lines", [])
        lines.append(truncate_debug_text(line, DEBUG_TEXT_LIMIT))
        if len(lines) > DEBUG_SSE_LINE_LIMIT:
            del lines[:-DEBUG_SSE_LINE_LIMIT]

    def _debug_browser_trigger_context(self, context: Dict[str, Any]) -> Dict[str, Any]:
        def trim(value: Any, limit: int = 1000) -> Any:
            if isinstance(value, str):
                return truncate_debug_text(value, limit)
            if isinstance(value, dict):
                return {str(key): trim(child, limit) for key, child in value.items()}
            if isinstance(value, list):
                return [trim(child, limit) for child in value[:20]]
            return value

        return trim(context, 1000)

    def _attach_context_template_comparison(self, task: Dict[str, Any], payload: Dict[str, Any]) -> None:
        account_index = task.get("credential_index")
        if account_index is None:
            return
        try:
            template = load_latest_context_template(int(account_index))
            task["debug"]["context_template_comparison"] = compare_payload_to_template(payload, template)
        except Exception as exc:
            task["debug"]["context_template_comparison"] = {
                "template_found": False,
                "error": str(exc)[:500],
            }

    def _verification_context_with_trigger_context(
        self,
        task: Dict[str, Any],
        verification_context: Dict[str, Any],
    ) -> Dict[str, Any]:
        context = dict(verification_context)
        trigger = task.get("debug", {}).get("browser_trigger_context")
        if not isinstance(trigger, dict):
            return context

        probe = self._trigger_context_probe(trigger)
        after = trigger.get("after") if isinstance(trigger.get("after"), dict) else {}
        watch = trigger.get("watch") if isinstance(trigger.get("watch"), dict) else {}
        snapshot_path = after.get("snapshot_path")
        visible = bool(trigger.get("visible_challenge_detected"))
        solver = bool(trigger.get("solver_compatible"))
        container_state = "none"
        if probe.get("container_visible"):
            container_state = "visible"
        elif probe.get("container_present"):
            container_state = "hidden"

        context.update(
            {
                "trigger_kind": str(trigger.get("kind") or "chat_completion_fetch"),
                "trigger_request_url": truncate_debug_text(trigger.get("request_url") or "", 1000),
                "trigger_visible_challenge": str(visible).lower(),
                "trigger_solver_compatible": str(solver).lower(),
                "trigger_captcha_container": container_state,
                "trigger_captcha_images": str(int(probe.get("image_count") or 0)),
                "trigger_probe_samples": str(int(watch.get("samples") or 0)),
                "trigger_page_url": truncate_debug_text(trigger.get("page_url") or "", 500),
            }
        )
        if snapshot_path:
            context["trigger_snapshot_path"] = truncate_debug_text(snapshot_path, 500)
        prompt_text = str(probe.get("prompt_text") or "").strip()
        if prompt_text:
            context["trigger_captcha_prompt"] = truncate_debug_text(prompt_text, 500)
        return context

    def _trigger_context_probe(self, trigger: Dict[str, Any]) -> Dict[str, Any]:
        candidates = []
        watch = trigger.get("watch")
        after = trigger.get("after")
        before = trigger.get("before")
        if isinstance(watch, dict):
            candidates.append(watch.get("captcha_probe"))
        if isinstance(after, dict):
            candidates.append(after.get("captcha_probe"))
        if isinstance(before, dict):
            candidates.append(before.get("captcha_probe"))
        for candidate in candidates:
            if isinstance(candidate, dict) and (
                candidate.get("container_present")
                or candidate.get("container_visible")
                or candidate.get("image_count")
                or candidate.get("solver_compatible")
            ):
                return candidate
        for candidate in candidates:
            if isinstance(candidate, dict):
                return candidate
        return {}

    def _write_upstream_debug(self, task: Dict[str, Any]) -> None:
        try:
            self.output_dir.parent.mkdir(parents=True, exist_ok=True)
            path = self.output_dir.parent / f"upstream-debug-{task['id']}.json"
            debug = {
                "id": task["id"],
                "object": task.get("object"),
                "created": task.get("created"),
                "status": task["status"],
                "model": task.get("model"),
                "prompt": task.get("prompt"),
                "credential_index": task.get("credential_index"),
                "params": task.get("params"),
                "reference_image": task.get("reference_image_meta"),
                "error": task.get("error"),
                "result": task.get("result"),
                "debug": task.get("debug", {}),
            }
            tmp_path = path.with_name(f".{path.name}.{uuid.uuid4().hex}.tmp")
            tmp_path.write_text(json.dumps(debug, ensure_ascii=False, indent=2), encoding="utf-8")
            tmp_path.replace(path)
            task["debug"]["debug_file"] = str(path)
        except Exception as exc:
            logger.warning(f"Unable to write upstream debug file for {task.get('id')}: {exc}")

    def _debug_request_summary(self, payload: Dict[str, Any]) -> Dict[str, Any]:
        messages = payload.get("messages") or []
        message = messages[0] if messages else {}
        blocks = message.get("content_block") or []
        attachments = message.get("attachments") or []
        message_ext = message.get("ext") or {}
        top_level_ext = payload.get("ext") or {}
        ability_param: Dict[str, Any] = {}
        chat_ability = payload.get("chat_ability") or {}
        parsed_ability = maybe_json(chat_ability.get("ability_param"))
        if isinstance(parsed_ability, dict):
            ability_param = parsed_ability
        input_skill = maybe_json(top_level_ext.get("input_skill") or message_ext.get("input_skill"))

        ext_probe_keys = (
            "attachment_scene",
            "biz_content_type",
            "chat_ability",
            "client_report_scene",
            "image_attachment_num",
            "input_skill",
            "is_image_related",
            "llm_model_type",
            "message_from",
            "model_type",
            "samantha_context",
            "use_content_block",
        )

        return {
            "client_meta": payload.get("client_meta"),
            "message_keys": sorted(message.keys()),
            "message_content_type": message.get("content_type"),
            "message_biz_content_type": message.get("biz_content_type"),
            "message_ext_keys": sorted(message_ext.keys()),
            "block_types": [block.get("block_type") for block in blocks if isinstance(block, dict)],
            "attachment_count": len(attachments),
            "content_block_attachment_count": sum(
                len(
                    ((block.get("content") or {}).get("attachment_block") or {}).get("attachments") or []
                )
                for block in blocks
                if isinstance(block, dict)
            ),
            "skill": message.get("skill"),
            "input_skill": input_skill if isinstance(input_skill, dict) else input_skill,
            "ability_type": chat_ability.get("ability_type"),
            "ability_param": ability_param,
            "top_level_ext_keys": sorted(top_level_ext.keys()),
            "message_ext_probe": {
                key: message_ext.get(key)
                for key in ext_probe_keys
                if key in message_ext
            },
            "top_level_ext_probe": {
                key: top_level_ext.get(key)
                for key in ext_probe_keys
                if key in top_level_ext
            },
        }

    async def _poll_doubao_chain(
        self,
        task: Dict[str, Any],
        cookie: str,
        conversation_id: str,
        request_data: Optional[Dict[str, Any]] = None,
    ) -> None:
        self._release_video_submit_slot(task)
        queue_debug = task.setdefault("debug", {}).setdefault("frontend_queues", {})
        queue_debug["account_index"] = task.get("credential_index")
        wait_state, wait_slot = await self._acquire_frontend_stage("result_wait", queue_debug)
        try:
            await self._poll_doubao_chain_unlimited(
                task,
                cookie,
                conversation_id,
                request_data,
            )
        finally:
            self._release_frontend_stage(wait_state, wait_slot)

    async def _poll_doubao_chain_unlimited(
        self,
        task: Dict[str, Any],
        cookie: str,
        conversation_id: str,
        request_data: Optional[Dict[str, Any]] = None,
    ) -> None:
        if not self.client or not self.playwright_manager:
            raise RuntimeError("doubao_web provider is not initialized.")

        url = "https://www.doubao.com/im/chain/single"
        headers = self._prepare_chain_headers(cookie, conversation_id)
        payload = self._prepare_chain_payload(conversation_id)
        poll_interval, max_attempts = self._polling_config(request_data or {})
        task["debug"]["polling"] = {
            "conversation_id": conversation_id,
            "poll_interval": poll_interval,
            "max_attempts": max_attempts,
        }

        for attempt in range(max_attempts):
            task["debug"]["polling"]["attempt"] = attempt + 1
            if settings.DOUBAO_VIDEO_TRANSPORT == "browser":
                browser_response = await self.playwright_manager.post_json(
                    url,
                    cookie,
                    self._base_params(include_fp=False),
                    payload,
                    headers=headers,
                    timeout_seconds=settings.API_REQUEST_TIMEOUT,
                )
                status_code = int(browser_response.get("status_code") or 0)
                response_headers = {
                    str(key).lower(): str(value)
                    for key, value in (browser_response.get("headers") or {}).items()
                }
                response_text = str(browser_response.get("text") or "")
            else:
                signed_url = await self.playwright_manager.get_signed_url(
                    url,
                    cookie,
                    self._base_params(include_fp=False),
                )
                if not signed_url:
                    raise RuntimeError("Unable to generate a_bogus signature for chain polling.")
                response = await self.client.post(signed_url, headers=headers, json=payload)
                status_code = response.status_code
                response_headers = {
                    str(key).lower(): str(value)
                    for key, value in response.headers.items()
                }
                response_text = response.text

            new_ms_token = response_headers.get("x-ms-token")
            if new_ms_token:
                self.playwright_manager.update_ms_token(new_ms_token, cookie)
            if status_code != 200:
                logger.warning(f"chain polling returned {status_code}: {response_text[:500]}")
            else:
                data = json.loads(response_text)
                task["debug"].setdefault("chain_events", []).append(data)
                if len(task["debug"]["chain_events"]) > 10:
                    task["debug"]["chain_events"] = task["debug"]["chain_events"][-10:]
                self._merge_signals(task, extract_video_signals(data))
                await self._sync_video_quota_from_task(task)
                self._set_result_from_signals(task)
                self._write_upstream_debug(task)
                if task["result"] or task["error"]:
                    return

            task["status"] = "polling"
            await asyncio.sleep(1 if attempt == 0 else poll_interval)

        elapsed = poll_interval * max_attempts
        message = f"Doubao chain polling timed out after {elapsed:g}s without a final video URL."
        task["status"] = "failed"
        task["error"] = {"message": message, "type": "timeout_error", "code": "video_poll_timeout"}
        self._mark_task_terminal(task)
        self._write_upstream_debug(task)

    def _polling_config(self, request_data: Dict[str, Any]) -> tuple[float, int]:
        poll_interval = self._bounded_float(request_data.get("poll_interval"), 5, minimum=1, maximum=30)
        default_timeout = max(float(settings.API_REQUEST_TIMEOUT), 300.0)
        poll_timeout = self._bounded_float(
            request_data.get("poll_timeout"),
            default_timeout,
            minimum=poll_interval,
            maximum=1800,
        )
        return poll_interval, max(1, int(math.ceil(poll_timeout / poll_interval)))

    @staticmethod
    def _bounded_float(value: Any, default: float, *, minimum: float, maximum: float) -> float:
        try:
            parsed = float(value)
        except (TypeError, ValueError):
            parsed = default
        if not math.isfinite(parsed):
            parsed = default
        return max(minimum, min(parsed, maximum))

    def _get_dynamic_cookie(self, base_cookie: str) -> str:
        if not self.playwright_manager:
            return base_cookie
        latest_ms_token = self.playwright_manager.get_ms_token(base_cookie)
        if not latest_ms_token:
            return base_cookie
        if "msToken=" in base_cookie:
            return re.sub(r"msToken=[^;]+", f"msToken={latest_ms_token}", base_cookie)
        return f"{base_cookie.strip(';')}; msToken={latest_ms_token}"

    async def _effective_doubao_cookie(self, base_cookie: str) -> str:
        return self._get_dynamic_cookie(base_cookie)

    def _base_params(self, include_fp: bool = True) -> Dict[str, str]:
        params = {
            "aid": "497858",
            "channel": settings.DOUBAO_VIDEO_CHANNEL,
            "device_platform": "web",
            "language": "zh",
            "pc_version": settings.DOUBAO_VIDEO_PC_VERSION,
            "pkg_type": "release_version",
            "real_aid": "497858",
            "region": "CN",
            "samantha_web": "1",
            "sys_region": "CN",
            "use-olympus-account": "1",
            "version_code": "20800",
            "web_platform": "browser",
        }
        if include_fp:
            params["fp"] = settings.DOUBAO_FP
        return params

    def _history_base_params(self) -> Dict[str, str]:
        params = self._base_params(include_fp=False)
        params.pop("channel", None)
        return params

    def _prepare_headers(self, cookie: str) -> Dict[str, str]:
        headers = {
            "Accept": "*/*",
            "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
            "Content-Type": "application/json",
            "Cookie": cookie,
            "Origin": "https://www.doubao.com",
            "Referer": "https://www.doubao.com/chat/",
            "agw-js-conv": "str, str",
            "last-event-id": "undefined",
            "x-flow-trace": f"04-{secrets.token_hex(16)}-{secrets.token_hex(8)}-01",
            "sec-fetch-dest": "empty",
            "sec-fetch-mode": "cors",
            "sec-fetch-site": "same-origin",
        }
        headers.update(getattr(self.playwright_manager, "browser_headers", {}))
        return headers

    def _prepare_chain_headers(self, cookie: str, conversation_id: str) -> Dict[str, str]:
        headers = self._prepare_headers(cookie)
        headers.update({
            "Accept": "application/json, text/plain, */*",
            "Content-Type": "application/json; encoding=utf-8",
            "agw-js-conv": "str",
            "Referer": f"https://www.doubao.com/chat/{conversation_id}?channel={settings.DOUBAO_VIDEO_CHANNEL}",
        })
        headers.pop("last-event-id", None)
        return headers

    def _prepare_json_headers(self, cookie: str) -> Dict[str, str]:
        headers = {
            "Accept": "application/json, text/plain, */*",
            "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
            "Content-Type": "application/json",
            "Cookie": cookie,
            "Origin": "https://www.doubao.com",
            "Referer": "https://www.doubao.com/chat/",
            "agw-js-conv": "str",
            "sec-fetch-dest": "empty",
            "sec-fetch-mode": "cors",
            "sec-fetch-site": "same-origin",
        }
        headers.update(getattr(self.playwright_manager, "browser_headers", {}))
        return headers

    @staticmethod
    def _prepare_history_headers() -> Dict[str, str]:
        return {
            "Accept": "application/json, text/plain, */*",
            "Content-Type": "application/json; encoding=utf-8",
            "agw-js-conv": "str",
        }

    def _prepare_doubao_video_payload(
        self,
        request_data: Dict[str, Any],
        prompt: str,
        model: str,
        *,
        request_fingerprint: Optional[str] = None,
    ) -> Dict[str, Any]:
        local_conversation_id = request_data.get("conversation_id") or f"local_{uuid.uuid4().hex[:16]}"
        local_message_id = str(uuid.uuid1())
        params = self._normalize_video_params(request_data, model)
        attachment_states = self._prepare_reference_attachment_states(request_data)
        if attachment_states:
            return self._prepare_current_doubao_i2v_payload(
                request_data,
                prompt,
                params,
                attachment_states,
                request_fingerprint=request_fingerprint,
            )

        upstream_prompt = self._doubao_video_prompt(prompt, params, has_reference_image=bool(attachment_states))
        ability_param = self._ability_param(params)
        input_skill = self._video_input_skill()
        ext_chat_ability = {
            "ability_type": settings.DOUBAO_VIDEO_ABILITY_TYPE,
            "ability_param": json.dumps(ability_param, ensure_ascii=False),
        }
        video_ext = self._video_request_ext(
            input_skill,
            ext_chat_ability,
            attachment_states,
            request_fingerprint=request_fingerprint,
        )
        attachments = [self._legacy_image_attachment(item) for item in attachment_states]
        content_blocks = [
            *self._attachment_content_blocks(attachment_states),
            self._text_content_block(upstream_prompt),
        ]

        return {
            "client_meta": {
                "local_conversation_id": local_conversation_id,
                "conversation_id": "",
                "bot_id": settings.DOUBAO_VIDEO_BOT_ID,
                "last_section_id": "",
                "last_message_index": None,
            },
            "messages": [
                {
                    "local_message_id": local_message_id,
                    "content_type": 9999,
                    "skill": {
                        "skill_id": str(settings.DOUBAO_VIDEO_SKILL_TYPE),
                        "skill_type": settings.DOUBAO_VIDEO_SKILL_TYPE,
                    },
                    "content_block": content_blocks,
                    "message_status": 0,
                    "attachments": attachments,
                    "ext": video_ext,
                }
            ],
            "option": {
                "send_message_scene": "",
                "create_time_ms": int(time.time() * 1000),
                "collect_id": "",
                "is_audio": False,
                "answer_with_suggest": False,
                "tts_switch": False,
                "need_deep_think": 0,
                "click_clear_context": False,
                "from_suggest": False,
                "is_regen": False,
                "is_replace": False,
                "is_from_click_option": False,
                "disable_sse_cache": False,
                "select_text_action": "",
                "is_select_text": False,
                "resend_for_regen": False,
                "scene_type": 0,
                "unique_key": str(uuid.uuid4()),
                "start_seq": 0,
                "need_create_conversation": True,
                "conversation_init_option": {"need_ack_conversation": True},
                "regen_query_id": [],
                "edit_query_id": [],
                "regen_instruction": "",
                "no_replace_for_regen": False,
                "message_from": 0,
                "shared_app_name": "",
                "shared_app_id": "",
                "sse_recv_event_options": {"support_chunk_delta": True},
                "is_ai_playground": False,
                "is_old_user": True,
                "recovery_option": {
                    "is_recovery": False,
                    "req_create_time_sec": int(time.time()),
                    "append_sse_event_scene": 0,
                },
                "message_storage_type": 0,
            },
            "chat_ability": {
                "ability_type": settings.DOUBAO_VIDEO_ABILITY_TYPE,
                "ability_param": json.dumps(ability_param, ensure_ascii=False),
            },
            "user_context": [],
            "ext": video_ext,
        }

    def _prepare_current_doubao_i2v_payload(
        self,
        request_data: Dict[str, Any],
        prompt: str,
        params: Dict[str, Any],
        attachment_states: list[Dict[str, Any]],
        *,
        request_fingerprint: Optional[str] = None,
    ) -> Dict[str, Any]:
        local_conversation_id = request_data.get("conversation_id")
        if not local_conversation_id:
            local_conversation_id = f"local_{secrets.randbelow(10**16):016d}"
        collection_id = str(uuid.uuid4())
        now_ms = int(time.time() * 1000)
        current_attachments = [
            {**item, "localKey": str(uuid.uuid1())}
            for item in attachment_states
        ]

        return {
            "client_meta": {
                "local_conversation_id": local_conversation_id,
                "conversation_id": "",
                "bot_id": settings.DOUBAO_VIDEO_BOT_ID,
                "last_section_id": "",
                "last_message_index": None,
            },
            "messages": [
                {
                    "local_message_id": str(uuid.uuid1()),
                    "content_block": self._attachment_content_blocks(current_attachments),
                    "message_status": 0,
                },
                {
                    "local_message_id": str(uuid.uuid4()),
                    "content_block": [self._text_content_block(f"生成视频：{prompt.strip()}")],
                    "message_status": 0,
                },
            ],
            "option": {
                "send_message_scene": "",
                "create_time_ms": now_ms,
                "collect_id": collection_id,
                "is_audio": False,
                "answer_with_suggest": False,
                "tts_switch": False,
                "need_deep_think": 0,
                "click_clear_context": False,
                "from_suggest": False,
                "is_regen": False,
                "is_replace": False,
                "is_from_click_option": False,
                "disable_sse_cache": False,
                "select_text_action": "",
                "is_select_text": False,
                "resend_for_regen": False,
                "scene_type": 0,
                "unique_key": str(uuid.uuid4()),
                "start_seq": 0,
                "need_create_conversation": True,
                "conversation_init_option": {"need_ack_conversation": True},
                "regen_query_id": [],
                "edit_query_id": [],
                "regen_instruction": "",
                "no_replace_for_regen": False,
                "message_from": 0,
                "shared_app_name": "",
                "shared_app_id": "",
                "sse_recv_event_options": {"support_chunk_delta": True},
                "is_ai_playground": False,
                "is_old_user": True,
                "recovery_option": {
                    "is_recovery": False,
                    "req_create_time_sec": now_ms // 1000,
                    "append_sse_event_scene": 0,
                },
                "message_storage_type": 0,
            },
            "chat_ability": {
                "ability_type": settings.DOUBAO_VIDEO_ABILITY_TYPE,
                "ability_param": json.dumps(
                    {
                        "model": params["model"],
                        "duration": params["duration"],
                    },
                    ensure_ascii=False,
                    separators=(",", ":"),
                ),
            },
            "user_context": [],
            "ext": {
                "answer_with_suggest": "0",
                "fp": request_fingerprint or settings.DOUBAO_FP,
                "sub_conv_firstmet_type": "1",
                "collection_id": collection_id,
                "conversation_init_option": json.dumps(
                    {"need_ack_conversation": True},
                    ensure_ascii=False,
                    separators=(",", ":"),
                ),
                "commerce_credit_config_enable": "0",
            },
        }

    def _doubao_video_prompt(self, prompt: str, params: Dict[str, Any], *, has_reference_image: bool) -> str:
        user_prompt = prompt.strip()
        duration = int(params["duration"])
        ratio = params["ratio"]
        resolution = params["resolution"]
        model_name = params["model"]
        if _has_video_prompt_intent(user_prompt):
            return user_prompt

        reference_clause = "基于已上传的参考图，保持参考图主体、身份、服装和画面风格一致，" if has_reference_image else ""
        return (
            f"{reference_clause}使用 {model_name} 生成 {duration} 秒 {ratio} {resolution} 视频，"
            f"只输出动态视频，不要生成图片或图片编辑结果。动作/内容要求：{user_prompt}"
        )

    def _video_request_ext(
        self,
        input_skill: Dict[str, Any],
        ext_chat_ability: Dict[str, Any],
        attachment_states: list[Dict[str, Any]],
        *,
        request_fingerprint: Optional[str] = None,
    ) -> Dict[str, str]:
        ext = {
            "answer_with_suggest": "0",
            "chat_next": "1",
            "collection_id": "",
            "commerce_credit_config_enable": "0",
            "conversation_init_option": json.dumps({"need_ack_conversation": True}, ensure_ascii=False),
            "fp": request_fingerprint or settings.DOUBAO_FP,
            "input_skill": json.dumps(input_skill, ensure_ascii=False, separators=(",", ":")),
            "chat_ability": json.dumps(ext_chat_ability, ensure_ascii=False, separators=(",", ":")),
            "sub_conv_firstmet_type": "1",
            "use_creation": "1",
        }
        if attachment_states:
            ext.update(
                {
                    "attachment_scene": "4",
                    "image_attachment_num": str(len(attachment_states)),
                    "is_image_related": "1",
                    **self._reference_ext(attachment_states),
                }
            )
        return ext

    def _text_content_block(self, text: str) -> Dict[str, Any]:
        return {
            "block_type": DOUBAO_BLOCK_TEXT,
            "content": {
                "text_block": {
                    "text": text,
                    "icon_url": "",
                    "icon_url_dark": "",
                    "summary": "",
                },
                "pc_event_block": "",
            },
            "block_id": str(uuid.uuid4()),
            "parent_id": "",
            "meta_info": [],
            "append_fields": [],
        }

    def _attachment_content_blocks(self, attachment_states: list[Dict[str, Any]]) -> list[Dict[str, Any]]:
        if not attachment_states:
            return []
        return [
            {
                "block_type": DOUBAO_BLOCK_ATTACHMENT,
                "content": {
                    "attachment_block": {
                        "attachments": [
                            self._doubao_image_attachment(item)
                            for item in attachment_states
                        ]
                    },
                    "pc_event_block": "",
                },
                "block_id": str(uuid.uuid4()),
                "parent_id": "",
                "meta_info": [],
                "append_fields": [],
            }
        ]

    def _doubao_image_attachment(self, item: Dict[str, Any]) -> Dict[str, Any]:
        return {
            "type": DOUBAO_ATTACHMENT_TYPE_IMAGE,
            "identifier": item["localKey"],
            "image": {
                "name": item["fileName"],
                "uri": item["fileKey"],
                "image_ori": {
                    "url": "",
                    "width": item.get("imageWidth", 0),
                    "height": item.get("imageHeight", 0),
                    "format": "",
                    "url_formats": {},
                },
            },
            "parse_state": 0,
            "review_state": DOUBAO_REVIEW_STATE_ACCESS,
            "upload_status": DOUBAO_UPLOAD_STATUS_SUCCESS,
            "progress": 100,
            "src": "",
        }

    def _legacy_image_attachment(self, item: Dict[str, Any]) -> Dict[str, Any]:
        return {
            "type": "image",
            "fileKey": item["fileKey"],
            "localKey": item["localKey"],
            "identifier": item["localKey"],
            "fileName": item["fileName"],
            "size": item.get("size", 0),
            "mimeType": item.get("mimeType", "image/png"),
            "md5": item.get("md5"),
            "option": {
                "width": item.get("imageWidth", 0),
                "height": item.get("imageHeight", 0),
            },
            "image": {
                "key": item["fileKey"],
                "image_ori": {
                    "width": item.get("imageWidth", 0),
                    "height": item.get("imageHeight", 0),
                },
            },
        }

    def _prepare_chain_payload(self, conversation_id: str) -> Dict[str, Any]:
        return {
            "cmd": 3100,
            "uplink_body": {
                "pull_singe_chain_uplink_body": {
                    "conversation_id": conversation_id,
                    "anchor_index": 9007199254740991,
                    "conversation_type": 3,
                    "direction": 1,
                    "limit": 20,
                    "ext": {},
                    "filter": {"index_list": []},
                    "evaluate_ab_params": "",
                    "evaluate_common_params": "",
                }
            },
            "sequence_id": str(uuid.uuid4()),
            "channel": 2,
            "version": "1",
        }

    def _choose_conversation_id(self, signals: Dict[str, Any], request_data: Dict[str, Any]) -> Optional[str]:
        request_conversation_id = request_data.get("upstream_conversation_id") or request_data.get("conversation_id")
        if isinstance(request_conversation_id, str) and request_conversation_id and not request_conversation_id.startswith("local_"):
            return request_conversation_id
        conversation_ids = signals.get("conversation_ids") or []
        for conversation_id in conversation_ids:
            if conversation_id and not str(conversation_id).startswith("local_"):
                return str(conversation_id)
        return None

    def _merge_signals(self, task: Dict[str, Any], signals: Dict[str, Any]) -> None:
        merged = task["debug"].setdefault(
            "signals",
            empty_video_signals(),
        )
        for key, default in empty_video_signals().items():
            merged.setdefault(key, [] if isinstance(default, list) else default)
        for key in (
            "task_ids",
            "video_ids",
            "conversation_ids",
            "failures",
            "non_video_results",
            "quota",
            "verification",
        ):
            for item in signals.get(key, []):
                if item not in merged[key]:
                    merged[key].append(item)
        url_priorities = signals.get("_video_url_priorities") or {}
        for item in signals.get("video_urls", []):
            _record_video_url(
                merged,
                item,
                priority=int(url_priorities.get(item, VIDEO_URL_DEFAULT_PRIORITY)),
            )
        if signals.get("status"):
            merged["status"] = signals["status"]
        if signals.get("saw_video_intent"):
            merged["saw_video_intent"] = True

    async def _sync_video_quota_from_task(self, task: Dict[str, Any]) -> None:
        if not self.credential_manager:
            return
        account_index = task.get("credential_index")
        if account_index is None:
            return
        signals = task.get("debug", {}).get("signals") or {}
        quota_items = signals.get("quota") or []
        if not quota_items:
            return

        synced = task.setdefault("debug", {}).setdefault("quota_sync", [])
        already_synced = {
            item.get("message")
            for item in synced
            if isinstance(item, dict)
        }
        for quota in quota_items:
            if not isinstance(quota, dict):
                continue
            message = str(quota.get("message") or "")
            if message in already_synced:
                continue

            remaining = quota.get("remaining")
            cost = quota.get("cost")
            if remaining is None and not quota.get("exhausted"):
                continue
            current_task_quota_progress = self._is_current_task_quota_progress_signal(quota)
            if (
                not current_task_quota_progress
                and (quota.get("exhausted") or (remaining is not None and float(remaining) <= 0))
            ):
                account = await self.credential_manager.disable_for_quota_exhausted(
                    int(account_index),
                    message or "Doubao video quota remaining is 0.",
                    source="video_signal",
                )
            else:
                status = (
                    "exhausted"
                    if current_task_quota_progress and remaining is not None and float(remaining) <= 0
                    else "available"
                )
                account = await self.credential_manager.update_quota(
                    int(account_index),
                    remaining=remaining,
                    unit=quota.get("unit") or settings.DOUBAO_QUOTA_UNIT,
                    source=quota.get("source") or "video_signal",
                    status=status,
                    error=message if status == "exhausted" else None,
                )
            record = {
                "account_index": int(account_index),
                "remaining": remaining,
                "cost": cost,
                "status": account.get("quota", {}).get("status"),
                "message": message,
                "synced_at": time.time(),
            }
            synced.append(record)
            if len(synced) > 20:
                del synced[:-20]
            already_synced.add(message)

    def _set_result_from_signals(self, task: Dict[str, Any]) -> None:
        signals = task["debug"].setdefault(
            "signals",
            empty_video_signals(),
        )
        for key, default in empty_video_signals().items():
            signals.setdefault(key, [] if isinstance(default, list) else default)
        if signals["video_urls"]:
            upstream_video_url = signals["video_urls"][0]
            task["result"] = {
                "url": upstream_video_url,
                "upstream_url": upstream_video_url,
                "content_type": "video/mp4",
            }
            return

        required_quota = self._required_video_quota(task)
        for quota in signals.get("quota") or []:
            current_task_quota_progress = self._is_current_task_quota_progress_signal(quota)
            if isinstance(quota, dict) and quota.get("exhausted") and not current_task_quota_progress:
                remaining = quota.get("remaining")
                task["error"] = {
                    "message": quota.get("message") or "Doubao video generation daily limit reached.",
                    "type": "video_quota_insufficient",
                    "code": "video_quota_insufficient",
                    "remaining": 0 if remaining is None else remaining,
                    "required": required_quota,
                }
                return
            remaining = quota.get("remaining") if isinstance(quota, dict) else None
            required_for_signal = self._required_video_quota_from_signal(quota, required_quota)
            if (
                remaining is not None
                and required_for_signal > 0
                and float(remaining) < required_for_signal
                and not current_task_quota_progress
            ):
                message = quota.get("message") or (
                    f"Doubao video quota remaining {remaining:g} is less than required {required_for_signal:g}."
                )
                task["error"] = {
                    "message": message,
                    "type": "video_quota_insufficient",
                    "code": "video_quota_insufficient",
                    "remaining": remaining,
                    "required": required_for_signal,
                }
                return

        if signals["failures"]:
            failure = _select_failure(signals["failures"])
            message = failure.get("message") or GENERIC_UPSTREAM_FAILURE_MESSAGE
            verification_context = failure.get("verification")
            if not verification_context and signals.get("verification"):
                verification_context = signals["verification"][0]
            if verification_context:
                verification_context = self._verification_context_with_trigger_context(task, verification_context)
            task["error"] = {
                "message": message,
                "type": "upstream_error",
                "code": failure.get("code"),
            }
            if verification_context:
                task["error"]["verification"] = verification_context
            return

        if signals["non_video_results"] and not signals["video_urls"]:
            detail = signals["non_video_results"][0]
            message = detail.get("message") or "Upstream returned a non-video result."
            task["error"] = {
                "message": (
                    f"{message} No video URL was returned. "
                    "Doubao routed the request to an image-generation tool instead of the Seedance video tool. "
                    "The video endpoint now sends an explicit video-generation instruction for short action prompts."
                ),
                "type": "upstream_non_video_result",
                "code": detail.get("code"),
            }

    @staticmethod
    def _is_current_task_quota_progress_signal(quota: Any) -> bool:
        if not isinstance(quota, dict):
            return False
        return _is_current_task_quota_progress_text(str(quota.get("message") or ""))

    def _get_task(self, task_id: str) -> Dict[str, Any]:
        task = self.tasks.get(task_id)
        if not task:
            raise HTTPException(status_code=404, detail=f"Video generation not found: {task_id}")
        return task

    def _model_mapping(self) -> Dict[str, str]:
        if settings.VIDEO_PROVIDER == "mock":
            return settings.MOCK_VIDEO_MODEL_MAPPING
        return settings.VIDEO_MODEL_MAPPING

    def _normalize_video_params(self, request_data: Dict[str, Any], model: str) -> Dict[str, Any]:
        duration = self._normalize_duration(request_data.get("duration"))
        ratio = self._normalize_ratio(request_data)
        resolution = self._normalize_resolution(request_data.get("resolution"))
        ratio_info = settings.VIDEO_RATIO_MAPPING[ratio]
        size_info = ratio_info["sizes"][resolution]

        return {
            "model": self._model_mapping().get(model, model),
            "duration": duration,
            "ratio": ratio_info["ratio"],
            "resolution": resolution,
            "watermark": self._normalize_watermark(request_data.get("watermark")),
            "width": size_info["width"],
            "height": size_info["height"],
            "size": size_info["size"],
        }

    def _is_long_form_params(self, params: Dict[str, Any]) -> bool:
        return int(params["duration"]) not in settings.VIDEO_DURATION_OPTIONS

    def _long_form_plan(self, params: Dict[str, Any]) -> Dict[str, Any]:
        duration = int(params["duration"])
        segments = self._split_long_form_duration(duration)
        return {
            "enabled": True,
            "requested_duration": duration,
            "segment_duration": settings.VIDEO_LONG_FORM_SEGMENT_SECONDS,
            "total_segments": len(segments),
            "completed_segments": 0,
            "current_segment": 0,
            "segments": [
                {
                    "index": index,
                    "total_segments": len(segments),
                    "duration": segment_duration,
                    "status": "queued",
                }
                for index, segment_duration in enumerate(segments, start=1)
            ],
        }

    def _split_long_form_duration(self, duration: int) -> list[int]:
        short_options = sorted(settings.VIDEO_DURATION_OPTIONS, reverse=True)
        segment_duration = settings.VIDEO_LONG_FORM_SEGMENT_SECONDS
        segments: list[int] = []
        remaining = duration

        while remaining > 0:
            candidates = [item for item in short_options if item <= min(segment_duration, remaining)]
            if not candidates:
                options = ", ".join(f"{item}s" for item in settings.VIDEO_DURATION_OPTIONS)
                raise HTTPException(
                    status_code=400,
                    detail=f"Unsupported long video duration: {duration}s. Segment durations must be composed from: {options}.",
                )
            chosen = candidates[0]
            segments.append(chosen)
            remaining -= chosen
        return segments

    def _ability_param(self, params: Dict[str, Any]) -> Dict[str, Any]:
        return {
            "ratio": params["ratio"],
            "model": params["model"],
            "duration": params["duration"],
            "resolution": params["resolution"],
            "watermark": params["watermark"],
            "creation_type": 2,
            "task_type": 2,
        }

    @staticmethod
    def _normalize_watermark(value: Any) -> bool:
        if value is None:
            return bool(settings.DOUBAO_VIDEO_WATERMARK)
        if isinstance(value, bool):
            return value
        if isinstance(value, (int, float)):
            return bool(value)
        return str(value).strip().lower() in {"1", "true", "yes", "y", "on"}

    def _extract_reference_image(self, request_data: Dict[str, Any]) -> Optional[Dict[str, Any]]:
        candidate = request_data.get("reference_image")
        if candidate is None and any(key in request_data for key in ("data", "url", "path", "fileKey", "file_key")):
            candidate = request_data
        images = request_data.get("images")
        if candidate is None and isinstance(images, list) and images:
            candidate = images[0]
        if candidate is None:
            return None

        if isinstance(candidate, str):
            return self._parse_reference_image_string(candidate)
        if isinstance(candidate, dict):
            if candidate.get("fileKey") or candidate.get("file_key"):
                return {
                    "file_key": candidate.get("fileKey") or candidate.get("file_key"),
                    "local_key": candidate.get("localKey") or candidate.get("local_key") or candidate.get("fileKey") or candidate.get("file_key"),
                    "file_name": candidate.get("fileName") or candidate.get("file_name") or candidate.get("name") or "reference.png",
                    "mime_type": candidate.get("mimeType") or candidate.get("mime_type") or "image/png",
                    "size": int(candidate.get("size") or 0),
                    "image_width": int(candidate.get("imageWidth") or candidate.get("image_width") or 0),
                    "image_height": int(candidate.get("imageHeight") or candidate.get("image_height") or 0),
                    "md5": candidate.get("md5") or candidate.get("ImageMd5"),
                    "bytes": None,
                    "kind": "doubao_uploaded",
                }
            if "bytes" in candidate:
                raw = candidate.get("bytes")
                if raw is not None and not isinstance(raw, bytes):
                    raise HTTPException(status_code=400, detail="reference_image bytes must be raw bytes.")
                return {
                    "file_name": candidate.get("file_name") or candidate.get("name") or candidate.get("fileName") or "reference.png",
                    "mime_type": candidate.get("mime_type") or candidate.get("mimeType") or "image/png",
                    "size": int(candidate.get("size") or len(raw or b"")),
                    "bytes": raw,
                    "kind": candidate.get("kind") or "inline_bytes",
                }
            if candidate.get("data") or candidate.get("url"):
                parsed = self._parse_reference_image_string(candidate.get("data") or candidate.get("url"))
                parsed["file_name"] = candidate.get("file_name") or candidate.get("name") or parsed["file_name"]
                parsed["mime_type"] = candidate.get("mime_type") or candidate.get("mimeType") or parsed["mime_type"]
                return parsed
            if candidate.get("path"):
                return self._parse_reference_image_path(candidate)

        raise HTTPException(
            status_code=400,
            detail="reference_image must be a data:image/... base64 string, an image URL/path, or a Doubao uploaded fileKey object.",
        )

    def _extract_reference_images(self, request_data: Dict[str, Any]) -> list[Dict[str, Any]]:
        """提取全部参考图（图生视频可多图）。

        优先用 images 列表（OpenAI input_reference[] 归一化结果），逐项复用
        _extract_reference_image 的单项解析；列表缺失时回退到单张 reference_image。
        豆包 ref_images 是数组，全部参考图都应贯穿到上传与请求构造。
        """
        images = request_data.get("images")
        if isinstance(images, list) and images:
            parsed: list[Dict[str, Any]] = []
            for item in images:
                # 每项当作独立 request_data，复用已有单项解析（兼容 url/data/fileKey/dict）
                candidate = item if isinstance(item, dict) else {"url": item}
                reference = self._extract_reference_image(candidate)
                if reference:
                    parsed.append(reference)
            if parsed:
                return parsed

        single = self._extract_reference_image(request_data)
        return [single] if single else []

    def _parse_reference_image_path(self, candidate: Dict[str, Any]) -> Dict[str, Any]:
        path = Path(str(candidate.get("path"))).expanduser()
        if not path.is_file():
            raise HTTPException(status_code=400, detail=f"reference_image path does not exist: {path}")
        mime_type = candidate.get("mime_type") or candidate.get("mimeType") or mimetypes.guess_type(path.name)[0] or "image/jpeg"
        size = path.stat().st_size
        return {
            "file_name": candidate.get("file_name") or candidate.get("name") or path.name,
            "mime_type": mime_type,
            "size": size,
            "path": str(path),
            "bytes": None,
            "kind": "local_path",
        }

    def _parse_reference_image_string(self, value: str) -> Dict[str, Any]:
        if not isinstance(value, str) or not value.strip():
            raise HTTPException(status_code=400, detail="reference_image cannot be empty.")
        text = value.strip()
        match = DATA_IMAGE_RE.match(text)
        if match:
            mime_type = match.group(1)
            try:
                raw = base64.b64decode(match.group(2), validate=True)
            except Exception as exc:
                raise HTTPException(status_code=400, detail=f"Invalid reference_image base64: {exc}") from exc
            return {
                "file_name": f"reference.{self._extension_from_mime(mime_type)}",
                "mime_type": mime_type,
                "size": len(raw),
                "bytes": raw,
                "kind": "inline_data",
            }
        if text.startswith(("http://", "https://")):
            return {
                "file_name": Path(text.split("?", 1)[0]).name or "reference.png",
                "mime_type": "image/png",
                "size": 0,
                "url": text,
                "bytes": None,
                "kind": "remote_url",
            }
        raise HTTPException(status_code=400, detail="reference_image must be a data:image/... base64 string or URL.")

    def _extension_from_mime(self, mime_type: str) -> str:
        return {
            "image/jpeg": "jpg",
            "image/jpg": "jpg",
            "image/png": "png",
            "image/webp": "webp",
            "image/gif": "gif",
        }.get(mime_type.lower(), "png")

    def _reference_image_meta(self, reference_image: Optional[Dict[str, Any]]) -> Optional[Dict[str, Any]]:
        if not reference_image:
            return None
        return {
            "file_name": reference_image.get("file_name"),
            "mime_type": reference_image.get("mime_type"),
            "size": reference_image.get("size", 0),
            "kind": reference_image.get("kind"),
            "file_key": reference_image.get("file_key"),
            "image_width": reference_image.get("image_width"),
            "image_height": reference_image.get("image_height"),
            "md5": reference_image.get("md5"),
        }

    def _prepare_reference_attachment_states(self, request_data: Dict[str, Any]) -> list[Dict[str, Any]]:
        states = request_data.get("attachmentStates") or request_data.get("attachment_states")
        if isinstance(states, list) and states:
            return [self._normalize_attachment_state(item, index) for index, item in enumerate(states)]

        reference_image = self._extract_reference_image(request_data)
        if not reference_image:
            return []
        if not reference_image.get("file_key"):
            return []
        return [self._normalize_attachment_state(reference_image, 0)]

    def _normalize_attachment_state(self, value: Dict[str, Any], index: int) -> Dict[str, Any]:
        file_key = value.get("fileKey") or value.get("file_key")
        if not file_key:
            raise HTTPException(status_code=400, detail="attachmentStates items require fileKey for doubao_web submissions.")
        return {
            "fileKey": file_key,
            "localKey": value.get("localKey") or value.get("local_key") or file_key,
            "fileName": value.get("fileName") or value.get("file_name") or value.get("name") or f"reference-{index + 1}.png",
            "mimeType": value.get("mimeType") or value.get("mime_type") or "image/png",
            "size": int(value.get("size") or 0),
            "imageWidth": int(value.get("imageWidth") or value.get("image_width") or 0),
            "imageHeight": int(value.get("imageHeight") or value.get("image_height") or 0),
            "md5": value.get("md5") or value.get("ImageMd5"),
        }

    def _reference_ext(self, attachment_states: list[Dict[str, Any]]) -> Dict[str, str]:
        if not attachment_states:
            return {}
        samantha_context = {
            "query_context": {
                "ref_images": [
                    {
                        "image_token": item["fileKey"],
                        "refer_types": "overall",
                        "identifier": item["localKey"],
                        "width": item.get("imageWidth", 0),
                        "height": item.get("imageHeight", 0),
                        "md5": item.get("md5"),
                    }
                    for item in attachment_states
                ]
            }
        }
        return {
            "samantha_context": json.dumps(samantha_context, ensure_ascii=False),
        }

    def _video_input_skill(self) -> Dict[str, Any]:
        return {
            "skill_id": str(settings.DOUBAO_VIDEO_SKILL_TYPE),
            "skill_type": settings.DOUBAO_VIDEO_SKILL_TYPE,
        }

    def _normalize_duration(self, value: Any) -> int:
        duration = self._parse_duration_seconds(value)
        if duration in settings.VIDEO_DURATION_OPTIONS:
            return duration
        if not settings.VIDEO_LONG_FORM_ENABLED:
            options = ", ".join(f"{item}s" for item in settings.VIDEO_DURATION_OPTIONS)
            raise HTTPException(status_code=400, detail=f"Unsupported video duration: {duration}s. Supported: {options}.")
        if duration > settings.VIDEO_LONG_FORM_MAX_DURATION_SECONDS:
            raise HTTPException(
                status_code=400,
                detail=(
                    f"Unsupported video duration: {duration}s. "
                    f"Maximum long-form duration is {settings.VIDEO_LONG_FORM_MAX_DURATION_SECONDS}s."
                ),
            )
        self._split_long_form_duration(duration)
        return duration

    def _parse_duration_seconds(self, value: Any) -> int:
        if value is None or value == "":
            return max(settings.VIDEO_DURATION_OPTIONS)
        if isinstance(value, (int, float)):
            duration = int(value)
        else:
            text = str(value).strip().lower()
            match = re.fullmatch(r"(\d+(?:\.\d+)?)\s*(s|sec|secs|second|seconds|秒)?", text)
            if not match:
                raise HTTPException(status_code=400, detail=f"Unsupported video duration: {value}.")
            duration = int(float(match.group(1)))
        if duration <= 0:
            raise HTTPException(status_code=400, detail="Video duration must be a positive number of seconds.")
        return duration

    def _normalize_resolution(self, value: Any) -> str:
        resolution = str(value or settings.DEFAULT_VIDEO_RESOLUTION).strip()
        mapped = settings.VIDEO_RESOLUTION_MAPPING.get(resolution)
        if not mapped:
            options = ", ".join(settings.VIDEO_RESOLUTION_MAPPING.keys())
            raise HTTPException(status_code=400, detail=f"Unsupported video resolution: {resolution}. Supported: {options}.")
        return mapped

    def _normalize_ratio(self, request_data: Dict[str, Any]) -> str:
        raw_ratio = request_data.get("aspect_ratio") or request_data.get("ratio")
        if raw_ratio:
            ratio = str(raw_ratio).strip()
            if ratio in settings.VIDEO_RATIO_MAPPING:
                return ratio
            options = ", ".join(settings.VIDEO_RATIO_MAPPING.keys())
            raise HTTPException(status_code=400, detail=f"Unsupported video aspect_ratio: {ratio}. Supported: {options}.")

        raw_size = request_data.get("size")
        if raw_size:
            return self._ratio_from_size(str(raw_size))

        return settings.DEFAULT_VIDEO_RATIO

    def _ratio_from_size(self, value: str) -> str:
        match = re.fullmatch(r"\s*(\d+)\s*x\s*(\d+)\s*", value.lower())
        if not match:
            options = ", ".join(settings.VIDEO_RATIO_MAPPING.keys())
            raise HTTPException(status_code=400, detail=f"Unsupported video size: {value}. Use aspect_ratio: {options}.")

        width, height = int(match.group(1)), int(match.group(2))
        if width <= 0 or height <= 0:
            raise HTTPException(status_code=400, detail=f"Unsupported video size: {value}.")

        if width == height:
            return "1:1"

        actual = width / height
        candidates = {}
        for ratio in settings.VIDEO_RATIO_MAPPING.keys():
            left, right = (int(part) for part in ratio.split(":", 1))
            candidates[ratio] = abs(math.log(actual / (left / right)))
        return min(candidates, key=candidates.get)

    def _fail_task(self, task: Dict[str, Any], exc: Exception, prefix: str) -> None:
        task["status"] = "failed"
        if isinstance(exc, VideoQuotaInsufficientError):
            task["error"] = {
                "message": str(exc),
                "type": "video_quota_insufficient",
                "code": "video_quota_insufficient",
                "remaining": exc.remaining,
                "required": exc.required,
            }
        else:
            task["error"] = {"message": str(exc), "type": "server_error"}
        self._mark_task_terminal(task)
        self._write_upstream_debug(task)
        logger.error(f"{prefix}: {task['id']}: {exc}", exc_info=True)

    def _public_task(self, task: Dict[str, Any]) -> Dict[str, Any]:
        result: Optional[Dict[str, Any]] = task["result"]
        public_result = None
        if result:
            public_result = {
                "url": result["url"],
                "content_type": result["content_type"],
            }

        response = {
            "id": task["id"],
            "object": task["object"],
            "created": task["created"],
            "model": task["model"],
            "prompt": task.get("prompt"),
            "params": task.get("params"),
            "reference_image": task.get("reference_image_meta"),
            "status": task["status"],
            "error": task["error"],
            "data": [public_result] if public_result else [],
        }

        if task.get("long_form"):
            response["long_form"] = task["long_form"]
        polling = task.get("debug", {}).get("polling")
        if isinstance(polling, dict):
            response["polling"] = {
                key: polling.get(key)
                for key in ("attempt", "max_attempts", "poll_interval")
                if polling.get(key) is not None
            }
        if task.get("debug", {}).get("signals"):
            response["upstream"] = task["debug"]["signals"]
        return response
