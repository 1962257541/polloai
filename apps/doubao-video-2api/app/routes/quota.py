import re
from contextlib import suppress
from typing import Any, Callable, Optional

import httpx

from app.core.config import settings
from app.services.credential_manager import CredentialManager, is_quota_exhausted_error
from app.services.playwright_manager import PlaywrightManager


ProviderGetter = Callable[[], Any]

quota_playwright_manager: Optional[PlaywrightManager] = None
_provider_getter: ProviderGetter = lambda: None
_video_provider_getter: ProviderGetter = lambda: None


def set_quota_provider_getters(
    provider_getter: ProviderGetter,
    video_provider_getter: ProviderGetter,
) -> None:
    global _provider_getter, _video_provider_getter
    _provider_getter = provider_getter
    _video_provider_getter = video_provider_getter


def _quota_path_value(payload: Any, path: Optional[str]) -> Any:
    if not path:
        return None
    current = payload
    for raw_part in path.replace("[", ".").replace("]", "").split("."):
        part = raw_part.strip()
        if not part:
            continue
        if isinstance(current, dict):
            current = current.get(part)
        elif isinstance(current, list) and part.isdigit():
            index = int(part)
            current = current[index] if 0 <= index < len(current) else None
        else:
            return None
        if current is None:
            return None
    return current


def _quota_number(value: Any) -> Optional[float]:
    if value is None or isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        return float(value)
    if isinstance(value, str):
        match = re.search(r"-?\d+(?:\.\d+)?", value.replace(",", ""))
        if match:
            return float(match.group(0))
    return None


def _quota_normalized_key(value: Any) -> str:
    return re.sub(r"[^a-z0-9]", "", str(value).lower())


def _quota_name_set(names: set[str]) -> set[str]:
    return {_quota_normalized_key(name) for name in names}


VIDEO_QUOTA_CONTEXT_NAMES = _quota_name_set(
    {
        "video",
        "video_gen",
        "video_generation",
        "video_quota",
        "video_credit",
        "video_credits",
        "creation_video",
        "media_video",
    }
)
VIDEO_QUOTA_TOTAL_NAMES = _quota_name_set(
    {
        "video_total",
        "total_video",
        "video_total_quota",
        "video_total_credit",
        "video_total_credits",
        "video_limit",
        "video_quota",
        "total_count",
        "total_num",
        "limit",
        "quota",
    }
)
VIDEO_QUOTA_REMAINING_NAMES = _quota_name_set(
    {
        "video_remaining",
        "remaining_video",
        "video_remain",
        "video_remain_num",
        "video_remaining_num",
        "video_balance",
        "video_credit",
        "video_credits",
        "video_credit_num",
        "available_video",
        "available_video_num",
        "left_video",
        "left_video_num",
        "remaining",
        "remain",
        "remain_count",
        "remaining_count",
        "remain_num",
        "remaining_num",
        "available",
        "available_count",
        "available_num",
        "left",
        "left_count",
        "left_num",
        "free",
        "free_count",
        "free_num",
        "free_times",
        "remain_times",
        "remaining_times",
    }
)
VIDEO_QUOTA_USED_NAMES = _quota_name_set(
    {
        "video_used",
        "used_video",
        "video_used_num",
        "video_consumed",
        "video_consume",
        "used",
        "used_count",
        "used_num",
        "consumed",
        "consume",
        "cost",
    }
)

VIDEO_QUOTA_TEXT_CONTEXT_MARKERS = (
    "\u89c6\u9891\u751f\u6210",
    "\u89c6\u9891\u989d\u5ea6",
    "\u751f\u6210\u89c6\u9891",
    "video generation",
    "video quota",
    "video credit",
    "seedance",
)


def _quota_endpoint_is_video_specific(endpoint: Optional[str] = None) -> bool:
    """Compatibility shim: endpoint names alone are not trusted as quota proof."""
    return False


def _quota_result_is_advisory(endpoint: str) -> bool:
    return (
        "/commerce/benefit_supply/credit/" in endpoint
        and not (settings.DOUBAO_QUOTA_REMAINING_PATH or "").strip()
    )


def _quota_path_has_context(path: list[str], context_names: set[str]) -> bool:
    if not context_names:
        return True
    return any(marker in item or item in marker for item in path for marker in context_names)


def _quota_deep_find(
    payload: Any,
    names: set[str],
    context_names: Optional[set[str]] = None,
    *,
    require_context: bool = False,
    path: Optional[list[str]] = None,
) -> Optional[float]:
    path = path or []
    if isinstance(payload, dict):
        for key, value in payload.items():
            normalized = _quota_normalized_key(key)
            current_path = [*path, normalized]
            if normalized in names and (
                not require_context or _quota_path_has_context(current_path, context_names or set())
            ):
                number = _quota_number(value)
                if number is not None:
                    return number
        for key, value in payload.items():
            found = _quota_deep_find(
                value,
                names,
                context_names,
                require_context=require_context,
                path=[*path, _quota_normalized_key(key)],
            )
            if found is not None:
                return found
    elif isinstance(payload, list):
        for item in payload:
            found = _quota_deep_find(
                item,
                names,
                context_names,
                require_context=require_context,
                path=path,
            )
            if found is not None:
                return found
    return None


def _quota_direct_text_has_video_context(value: Any) -> bool:
    if isinstance(value, str):
        normalized = " ".join(value.lower().split())
        return any(marker in normalized for marker in VIDEO_QUOTA_TEXT_CONTEXT_MARKERS)
    if isinstance(value, dict):
        return any(
            _quota_path_has_context([_quota_normalized_key(key)], VIDEO_QUOTA_CONTEXT_NAMES)
            or (isinstance(child, str) and _quota_direct_text_has_video_context(child))
            for key, child in value.items()
        )
    if isinstance(value, list):
        return any(_quota_direct_text_has_video_context(item) for item in value if isinstance(item, str))
    return False


def _quota_dict_number(payload: dict[str, Any], names: set[str]) -> Optional[float]:
    for key, value in payload.items():
        if _quota_normalized_key(key) in names:
            number = _quota_number(value)
            if number is not None:
                return number
    return None


BENEFIT_CREDIT_REMAINING_NAMES = _quota_name_set({"total_credit_num", "credit_num"})


def _benefit_video_credit_remaining(payload: Any, *, parent_has_context: bool = False) -> Optional[float]:
    if isinstance(payload, dict):
        current_has_context = _quota_direct_text_has_video_context(payload)
        remaining = _quota_dict_number(payload, BENEFIT_CREDIT_REMAINING_NAMES)
        if remaining is not None and (current_has_context or parent_has_context):
            return remaining
        for child in payload.values():
            found = _benefit_video_credit_remaining(child, parent_has_context=current_has_context)
            if found is not None:
                return found
    elif isinstance(payload, list):
        for item in payload:
            found = _benefit_video_credit_remaining(item, parent_has_context=parent_has_context)
            if found is not None:
                return found
    return None


def _parse_quota_payload(payload: Any) -> dict[str, Optional[float]]:
    total_path = (settings.DOUBAO_QUOTA_TOTAL_PATH or "").strip()
    remaining_path = (settings.DOUBAO_QUOTA_REMAINING_PATH or "").strip()
    used_path = (settings.DOUBAO_QUOTA_USED_PATH or "").strip()

    total = _quota_number(_quota_path_value(payload, total_path)) if total_path else None
    remaining = _quota_number(_quota_path_value(payload, remaining_path)) if remaining_path else None
    used = _quota_number(_quota_path_value(payload, used_path)) if used_path else None

    if remaining is None and not remaining_path:
        remaining = _benefit_video_credit_remaining(payload)

    if total is None and not total_path:
        total = _quota_deep_find(
            payload,
            VIDEO_QUOTA_TOTAL_NAMES,
            VIDEO_QUOTA_CONTEXT_NAMES,
            require_context=True,
        )
    if remaining is None and not remaining_path:
        remaining = _quota_deep_find(
            payload,
            VIDEO_QUOTA_REMAINING_NAMES,
            VIDEO_QUOTA_CONTEXT_NAMES,
            require_context=True,
        )
    if used is None and not used_path:
        used = _quota_deep_find(
            payload,
            VIDEO_QUOTA_USED_NAMES,
            VIDEO_QUOTA_CONTEXT_NAMES,
            require_context=True,
        )

    if total is not None and remaining is not None and used is None:
        used = max(total - remaining, 0)
    if total is not None and used is not None and remaining is None:
        remaining = max(total - used, 0)
    return {"total": total, "remaining": remaining, "used": used}


def _quota_business_error(payload: Any) -> Optional[str]:
    if not isinstance(payload, dict):
        return None
    code = payload.get("code")
    if code in (None, 0, "0"):
        return None
    message = payload.get("message") or payload.get("msg") or payload.get("error")
    if isinstance(message, dict):
        message = message.get("message") or message.get("msg") or message.get("code")
    message_text = str(message or "business error")
    if str(code) == "710012001" or "login invalid" in message_text.lower() or "登录已过期" in message_text:
        return (
            f"Doubao 登录态已失效（code {code}: {message_text}）。"
            "请在账号池更新该账号 Cookie 后再刷新真实额度。"
        )
    return f"Quota endpoint returned code {code}: {message_text}"


def _quota_is_auth_error(payload: Any, message: str = "") -> bool:
    if not isinstance(payload, dict):
        return False
    code = str(payload.get("code") or "")
    text = " ".join(
        str(item or "")
        for item in (
            payload.get("message"),
            payload.get("msg"),
            payload.get("error"),
            message,
        )
    ).lower()
    return code == "710012001" or "login invalid" in text or "鐧诲綍宸茶繃鏈" in text


def _quota_base_params() -> dict[str, str]:
    return {
        "aid": "497858",
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
        "fp": settings.DOUBAO_FP,
    }


def _quota_headers(cookie: str) -> dict[str, str]:
    return {
        "Accept": "application/json, text/plain, */*",
        "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
        "Content-Type": "application/json",
        "Cookie": cookie,
        "Origin": "https://www.doubao.com",
        "Referer": "https://www.doubao.com/chat/",
        "User-Agent": (
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
            "(KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36"
        ),
        "agw-js-conv": "str",
        "sec-ch-ua": '"Microsoft Edge";v="149", "Chromium";v="149", "Not)A;Brand";v="24"',
        "sec-ch-ua-mobile": "?0",
        "sec-ch-ua-platform": '"Windows"',
        "sec-fetch-dest": "empty",
        "sec-fetch-mode": "cors",
        "sec-fetch-site": "same-origin",
    }


def _quota_error_message(exc: Exception) -> str:
    if isinstance(exc, httpx.HTTPStatusError):
        return f"Quota endpoint returned HTTP {exc.response.status_code}."
    if isinstance(exc, httpx.RequestError):
        return f"Quota endpoint request failed: {exc.__class__.__name__}."
    return str(exc) or exc.__class__.__name__


def _cookie_with_ms_token(cookie: str, token: Optional[str]) -> str:
    if not token:
        return cookie
    if "msToken=" in cookie:
        return re.sub(r"msToken=[^;]+", f"msToken={token}", cookie)
    return f"{cookie.rstrip('; ')}; msToken={token}"


async def _quota_signing_manager(cookie: str) -> PlaywrightManager:
    global quota_playwright_manager

    provider = _provider_getter()
    video_provider = _video_provider_getter()
    signing = None
    if provider and getattr(provider, "playwright_manager", None):
        signing = provider.playwright_manager
    elif video_provider and getattr(video_provider, "playwright_manager", None):
        signing = video_provider.playwright_manager
    elif quota_playwright_manager:
        signing = quota_playwright_manager

    if signing:
        return signing

    if not all([settings.DOUBAO_DEVICE_ID, settings.DOUBAO_FP, settings.DOUBAO_TEA_UUID, settings.DOUBAO_WEB_ID]):
        raise RuntimeError(
            "DOUBAO_QUOTA_SIGNED=true requires DOUBAO_DEVICE_ID, DOUBAO_FP, "
            "DOUBAO_TEA_UUID, and DOUBAO_WEB_ID."
        )

    quota_playwright_manager = PlaywrightManager()
    await quota_playwright_manager.initialize([cookie])
    return quota_playwright_manager


async def _signed_quota_request(endpoint: str, cookie: str) -> tuple[str, str]:
    signing = await _quota_signing_manager(cookie)
    token_getter = getattr(signing, "get_ms_token", None)
    account_ms_token = token_getter(cookie) if callable(token_getter) else getattr(signing, "ms_token", None)
    request_cookie = _cookie_with_ms_token(cookie, account_ms_token)
    signed = await signing.get_signed_url(endpoint, request_cookie, _quota_base_params())
    if not signed:
        raise RuntimeError("Unable to sign quota request.")
    return signed, request_cookie


async def refresh_account_quota(manager: CredentialManager, index: int) -> dict[str, Any]:
    video_provider = _video_provider_getter()
    history_refresh = getattr(video_provider, "refresh_account_video_quota", None)
    if callable(history_refresh) and getattr(video_provider, "credential_manager", None) is manager:
        history_result = await history_refresh(index)
        if history_result.get("found"):
            return history_result

    endpoint = (settings.DOUBAO_QUOTA_ENDPOINT or "").strip()
    if not endpoint:
        if callable(history_refresh):
            return history_result
        account = await manager.update_quota(
            index,
            unit=settings.DOUBAO_QUOTA_UNIT,
            source="not_configured",
            status="unsupported",
            error="DOUBAO_QUOTA_ENDPOINT is not configured.",
        )
        return {"account": account, "supported": False, "message": "Quota endpoint is not configured."}

    cookie = await manager.get_cookie(index)
    request_cookie = cookie
    url = endpoint
    method = settings.DOUBAO_QUOTA_METHOD.upper()
    signing_manager = None
    try:
        if settings.DOUBAO_QUOTA_SIGNED:
            signing_manager = await _quota_signing_manager(cookie)
            url, request_cookie = await _signed_quota_request(endpoint, cookie)
        async with httpx.AsyncClient(timeout=settings.API_REQUEST_TIMEOUT, follow_redirects=True) as client:
            body = settings.DOUBAO_QUOTA_REQUEST_BODY if method == "POST" else None
            response = await client.request(method, url, headers=_quota_headers(request_cookie), json=body)
            response.raise_for_status()
            payload = response.json()
    except Exception as exc:
        message = _quota_error_message(exc)
        account = await manager.mark_quota_error(index, message, source="upstream")
        return {"account": account, "supported": True, "message": message}
    finally:
        close_account_session = getattr(signing_manager, "close_account_session", None)
        if close_account_session:
            with suppress(Exception):
                await close_account_session(cookie)

    business_error = _quota_business_error(payload)
    if business_error:
        if _quota_is_auth_error(payload, business_error):
            account = await manager.mark_quota_error(index, business_error, source="upstream")
        elif is_quota_exhausted_error(business_error):
            account = await manager.disable_for_quota_exhausted(index, business_error, source="upstream")
        else:
            account = await manager.mark_quota_error(index, business_error, source="upstream")
        return {"account": account, "supported": True, "message": business_error}

    parsed = _parse_quota_payload(payload)
    if parsed["remaining"] is None and parsed["used"] is None:
        account = await manager.update_quota(
            index,
            unit=settings.DOUBAO_QUOTA_UNIT,
            source="upstream",
            status="unknown",
            error="Quota response did not contain parsable remaining or used fields.",
        )
        return {"account": account, "supported": True, "message": "Quota fields were not found in upstream response."}

    if _quota_result_is_advisory(endpoint):
        account = manager.snapshot()["accounts"][index]
        return {
            "account": account,
            "supported": True,
            "message": "Benefit credit refreshed separately; confirmed video quota was not changed.",
            "advisory": {
                "total": parsed["total"],
                "remaining": parsed["remaining"],
                "used": parsed["used"],
                "unit": "benefit credits",
                "source": "benefit_credit_advisory",
            },
        }

    if parsed["remaining"] is not None and parsed["remaining"] <= 0:
        account = await manager.update_quota(
            index,
            total=parsed["total"],
            remaining=parsed["remaining"],
            used=parsed["used"],
            unit=settings.DOUBAO_QUOTA_UNIT,
            source="upstream",
            status="exhausted",
            error="Doubao quota remaining is 0.",
        )
        account = await manager.disable_for_quota_exhausted(index, "Doubao quota remaining is 0.", source="upstream")
        return {"account": account, "supported": True, "message": "Quota exhausted; account disabled automatically."}

    account = await manager.update_quota(
        index,
        total=parsed["total"],
        remaining=parsed["remaining"],
        used=parsed["used"],
        unit=settings.DOUBAO_QUOTA_UNIT,
        source="upstream",
        status="available",
    )
    return {"account": account, "supported": True, "message": "Quota refreshed from upstream."}


_refresh_account_quota = refresh_account_quota
