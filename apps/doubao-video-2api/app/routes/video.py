import json
import re
import secrets
import time
from pathlib import Path
from typing import Any, Callable, Optional

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import FileResponse, JSONResponse, RedirectResponse, StreamingResponse
from loguru import logger

from app.core.config import settings
from app.providers.video_provider import VideoProvider
from app.utils.sse_utils import DONE_CHUNK, create_chat_completion_chunk, create_sse_data


VideoProviderGetter = Callable[[], Optional[VideoProvider]]

router = APIRouter(prefix="/v1", tags=["video"])
_get_video_provider: VideoProviderGetter = lambda: None


VIDEO_GENERATION_REQUEST_SCHEMA: dict[str, Any] = {
    "type": "object",
    "required": ["model", "prompt"],
    "properties": {
        "model": {
            "type": "string",
            "title": "视频模型",
            "default": settings.DEFAULT_VIDEO_MODEL,
            "enum": list(settings.VIDEO_MODEL_MAPPING.keys()),
            "description": "New API 中配置的视频模型名称。",
        },
        "prompt": {
            "type": "string",
            "title": "提示词",
            "description": "视频生成提示词。",
        },
        "input_reference[]": {
            "type": "array",
            "title": "参考图",
            "description": "图生视频参考图，最多 7 张；当前会使用第一张作为豆包视频参考图。",
            "items": {"type": "string", "format": "binary"},
        },
        "duration": {
            "type": "integer",
            "title": "时长",
            "default": settings.VIDEO_LONG_FORM_SEGMENT_SECONDS,
            "enum": settings.VIDEO_LONG_FORM_PUBLIC_DURATION_OPTIONS,
            "description": "视频时长，单位秒。",
        },
        "aspect_ratio": {
            "type": "string",
            "title": "画幅",
            "default": settings.DEFAULT_VIDEO_RATIO,
            "enum": list(settings.VIDEO_RATIO_MAPPING.keys()),
            "description": "视频画幅比例。",
        },
        "resolution": {
            "type": "string",
            "title": "清晰度",
            "default": settings.DEFAULT_VIDEO_RESOLUTION,
            "enum": list(settings.VIDEO_RESOLUTION_MAPPING.keys()),
            "description": "视频清晰度。",
        },
        "poll_interval": {
            "type": "integer",
            "title": "轮询间隔",
            "default": 10,
            "description": "星绘影像轮询视频任务状态的间隔秒数。",
        },
        "poll_timeout": {
            "type": "integer",
            "title": "轮询超时",
            "default": 600,
            "description": "星绘影像等待视频完成的最长秒数。",
        },
    },
}


OPENAI_VIDEO_CREATE_REQUEST_SCHEMA: dict[str, Any] = {
    "type": "object",
    "required": ["model", "prompt"],
    "properties": {
        "model": {
            "type": "string",
            "title": "Video model",
            "default": settings.DEFAULT_VIDEO_MODEL,
            "enum": list(settings.VIDEO_MODEL_MAPPING.keys()),
        },
        "prompt": {
            "type": "string",
            "title": "Prompt",
        },
        "seconds": {
            "type": "integer",
            "title": "Duration seconds",
            "default": settings.VIDEO_LONG_FORM_SEGMENT_SECONDS,
            "enum": settings.VIDEO_LONG_FORM_PUBLIC_DURATION_OPTIONS,
        },
        "size": {
            "type": "string",
            "title": "Video size",
            "default": "1280x720",
            "enum": ["1280x720", "720x1280", "1024x1024", "1920x1080", "1080x1920", "1080x1080"],
        },
        "resolution_name": {
            "type": "string",
            "title": "Resolution",
            "default": settings.DEFAULT_VIDEO_RESOLUTION,
            "enum": list(settings.VIDEO_RESOLUTION_MAPPING.keys()),
        },
        "input_reference[]": {
            "type": "array",
            "title": "Reference images",
            "items": {"type": "string", "format": "binary"},
        },
        "input_reference": {
            "type": "array",
            "title": "Reference images",
            "items": {
                "type": "object",
                "properties": {
                    "image_url": {"type": "string"},
                    "url": {"type": "string"},
                    "data": {"type": "string"},
                },
            },
        },
    },
}


def set_video_provider_getter(getter: VideoProviderGetter) -> None:
    global _get_video_provider
    _get_video_provider = getter


def _video_provider() -> VideoProvider:
    provider = _get_video_provider()
    if not provider:
        raise HTTPException(status_code=503, detail="Video provider is not initialized.")
    return provider


def _cached_video_debug(provider: VideoProvider, task_id: str) -> dict[str, Any]:
    path = Path(provider.output_dir).parent / f"upstream-debug-{task_id}.json"
    if not path.is_file():
        return {}
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except Exception as exc:
        logger.warning(f"Unable to read cached video debug metadata for {task_id}: {exc}")
        return {}
    return data if isinstance(data, dict) else {}


def video_model_names() -> set[str]:
    video_models = (
        settings.MOCK_VIDEO_MODEL_MAPPING
        if settings.VIDEO_PROVIDER == "mock"
        else settings.VIDEO_MODEL_MAPPING
    )
    return set(video_models.keys())


def _model_list_for_openapi() -> list[str]:
    models = list(settings.VIDEO_MODEL_MAPPING.keys())
    if settings.VIDEO_PROVIDER == "mock":
        models = [item for item in settings.MOCK_VIDEO_MODEL_MAPPING.keys() if item != "doubao-video-mock"] or models
    return models or [settings.DEFAULT_VIDEO_MODEL]


def _video_generation_openapi_schema() -> dict[str, Any]:
    schema = json.loads(json.dumps(VIDEO_GENERATION_REQUEST_SCHEMA, ensure_ascii=False))
    schema["properties"]["model"]["enum"] = _model_list_for_openapi()
    schema["properties"]["model"]["default"] = settings.DEFAULT_VIDEO_MODEL
    return schema


def _openai_video_create_openapi_schema() -> dict[str, Any]:
    schema = json.loads(json.dumps(OPENAI_VIDEO_CREATE_REQUEST_SCHEMA, ensure_ascii=False))
    schema["properties"]["model"]["enum"] = _model_list_for_openapi()
    schema["properties"]["model"]["default"] = settings.DEFAULT_VIDEO_MODEL
    return schema


def add_video_openapi_paths(openapi_schema: dict[str, Any]) -> None:
    video_schema = _video_generation_openapi_schema()
    video_post = {
        "tags": ["video"],
        "summary": "Doubao 视频生成",
        "description": "创建豆包视频生成任务，兼容星绘影像能力来源解析。",
        "operationId": "doubaoVideoGeneration",
        "requestBody": {
            "required": True,
            "content": {
                "multipart/form-data": {"schema": video_schema},
                "application/json": {"schema": video_schema},
            },
        },
        "responses": {
            "202": {"description": "Video task created"},
            "200": {"description": "Video task created"},
            "400": {"description": "Bad request"},
        },
    }
    paths = openapi_schema.setdefault("paths", {})
    paths.setdefault("/v1/videos/generations", {})["post"] = video_post
    paths.setdefault("/v1/video/generations", {})["post"] = video_post
    standard_video_schema = _openai_video_create_openapi_schema()
    paths.setdefault("/v1/videos", {})["post"] = {
        "tags": ["video"],
        "summary": "Create video",
        "description": "Create an OpenAI-style asynchronous video task.",
        "operationId": "createVideo",
        "requestBody": {
            "required": True,
            "content": {
                "multipart/form-data": {"schema": standard_video_schema},
                "application/json": {"schema": standard_video_schema},
            },
        },
        "responses": {
            "200": {"description": "Video task created"},
            "400": {"description": "Bad request"},
        },
    }
    paths.setdefault("/v1/videos/{video_id}", {})["get"] = {
        "tags": ["video"],
        "summary": "Retrieve video",
        "operationId": "retrieveVideo",
        "parameters": [
            {
                "name": "video_id",
                "in": "path",
                "required": True,
                "schema": {"type": "string"},
            }
        ],
        "responses": {
            "200": {"description": "Video task"},
            "404": {"description": "Video task not found"},
        },
    }
    paths.setdefault("/v1/videos/{video_id}/content", {})["get"] = {
        "tags": ["video"],
        "summary": "Download video content",
        "operationId": "downloadVideoContent",
        "parameters": [
            {
                "name": "video_id",
                "in": "path",
                "required": True,
                "schema": {"type": "string"},
            }
        ],
        "responses": {
            "200": {"description": "Video content"},
            "409": {"description": "Video task is not ready"},
            "404": {"description": "Video task not found"},
        },
    }


def redact_video_request(data: dict[str, Any]) -> dict[str, Any]:
    redacted = dict(data)
    reference = redacted.get("reference_image")
    if isinstance(reference, dict):
        redacted["reference_image"] = {
            "file_name": reference.get("file_name") or reference.get("name") or reference.get("fileName"),
            "mime_type": reference.get("mime_type") or reference.get("mimeType"),
            "size": reference.get("size"),
            "data": "[REDACTED]" if reference.get("data") else None,
            "fileKey": reference.get("fileKey") or reference.get("file_key"),
        }
    elif isinstance(reference, str):
        redacted["reference_image"] = "[REDACTED]"
    if isinstance(redacted.get("images"), list):
        redacted["images"] = f"[{len(redacted['images'])} image(s) redacted]"
    return redacted


def redact_video_upload_request(data: dict[str, Any]) -> dict[str, Any]:
    redacted = dict(data)
    if redacted.get("data"):
        redacted["data"] = "[REDACTED]"
    reference = redacted.get("reference_image")
    if isinstance(reference, dict) and reference.get("data"):
        reference = dict(reference)
        reference["data"] = "[REDACTED]"
        redacted["reference_image"] = reference
    return redacted


def _form_value(value: Any) -> Any:
    if isinstance(value, str):
        stripped = value.strip()
        if stripped == "":
            return ""
        if stripped.lower() in {"true", "false"}:
            return stripped.lower() == "true"
        if re.fullmatch(r"-?\d+", stripped):
            try:
                return int(stripped)
            except ValueError:
                return value
        if re.fullmatch(r"-?\d+\.\d+", stripped):
            try:
                return float(stripped)
            except ValueError:
                return value
    return value


async def multipart_video_request(request: Request) -> dict[str, Any]:
    try:
        form = await request.form()
    except AssertionError as exc:
        raise HTTPException(
            status_code=500,
            detail="python-multipart is required to handle multipart video requests.",
        ) from exc

    request_data: dict[str, Any] = {}
    reference_images: list[dict[str, Any]] = []
    file_fields = {"input_reference[]", "input_reference", "reference_image", "image", "images", "file"}

    for key, value in form.multi_items():
        filename = getattr(value, "filename", None)
        if filename is not None:
            raw = await value.read()
            if not raw:
                continue
            reference = {
                "file_name": filename or "reference.png",
                "mime_type": getattr(value, "content_type", None) or "image/png",
                "size": len(raw),
                "bytes": raw,
                "kind": "multipart_upload",
            }
            if key in file_fields:
                reference_images.append(reference)
            continue

        parsed_value = _form_value(value)
        if key in request_data:
            existing = request_data[key]
            if isinstance(existing, list):
                existing.append(parsed_value)
            else:
                request_data[key] = [existing, parsed_value]
        else:
            request_data[key] = parsed_value

    if reference_images:
        request_data["reference_image"] = reference_images[0]
        request_data["images"] = reference_images
    return request_data


async def video_request_data(request: Request) -> dict[str, Any]:
    content_type = request.headers.get("content-type", "").lower()
    if "multipart/form-data" in content_type:
        return await multipart_video_request(request)
    return await request.json()


def _chat_video_prompt(request_data: dict[str, Any]) -> str:
    prompt = request_data.get("prompt")
    if isinstance(prompt, str) and prompt.strip():
        return prompt.strip()

    messages = request_data.get("messages")
    if isinstance(messages, list):
        parts = []
        for message in messages:
            if not isinstance(message, dict):
                continue
            content = message.get("content")
            if isinstance(content, str):
                parts.append(content)
            elif isinstance(content, list):
                for item in content:
                    if isinstance(item, dict):
                        text = item.get("text")
                        if isinstance(text, str):
                            parts.append(text)
                    elif isinstance(item, str):
                        parts.append(item)
        prompt = "\n".join(part.strip() for part in parts if part and part.strip())
        if prompt.strip():
            return prompt.strip()

    return "Generate a short video."


def _chat_video_payload(request_data: dict[str, Any]) -> dict[str, Any]:
    return {
        "model": request_data.get("model") or settings.DEFAULT_VIDEO_MODEL,
        "prompt": _chat_video_prompt(request_data),
        "aspect_ratio": request_data.get("aspect_ratio") or request_data.get("ratio") or settings.DEFAULT_VIDEO_RATIO,
        "resolution": request_data.get("resolution") or settings.DEFAULT_VIDEO_RESOLUTION,
        "duration": request_data.get("duration") or max(settings.VIDEO_DURATION_OPTIONS),
        "reference_image": request_data.get("reference_image"),
        "images": request_data.get("images"),
    }


def _chat_completion_response(
    model: str,
    content: str,
    extra_fields: Optional[dict[str, Any]] = None,
) -> JSONResponse:
    body = {
        "id": f"chatcmpl-{secrets.token_hex(12)}",
        "object": "chat.completion",
        "created": int(time.time()),
        "model": model,
        "choices": [
            {
                "index": 0,
                "message": {"role": "assistant", "content": content},
                "finish_reason": "stop",
            }
        ],
        "usage": {"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0},
    }
    if extra_fields:
        body.update(extra_fields)
        body["choices"][0]["message"].update(extra_fields)
    return JSONResponse(content=body)


def _chat_completion_stream(
    model: str,
    content: str,
    extra_fields: Optional[dict[str, Any]] = None,
) -> StreamingResponse:
    async def _generator():
        request_id = f"chatcmpl-{secrets.token_hex(12)}"
        chunk = create_chat_completion_chunk(request_id, model, content, None)
        if extra_fields:
            chunk.update(extra_fields)
            chunk["choices"][0]["delta"].update(extra_fields)
        yield create_sse_data(chunk)
        yield create_sse_data(create_chat_completion_chunk(request_id, model, "", "stop"))
        yield DONE_CHUNK

    return StreamingResponse(_generator(), media_type="text/event-stream")


def _public_content_url(base_url: str, path: str) -> str:
    if settings.VIDEO_PUBLIC_BASE_URL:
        return f"{settings.VIDEO_PUBLIC_BASE_URL}{path}"
    if settings.VIDEO_RELATIVE_CONTENT_URLS:
        return path
    return f"{base_url}{path}"


def _video_chat_generation_metadata(task: dict[str, Any], base_url: str) -> dict[str, Any]:
    task_id = task["id"]
    content_url = _public_content_url(base_url, f"/v1/video/generations/{task_id}/content")
    return {
        "id": task_id,
        "task_id": task_id,
        "object": task.get("object", "video.generation"),
        "status": task["status"],
        "status_url": f"{base_url}/v1/video/generations/{task_id}",
        "content_url": content_url,
        "download_url": content_url,
        "content_type": "video/mp4",
        "requires_authorization": True,
        "poll_interval_ms": 2000,
    }


async def handle_video_chat_completion(request_data: dict[str, Any], base_url: str):
    provider = _video_provider()
    payload = _chat_video_payload(request_data)
    created = await provider.create_generation(payload, base_url)
    task = json.loads(created.body.decode("utf-8"))
    metadata = _video_chat_generation_metadata(task, base_url)
    content = "\n".join(
        [
            "Video generation task created.",
            f"task_id: {task['id']}",
            f"status: {task['status']}",
            f"status_url: {metadata['status_url']}",
            f"content_url: {metadata['content_url']}",
        ]
    )
    extra_fields = {"video_generation": metadata}
    if request_data.get("stream"):
        return _chat_completion_stream(str(payload["model"]), content, extra_fields)
    return _chat_completion_response(str(payload["model"]), content, extra_fields)


def _resolution_from_size(size: Any) -> Optional[str]:
    if not isinstance(size, str):
        return None
    match = re.fullmatch(r"\s*(\d+)\s*x\s*(\d+)\s*", size.lower())
    if not match:
        return None
    width, height = int(match.group(1)), int(match.group(2))
    if max(width, height) >= 1792 or min(width, height) >= 1080:
        return "1080p" if "1080p" in settings.VIDEO_RESOLUTION_MAPPING else settings.DEFAULT_VIDEO_RESOLUTION
    return "720p" if "720p" in settings.VIDEO_RESOLUTION_MAPPING else settings.DEFAULT_VIDEO_RESOLUTION


def _openai_video_reference(value: Any) -> Optional[dict[str, Any]]:
    if value is None:
        return None
    if isinstance(value, str):
        return {"url": value}
    if not isinstance(value, dict):
        return None
    if value.get("fileKey") or value.get("file_key"):
        return dict(value)
    image_url = value.get("image_url")
    if isinstance(image_url, dict):
        image_url = image_url.get("url")
    source = image_url or value.get("url") or value.get("data")
    if source:
        return {"url": source}
    return dict(value) if value else None


def _openai_video_payload(request_data: dict[str, Any]) -> dict[str, Any]:
    payload = dict(request_data)
    if "duration_seconds" in request_data and "duration" not in payload:
        payload["duration"] = request_data["duration_seconds"]
    if "seconds" in request_data and "duration" not in payload:
        payload["duration"] = request_data["seconds"]
    if "video_size" in request_data and "size" not in payload:
        payload["size"] = request_data["video_size"]
    if "resolution_name" in request_data and "resolution" not in payload:
        payload["resolution"] = request_data["resolution_name"]
    if "resolution" not in payload:
        inferred_resolution = _resolution_from_size(payload.get("size"))
        if inferred_resolution:
            payload["resolution"] = inferred_resolution

    if "reference_image" not in payload:
        raw_references = request_data.get("input_reference")
        if raw_references is None:
            raw_references = request_data.get("input_reference[]")
        if raw_references is not None and not isinstance(raw_references, list):
            raw_references = [raw_references]
        references = [
            reference
            for reference in (_openai_video_reference(item) for item in (raw_references or []))
            if reference
        ]
        if references:
            payload["reference_image"] = references[0]
            payload["images"] = references

    return payload


def _openai_video_status(status: Any) -> str:
    normalized = str(status or "").strip().lower()
    if normalized == "succeeded":
        return "completed"
    if normalized in {"running", "submitted", "polling"}:
        return "in_progress"
    if normalized == "failed":
        return "failed"
    return "queued"


def _safe_positive_int(value: Any) -> int:
    try:
        return max(0, int(float(value)))
    except (TypeError, ValueError):
        return 0


def _openai_video_progress(task: dict[str, Any]) -> int:
    status = _openai_video_status(task.get("status"))
    if status == "completed":
        return 100
    if status == "failed":
        return 0
    long_form = task.get("long_form")
    if isinstance(long_form, dict):
        total = int(long_form.get("total_segments") or 0)
        completed = int(long_form.get("completed_segments") or 0)
        if total > 0:
            return max(1, min(99, int((completed / total) * 100)))
    if status == "in_progress":
        polling = task.get("polling")
        if isinstance(polling, dict):
            attempt = _safe_positive_int(polling.get("attempt"))
            max_attempts = _safe_positive_int(polling.get("max_attempts"))
            if attempt > 0 and max_attempts > 0:
                ratio = min(attempt, max_attempts) / max_attempts
                return max(1, min(95, 5 + int(ratio * 90)))
    return 1 if status == "in_progress" else 0


def _openai_video_task_response(task: dict[str, Any], base_url: str) -> dict[str, Any]:
    task_id = str(task.get("id") or "")
    content_url = _public_content_url(base_url, f"/v1/videos/{task_id}/content")
    status_url = f"{base_url}/v1/videos/{task_id}"
    status = _openai_video_status(task.get("status"))
    payload = {
        "id": task_id,
        "object": "video",
        "created_at": task.get("created") or int(time.time()),
        "status": status,
        "progress": _openai_video_progress(task),
        "model": task.get("model"),
        "prompt": task.get("prompt"),
        "params": task.get("params"),
        "error": task.get("error"),
        "status_url": status_url,
        "content_url": content_url,
        "download_url": content_url,
        "requires_authorization": True,
    }
    if task.get("long_form"):
        payload["long_form"] = task["long_form"]
    result_items = task.get("data") if isinstance(task.get("data"), list) else []
    if result_items:
        payload["data"] = [
            {
                **item,
                "url": content_url,
                "legacy_url": item.get("url"),
            }
            for item in result_items
            if isinstance(item, dict)
        ]
    return payload


def _raw_video_task(task_id: str) -> dict[str, Any]:
    provider = _video_provider()
    task = provider.tasks.get(task_id)
    if not task:
        cached_path = Path(provider.output_dir) / f"{task_id}.mp4"
        if cached_path.is_file():
            stat = cached_path.stat()
            metadata = _cached_video_debug(provider, task_id)
            result = metadata.get("result") if isinstance(metadata.get("result"), dict) else {}
            return {
                "id": task_id,
                "object": metadata.get("object") or "video.generation",
                "created": int(metadata.get("created") or stat.st_mtime),
                "model": metadata.get("model") or settings.DEFAULT_VIDEO_MODEL,
                "prompt": metadata.get("prompt"),
                "params": metadata.get("params"),
                "reference_image_meta": metadata.get("reference_image"),
                "status": "succeeded",
                "error": None,
                "result": {
                    "url": result.get("url") or f"/v1/video/generations/{task_id}/content",
                    "upstream_url": result.get("upstream_url"),
                    "file_path": str(cached_path),
                    "content_type": result.get("content_type") or "video/mp4",
                },
            }
        raise HTTPException(status_code=404, detail=f"Video generation not found: {task_id}")
    return task


@router.post("/videos", response_class=JSONResponse)
async def create_video(request: Request):
    provider = _video_provider()
    request_data = _openai_video_payload(await video_request_data(request))
    logger.info(
        "Received /v1/videos request:\n"
        f"{json.dumps(redact_video_request(request_data), indent=2, ensure_ascii=False)}"
    )
    base_url = str(request.base_url).rstrip("/")
    created = await provider.create_generation(request_data, base_url)
    task = json.loads(created.body.decode("utf-8"))
    return JSONResponse(content=_openai_video_task_response(task, base_url))


@router.post("/video/generations")
async def create_video_generation(request: Request):
    provider = _video_provider()
    request_data = await video_request_data(request)
    logger.info(
        "Received /v1/video/generations request:\n"
        f"{json.dumps(redact_video_request(request_data), indent=2, ensure_ascii=False)}"
    )
    return await provider.create_generation(request_data, str(request.base_url).rstrip("/"))


@router.post("/videos/generations")
async def create_videos_generation(request: Request):
    return await create_video_generation(request)


@router.post("/video/uploads")
async def upload_video_reference_image(request: Request):
    provider = _video_provider()
    request_data = await request.json()
    logger.info(
        "Received /v1/video/uploads request:\n"
        f"{json.dumps(redact_video_upload_request(request_data), indent=2, ensure_ascii=False)}"
    )
    return await provider.upload_reference_image_from_request(request_data)


@router.get("/video/generations/{task_id}", response_class=JSONResponse)
async def get_video_generation(task_id: str):
    return await _video_provider().get_generation(task_id)


@router.get("/videos/generations/{task_id}", response_class=JSONResponse)
async def get_videos_generation(task_id: str):
    return await get_video_generation(task_id)


@router.get("/video/generations/{task_id}/content")
async def get_video_generation_content(task_id: str):
    provider = _video_provider()
    content = await provider.get_video_response(task_id)
    if isinstance(content, str):
        return RedirectResponse(content)
    return FileResponse(path=content, media_type="video/mp4", filename=f"{task_id}.mp4")


@router.get("/videos/generations/{task_id}/content")
async def get_videos_generation_content(task_id: str):
    return await get_video_generation_content(task_id)


@router.get("/videos/{video_id}", response_class=JSONResponse)
async def retrieve_video(video_id: str, request: Request):
    provider = _video_provider()
    task = _raw_video_task(video_id)
    return JSONResponse(content=_openai_video_task_response(provider._public_task(task), str(request.base_url).rstrip("/")))


@router.get("/videos/{video_id}/content")
async def get_video_content(video_id: str):
    provider = _video_provider()
    content = await provider.get_video_response(video_id)
    if isinstance(content, str):
        return RedirectResponse(content)
    return FileResponse(path=content, media_type="video/mp4", filename=f"{video_id}.mp4")
