import json
import re
import sys
import time
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any, Optional

import httpx
from fastapi import Depends, FastAPI, Header, HTTPException, Request
from fastapi.openapi.utils import get_openapi
from fastapi.responses import HTMLResponse, JSONResponse
from loguru import logger

from app.core.config import normalize_doubao_cookie, settings
from app.providers.video_provider import VideoProvider
from app.routes import account_pool as account_pool_routes
from app.routes import api_keys as api_key_routes
from app.routes import quota as quota_routes
from app.routes import video as video_routes
from app.services.credential_manager import CredentialManager, credential_identity
from app.services.doubao_cookie_plugin import (
    ensure_plugin_config,
    plugin_token_fingerprint,
    rotate_connection_token,
    update_plugin_config,
    verify_connection_token,
)
from app.services.doubao_cookie_refresher import (
    DoubaoCookieAutoRefresher,
    looks_like_logged_in_doubao_cookie,
)
from app.services.playwright_manager import PlaywrightManager


logger.remove()
logger.add(
    sys.stdout,
    level="INFO",
    format="<green>{time:YYYY-MM-DD HH:mm:ss.SSS}</green> | "
    "<level>{level: <8}</level> | "
    "<cyan>{name}</cyan>:<cyan>{function}</cyan>:<cyan>{line}</cyan> - <level>{message}</level>",
    colorize=True,
)


provider: Optional[Any] = None
video_provider: Optional[VideoProvider] = None
runtime_credential_manager: Optional[CredentialManager] = None
quota_playwright_manager: Optional[PlaywrightManager] = None
cookie_refresher: Optional[DoubaoCookieAutoRefresher] = None

# Compatibility cache fields kept for tests and older imports; the source of
# truth lives in app.routes.api_keys.
api_key_records_cache: Optional[list[dict[str, Any]]] = None
api_key_records_cache_mtime: Optional[float] = None
api_key_records_cache_path: Optional[Path] = None


def _set_runtime_credential_manager(manager: CredentialManager) -> None:
    global runtime_credential_manager
    runtime_credential_manager = manager


def _get_runtime_credential_manager() -> Optional[CredentialManager]:
    if provider and getattr(provider, "credential_manager", None):
        return provider.credential_manager
    if video_provider and getattr(video_provider, "credential_manager", None):
        return video_provider.credential_manager
    if runtime_credential_manager:
        return runtime_credential_manager
    if settings.DOUBAO_COOKIES:
        manager = CredentialManager.shared()
        _set_runtime_credential_manager(manager)
        return manager
    return None


def _get_runtime_playwright_manager() -> Optional[PlaywrightManager]:
    if video_provider and getattr(video_provider, "playwright_manager", None):
        return video_provider.playwright_manager
    if provider and getattr(provider, "playwright_manager", None):
        return provider.playwright_manager
    return PlaywrightManager()


async def _activate_runtime_credential_manager(manager: CredentialManager) -> None:
    _set_runtime_credential_manager(manager)
    active_credentials = manager.active_credentials
    if not active_credentials:
        return

    if video_provider:
        attach = getattr(video_provider, "attach_credential_manager", None)
        if callable(attach):
            await attach(manager, run_initial_refresh=False)

    if provider and getattr(provider, "credential_manager", None) is None:
        provider.credential_manager = manager
        if getattr(provider, "playwright_manager", None) is None:
            provider.playwright_manager = PlaywrightManager()
        await provider.playwright_manager.initialize(active_credentials)


def _sync_api_key_cache_to_route() -> None:
    api_key_routes.api_key_records_cache = api_key_records_cache
    api_key_routes.api_key_records_cache_mtime = api_key_records_cache_mtime
    api_key_routes.api_key_records_cache_path = api_key_records_cache_path


def _sync_api_key_cache_from_route() -> None:
    global api_key_records_cache, api_key_records_cache_mtime, api_key_records_cache_path
    api_key_records_cache = api_key_routes.api_key_records_cache
    api_key_records_cache_mtime = api_key_routes.api_key_records_cache_mtime
    api_key_records_cache_path = api_key_routes.api_key_records_cache_path


def _api_key_store_path() -> Path:
    return api_key_routes._api_key_store_path()


def _api_key_digest(secret: str) -> str:
    return api_key_routes._api_key_digest(secret)


def _api_key_fingerprint(secret: str) -> str:
    return api_key_routes._api_key_fingerprint(secret)


def _load_api_key_records() -> list[dict[str, Any]]:
    _sync_api_key_cache_to_route()
    records = api_key_routes._load_api_key_records()
    _sync_api_key_cache_from_route()
    return records


def _save_api_key_records(records: list[dict[str, Any]]) -> None:
    _sync_api_key_cache_to_route()
    api_key_routes._save_api_key_records(records)
    _sync_api_key_cache_from_route()


def _generated_api_key_valid(secret: str) -> bool:
    valid = api_key_routes.generated_api_key_valid(secret)
    _sync_api_key_cache_from_route()
    return valid


def _public_api_key(record: dict[str, Any]) -> dict[str, Any]:
    return api_key_routes._public_api_key(record)


def _api_key_by_id(records: list[dict[str, Any]], key_id: str) -> dict[str, Any]:
    return api_key_routes._api_key_by_id(records, key_id)


def _account_pool_manager():
    return account_pool_routes._account_pool_manager()


def _positive_int(value: Any, default: int, name: str) -> int:
    return account_pool_routes._positive_int(value, default, name)


def _bool_value(value: Any, default: bool = False) -> bool:
    return account_pool_routes._bool_value(value, default)


def _new_account_payload(data: dict[str, Any]) -> dict[str, Any]:
    return account_pool_routes._new_account_payload(data)


def _bulk_account_payload(data: dict[str, Any]) -> dict[str, Any]:
    return account_pool_routes._bulk_account_payload(data)


def _env_quote(value: str) -> str:
    return account_pool_routes._env_quote(value)


def _env_unquote(value: str) -> str:
    return account_pool_routes._env_unquote(value)


def _persist_account_to_env(cookie: str, weight: int, max_concurrency: int, disabled: bool) -> int:
    return account_pool_routes._persist_account_to_env(cookie, weight, max_concurrency, disabled)


def _remove_account_from_env(cookie: str) -> Optional[int]:
    return account_pool_routes._remove_account_from_env(cookie)


def _account_index(index: int) -> int:
    return account_pool_routes._account_index(index)


_quota_path_value = quota_routes._quota_path_value
_quota_number = quota_routes._quota_number
_quota_normalized_key = quota_routes._quota_normalized_key
_quota_name_set = quota_routes._quota_name_set
_quota_endpoint_is_video_specific = quota_routes._quota_endpoint_is_video_specific
_quota_path_has_context = quota_routes._quota_path_has_context
_quota_deep_find = quota_routes._quota_deep_find
_parse_quota_payload = quota_routes._parse_quota_payload
_quota_business_error = quota_routes._quota_business_error
_quota_is_auth_error = quota_routes._quota_is_auth_error
_quota_base_params = quota_routes._quota_base_params
_quota_headers = quota_routes._quota_headers
_quota_error_message = quota_routes._quota_error_message
_cookie_with_ms_token = quota_routes._cookie_with_ms_token


async def _quota_signing_manager(cookie: str) -> PlaywrightManager:
    global quota_playwright_manager
    quota_routes.PlaywrightManager = PlaywrightManager
    quota_routes.quota_playwright_manager = quota_playwright_manager
    quota_routes.set_quota_provider_getters(lambda: provider, lambda: video_provider)
    manager = await quota_routes._quota_signing_manager(cookie)
    quota_playwright_manager = quota_routes.quota_playwright_manager
    return manager


async def _signed_quota_request(endpoint: str, cookie: str) -> tuple[str, str]:
    global quota_playwright_manager
    quota_routes.PlaywrightManager = PlaywrightManager
    quota_routes.quota_playwright_manager = quota_playwright_manager
    quota_routes.set_quota_provider_getters(lambda: provider, lambda: video_provider)
    result = await quota_routes._signed_quota_request(endpoint, cookie)
    quota_playwright_manager = quota_routes.quota_playwright_manager
    return result


async def _refresh_account_quota(manager: CredentialManager, index: int) -> dict[str, Any]:
    global quota_playwright_manager
    quota_routes.httpx = httpx
    quota_routes.PlaywrightManager = PlaywrightManager
    quota_routes.quota_playwright_manager = quota_playwright_manager
    quota_routes.set_quota_provider_getters(lambda: provider, lambda: video_provider)
    result = await quota_routes.refresh_account_quota(manager, index)
    quota_playwright_manager = quota_routes.quota_playwright_manager
    return result


async def _account_pool_quota_refresh(manager: CredentialManager, index: int) -> dict[str, Any]:
    return await _refresh_account_quota(manager, index)


@asynccontextmanager
async def lifespan(app: FastAPI):
    global provider, video_provider, cookie_refresher

    logger.info(f"Starting {settings.APP_NAME} v{settings.APP_VERSION}")
    if settings.ENABLE_CHAT_PROVIDER and settings.DOUBAO_COOKIES:
        from app.providers.doubao_provider import DoubaoProvider

        provider = DoubaoProvider()
        await provider.initialize()
        logger.info("Chat provider initialized.")
    elif settings.ENABLE_CHAT_PROVIDER:
        logger.warning("Chat provider is disabled until at least one Doubao cookie is configured.")
    else:
        logger.warning("Chat provider is disabled. Only non-chat routes will be available.")

    video_provider = VideoProvider()
    await video_provider.initialize()
    cookie_refresher = DoubaoCookieAutoRefresher(
        credential_manager_getter=_get_runtime_credential_manager,
        credential_manager_activator=_activate_runtime_credential_manager,
        playwright_manager_getter=_get_runtime_playwright_manager,
    )
    await cookie_refresher.start()
    logger.info(f"Service is available on http://localhost:{settings.NGINX_PORT}")

    yield

    if cookie_refresher:
        await cookie_refresher.close()
    if provider:
        await provider.close()
    if video_provider:
        await video_provider.close()
    signing_manager = quota_playwright_manager or quota_routes.quota_playwright_manager
    if signing_manager:
        await signing_manager.close()
    logger.info("Application stopped.")


app = FastAPI(
    title=settings.APP_NAME,
    version=settings.APP_VERSION,
    description=settings.DESCRIPTION,
    lifespan=lifespan,
)


video_routes.set_video_provider_getter(lambda: video_provider)
quota_routes.set_quota_provider_getters(lambda: provider, lambda: video_provider)
account_pool_routes.set_account_pool_dependencies(
    lambda: provider,
    lambda: video_provider,
    lambda: runtime_credential_manager,
    _set_runtime_credential_manager,
    _account_pool_quota_refresh,
    runtime_manager_activator=_activate_runtime_credential_manager,
    cookie_refresher_getter=lambda: cookie_refresher,
)


async def verify_api_key(authorization: Optional[str] = Header(None)):
    if settings.API_MASTER_KEY and settings.API_MASTER_KEY != "1":
        if not authorization or "bearer" not in authorization.lower():
            raise HTTPException(status_code=401, detail="Bearer token is required.")
        token = authorization.split(" ")[-1]
        if token != settings.API_MASTER_KEY and not _generated_api_key_valid(token):
            raise HTTPException(status_code=403, detail="Invalid API key.")


def _plugin_update_url(request: Request) -> str:
    return f"{str(request.base_url).rstrip('/')}/v1/doubao-cookie-plugin/update-cookie"


def _public_plugin_config(request: Request, config: dict[str, Any]) -> dict[str, Any]:
    token = str(config.get("connection_token") or "")
    return {
        "object": "doubao_cookie_plugin_config",
        "enabled": bool(config.get("enabled", True)),
        "connection_url": _plugin_update_url(request),
        "connection_token": token,
        "token_fingerprint": plugin_token_fingerprint(token),
        "extension_path": "doubao-cookie-sync-plugin",
        "created_at": config.get("created_at"),
        "updated_at": config.get("updated_at"),
    }


def _authorization_bearer_token(authorization: Optional[str]) -> str:
    text = str(authorization or "").strip()
    if not text:
        return ""
    if text.lower().startswith("bearer "):
        return text[7:].strip()
    return text


def _replace_settings_cookie(old_cookie: str, new_cookie: str) -> Optional[int]:
    old_identity = credential_identity(old_cookie)
    for index, cookie in enumerate(settings.DOUBAO_COOKIES):
        if credential_identity(cookie) == old_identity:
            settings.DOUBAO_COOKIES[index] = new_cookie
            return index
    return None


def _append_settings_cookie(cookie: str, *, weight: int, max_concurrency: int, disabled: bool) -> None:
    if cookie not in settings.DOUBAO_COOKIES:
        settings.DOUBAO_COOKIES.append(cookie)
        settings.DOUBAO_COOKIE_WEIGHTS.append(max(1, int(weight or 1)))
        settings.DOUBAO_COOKIE_MAX_CONCURRENCY.append(max(1, int(max_concurrency or 1)))
        settings.DOUBAO_COOKIE_DISABLED.append(bool(disabled))


def _replace_or_append_plugin_env_cookie(old_cookie: str, new_cookie: str, account: dict[str, Any]) -> int:
    if cookie_refresher and hasattr(cookie_refresher, "_replace_or_append_env_cookie"):
        return cookie_refresher._replace_or_append_env_cookie(old_cookie, new_cookie, account)

    env_path = Path(".env")
    text = env_path.read_text(encoding="utf-8") if env_path.exists() else ""
    old_identity = credential_identity(old_cookie)
    lines = text.splitlines(keepends=True)
    pattern = re.compile(r"^(\s*DOUBAO_COOKIE_(\d+)\s*=\s*)(.*?)(\r?\n)?$")
    for line_number, line in enumerate(lines):
        match = pattern.match(line)
        if not match:
            continue
        if credential_identity(_env_unquote(match.group(3))) != old_identity:
            continue
        lines[line_number] = f"{match.group(1)}{_env_quote(new_cookie)}{match.group(4) or ''}"
        env_path.write_text("".join(lines), encoding="utf-8")
        return int(match.group(2))

    return _persist_account_to_env(
        new_cookie,
        int(account.get("weight") or settings.DOUBAO_ACCOUNT_DEFAULT_WEIGHT),
        int(account.get("max_concurrency") or settings.DOUBAO_ACCOUNT_MAX_CONCURRENCY),
        str(account.get("status") or "").lower() == "disabled",
    )


def _find_credential_index(manager: CredentialManager, cookie: str) -> tuple[Optional[int], Optional[str]]:
    target_identity = credential_identity(cookie)
    for index, existing in enumerate(list(getattr(manager, "credentials", []) or [])):
        if credential_identity(existing) == target_identity:
            return index, existing
    return None, None


async def _sync_plugin_cookie(cookie: str, *, persist: bool = True) -> dict[str, Any]:
    manager = _get_runtime_credential_manager()
    action = "unchanged"
    env_index = None

    if manager is None:
        manager = CredentialManager(
            [cookie],
            weights=[settings.DOUBAO_ACCOUNT_DEFAULT_WEIGHT],
            max_concurrency=[settings.DOUBAO_ACCOUNT_MAX_CONCURRENCY],
            disabled=[False],
            global_concurrency=settings.DOUBAO_ACCOUNT_GLOBAL_CONCURRENCY,
            failure_threshold=settings.DOUBAO_ACCOUNT_FAILURE_THRESHOLD,
            cooldown_seconds=settings.DOUBAO_ACCOUNT_COOLDOWN_SECONDS,
            acquire_timeout=settings.DOUBAO_ACCOUNT_ACQUIRE_TIMEOUT,
        )
        account = manager.snapshot()["accounts"][0]
        action = "added"
        if persist:
            env_index = _persist_account_to_env(
                cookie,
                int(account.get("weight") or settings.DOUBAO_ACCOUNT_DEFAULT_WEIGHT),
                int(account.get("max_concurrency") or settings.DOUBAO_ACCOUNT_MAX_CONCURRENCY),
                False,
            )
        _append_settings_cookie(
            cookie,
            weight=int(account.get("weight") or settings.DOUBAO_ACCOUNT_DEFAULT_WEIGHT),
            max_concurrency=int(account.get("max_concurrency") or settings.DOUBAO_ACCOUNT_MAX_CONCURRENCY),
            disabled=False,
        )
    else:
        index, old_cookie = _find_credential_index(manager, cookie)
        if index is None:
            account = await manager.add_account(
                cookie,
                weight=settings.DOUBAO_ACCOUNT_DEFAULT_WEIGHT,
                max_concurrency=settings.DOUBAO_ACCOUNT_MAX_CONCURRENCY,
                disabled=False,
            )
            action = "added"
            if persist:
                env_index = _persist_account_to_env(
                    cookie,
                    int(account.get("weight") or settings.DOUBAO_ACCOUNT_DEFAULT_WEIGHT),
                    int(account.get("max_concurrency") or settings.DOUBAO_ACCOUNT_MAX_CONCURRENCY),
                    False,
                )
            _append_settings_cookie(
                cookie,
                weight=int(account.get("weight") or settings.DOUBAO_ACCOUNT_DEFAULT_WEIGHT),
                max_concurrency=int(account.get("max_concurrency") or settings.DOUBAO_ACCOUNT_MAX_CONCURRENCY),
                disabled=False,
            )
        elif normalize_doubao_cookie(old_cookie) == cookie:
            account = manager.snapshot()["accounts"][index]
        else:
            account = await manager.update_account_cookie(index, cookie)
            action = "updated"
            if persist:
                env_index = _replace_or_append_plugin_env_cookie(old_cookie or "", cookie, account)
            _replace_settings_cookie(old_cookie or "", cookie)

    await _activate_runtime_credential_manager(manager)
    try:
        await PlaywrightManager().register_account(cookie)
    except Exception as exc:
        logger.warning(f"Unable to register plugin-refreshed Doubao browser profile: {exc}")

    return {
        "object": "doubao_cookie_plugin_update",
        "success": True,
        "action": action,
        "persisted": bool(persist),
        "env_index": env_index,
        "account": account,
        "account_count": manager.snapshot().get("account_count"),
    }


@app.get("/v1/doubao-cookie-plugin/config", dependencies=[Depends(verify_api_key)], response_class=JSONResponse)
async def get_doubao_cookie_plugin_config(request: Request):
    config = ensure_plugin_config()
    return JSONResponse(content=_public_plugin_config(request, config))


@app.post("/v1/doubao-cookie-plugin/config", dependencies=[Depends(verify_api_key)], response_class=JSONResponse)
async def save_doubao_cookie_plugin_config(request: Request):
    data = await request.json()
    if data.get("rotate"):
        config = rotate_connection_token(enabled=data.get("enabled"))
    else:
        config = update_plugin_config(
            connection_token=data.get("connection_token"),
            enabled=data.get("enabled"),
        )
    return JSONResponse(content=_public_plugin_config(request, config))


@app.post("/v1/doubao-cookie-plugin/update-cookie", response_class=JSONResponse)
async def update_doubao_cookie_from_plugin(request: Request, authorization: Optional[str] = Header(None)):
    provided_token = _authorization_bearer_token(authorization)
    if not verify_connection_token(provided_token):
        raise HTTPException(status_code=401, detail="Invalid plugin connection token.")

    data = await request.json()
    cookie = normalize_doubao_cookie(
        data.get("cookie")
        or data.get("cookie_header")
        or data.get("cookies")
        or data.get("doubao_cookie")
    )
    if not cookie:
        raise HTTPException(status_code=400, detail="Missing Doubao cookie.")
    if any(separator in cookie for separator in ("\r", "\n")):
        raise HTTPException(status_code=400, detail="Doubao cookie cannot contain line breaks.")
    if not looks_like_logged_in_doubao_cookie(cookie):
        raise HTTPException(status_code=400, detail="Cookie does not contain a logged-in Doubao session.")

    result = await _sync_plugin_cookie(cookie, persist=_bool_value(data.get("persist"), True))
    return JSONResponse(content=result)


app.include_router(video_routes.router, dependencies=[Depends(verify_api_key)])
app.include_router(api_key_routes.router, dependencies=[Depends(verify_api_key)])
app.include_router(account_pool_routes.router, dependencies=[Depends(verify_api_key)])


def _custom_openapi() -> dict[str, Any]:
    if app.openapi_schema:
        return app.openapi_schema

    openapi_schema = get_openapi(
        title=app.title,
        version=app.version,
        description=app.description,
        routes=app.routes,
    )
    video_routes.add_video_openapi_paths(openapi_schema)
    openapi_schema["tags"] = [
        *[tag for tag in openapi_schema.get("tags", []) if tag.get("name") != "video"],
        {"name": "video", "description": "Video generation endpoints."},
    ]
    app.openapi_schema = openapi_schema
    return app.openapi_schema


app.openapi = _custom_openapi


@app.post("/v1/chat/completions", dependencies=[Depends(verify_api_key)])
async def chat_completions(request: Request):
    try:
        request_data = await request.json()
        logger.info(
            "Received /v1/chat/completions request:\n"
            f"{json.dumps(request_data, indent=2, ensure_ascii=False)}"
        )
        if request_data.get("model") in video_routes.video_model_names():
            return await video_routes.handle_video_chat_completion(request_data, str(request.base_url).rstrip("/"))
        if not provider:
            raise HTTPException(status_code=503, detail="Chat provider is disabled.")
        return await provider.chat_completion(request_data)
    except Exception as exc:
        logger.error(f"Failed to handle chat request: {exc}", exc_info=True)
        if isinstance(exc, HTTPException):
            raise exc
        raise HTTPException(status_code=500, detail=f"Internal server error: {exc}")


@app.get("/v1/models", dependencies=[Depends(verify_api_key)], response_class=JSONResponse)
async def list_models():
    created = int(time.time())
    data = []

    if provider:
        data.extend(
            {
                "id": name,
                "object": "model",
                "created": created,
                "owned_by": "lzA6",
            }
            for name in settings.MODEL_MAPPING.keys()
        )

    video_models = (
        settings.MOCK_VIDEO_MODEL_MAPPING
        if settings.VIDEO_PROVIDER == "mock"
        else settings.VIDEO_MODEL_MAPPING
    )
    durations = (
        settings.VIDEO_LONG_FORM_PUBLIC_DURATION_OPTIONS
        if settings.VIDEO_LONG_FORM_ENABLED
        else settings.VIDEO_DURATION_OPTIONS
    )
    video_parameters = {
        "durations": durations,
        "duration_options": durations,
        "seconds": durations,
        # Some schema-driven frontends use native_durations for the public selector.
        "native_durations": durations,
        "segment_durations": settings.VIDEO_DURATION_OPTIONS,
        "provider_native_durations": settings.VIDEO_DURATION_OPTIONS,
        "long_form": {
            "enabled": settings.VIDEO_LONG_FORM_ENABLED,
            "max_duration": settings.VIDEO_LONG_FORM_MAX_DURATION_SECONDS,
            "segment_duration": settings.VIDEO_LONG_FORM_SEGMENT_SECONDS,
        },
        "ratios": [
            {
                "value": key,
                "label": value["label"],
                "sizes": value["sizes"],
                "default_size": value["sizes"][settings.DEFAULT_VIDEO_RESOLUTION]["size"],
            }
            for key, value in settings.VIDEO_RATIO_MAPPING.items()
        ],
        "resolutions": list(settings.VIDEO_RESOLUTION_MAPPING.keys()),
        "reference_image": {
            "accepted_types": ["image/png", "image/jpeg", "image/webp"],
            "field": "reference_image",
        },
    }
    data.extend(
        {
            "id": name,
            "object": "model",
            "created": created,
            "owned_by": "local-video",
            "provider_model": provider_model,
            "video_parameters": video_parameters,
        }
        for name, provider_model in video_models.items()
    )
    return JSONResponse(content={"object": "list", "data": data})


def _admin_page() -> str:
    return (Path(__file__).parent / "app" / "static" / "admin.html").read_text(encoding="utf-8")


@app.get("/", include_in_schema=False, response_class=HTMLResponse)
def root():
    return HTMLResponse(_admin_page())


@app.get("/plugin-sync", include_in_schema=False, response_class=HTMLResponse)
def plugin_sync():
    return HTMLResponse(_admin_page())


@app.get("/video-test", include_in_schema=False, response_class=HTMLResponse)
def video_test():
    return HTMLResponse(_admin_page())
