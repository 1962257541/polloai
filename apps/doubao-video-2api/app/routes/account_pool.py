import asyncio
import json
import os
import re
import time
from pathlib import Path
from typing import Any, Awaitable, Callable, Optional

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import FileResponse, JSONResponse

from app.core.config import normalize_doubao_cookie, settings
from app.services.credential_manager import CredentialManager, credential_identity
from app.services.doubao_context_template import context_summary_for_public, load_latest_context_template
from app.services.manual_verification import ManualVerificationManager
from app.services.playwright_manager import PlaywrightManager
from app.routes import quota as quota_service


ProviderGetter = Callable[[], Any]
RuntimeManagerGetter = Callable[[], Optional[CredentialManager]]
RuntimeManagerSetter = Callable[[CredentialManager], None]
RuntimeManagerActivator = Callable[[CredentialManager], Awaitable[None]]
QuotaRefresh = Callable[[CredentialManager, int], Awaitable[dict[str, Any]]]
CookieRefresherGetter = Callable[[], Any]

router = APIRouter(prefix="/v1", tags=["admin"])

_provider_getter: ProviderGetter = lambda: None
_video_provider_getter: ProviderGetter = lambda: None
_runtime_manager_getter: RuntimeManagerGetter = lambda: None
_runtime_manager_setter: RuntimeManagerSetter = lambda manager: None
_runtime_manager_activator: Optional[RuntimeManagerActivator] = None
_quota_refresh: QuotaRefresh = quota_service.refresh_account_quota
_cookie_refresher_getter: CookieRefresherGetter = lambda: None
_manual_verification = ManualVerificationManager.shared()


def _context_bool(value: Any) -> bool:
    return str(value or "").strip().lower() in {"1", "true", "yes", "y", "on"}


def set_account_pool_dependencies(
    provider_getter: ProviderGetter,
    video_provider_getter: ProviderGetter,
    runtime_manager_getter: RuntimeManagerGetter,
    runtime_manager_setter: RuntimeManagerSetter,
    quota_refresh: Optional[QuotaRefresh] = None,
    runtime_manager_activator: Optional[RuntimeManagerActivator] = None,
    cookie_refresher_getter: Optional[CookieRefresherGetter] = None,
) -> None:
    global _provider_getter, _video_provider_getter, _runtime_manager_getter
    global _runtime_manager_setter, _runtime_manager_activator, _quota_refresh, _cookie_refresher_getter

    _provider_getter = provider_getter
    _video_provider_getter = video_provider_getter
    _runtime_manager_getter = runtime_manager_getter
    _runtime_manager_setter = runtime_manager_setter
    _runtime_manager_activator = runtime_manager_activator
    if quota_refresh is not None:
        _quota_refresh = quota_refresh
    if cookie_refresher_getter is not None:
        _cookie_refresher_getter = cookie_refresher_getter


async def _activate_runtime_manager(manager: CredentialManager) -> None:
    _runtime_manager_setter(manager)
    if _runtime_manager_activator is not None:
        await _runtime_manager_activator(manager)
        return
    video_provider = _video_provider_getter()
    attach = getattr(video_provider, "attach_credential_manager", None)
    if callable(attach):
        await attach(manager, run_initial_refresh=False)


def _account_pool_manager():
    provider = _provider_getter()
    video_provider = _video_provider_getter()
    runtime_credential_manager = _runtime_manager_getter()

    if provider and getattr(provider, "credential_manager", None):
        return provider.credential_manager
    if video_provider and getattr(video_provider, "credential_manager", None):
        return video_provider.credential_manager
    if runtime_credential_manager:
        return runtime_credential_manager
    settings.load_persisted_accounts()
    if settings.DOUBAO_COOKIES:
        runtime_credential_manager = CredentialManager.from_settings()
        _runtime_manager_setter(runtime_credential_manager)
        return runtime_credential_manager
    raise HTTPException(status_code=503, detail="Account pool is not initialized.")


def _quota_refresh_status() -> dict[str, Any]:
    video_provider = _video_provider_getter()
    status = getattr(video_provider, "quota_refresh_status", None)
    if callable(status):
        return status()
    return {
        "enabled": False,
        "in_progress": False,
        "interval_seconds": None,
        "timeout_seconds": None,
        "started_at": None,
        "completed_at": None,
        "next_run_at": None,
        "last_error": None,
        "last_result": None,
    }


def _account_pool_payload(
    manager: CredentialManager,
    *,
    object_name: str = "account_pool",
    **extra: Any,
) -> dict[str, Any]:
    video_provider = _video_provider_getter()
    frontend_queue_status = getattr(video_provider, "frontend_queue_status", None)
    return {
        "object": object_name,
        "enabled": True,
        "browser_pool": PlaywrightManager().pool_snapshot(),
        "frontend_queues": frontend_queue_status() if callable(frontend_queue_status) else {},
        "quota_refresh": _quota_refresh_status(),
        **extra,
        **manager.snapshot(),
    }


def _public_account_snapshot(manager: CredentialManager, index: int) -> Optional[dict[str, Any]]:
    for account in manager.snapshot().get("accounts", []):
        if int(account.get("index", -1)) == int(index):
            return account
    return None


LOGIN_REQUIRED_MESSAGE = (
    "Doubao page shows the Login button in the verification browser; "
    "the account cookie is not signed in."
)


async def _sync_manual_verification_account_state(
    manager: CredentialManager,
    index: int,
    verification: dict[str, Any],
) -> dict[str, Any]:
    if not isinstance(verification, dict):
        return verification
    if not verification.get("login_required"):
        return verification

    account = _public_account_snapshot(manager, index)
    if not account or account.get("disabled_reason") == "login_expired":
        return verification

    try:
        await manager.disable_for_login_expired(index, LOGIN_REQUIRED_MESSAGE)
        verification["account_state_updated"] = "login_required"
    except IndexError:
        pass
    return verification


def _verification_completion_ready(verification: dict[str, Any]) -> bool:
    if not isinstance(verification, dict) or verification.get("login_required"):
        return False
    if verification.get("manual_success_detected"):
        return True
    bdturing_result = verification.get("bdturing_result") if isinstance(verification.get("bdturing_result"), dict) else {}
    if str(bdturing_result.get("status") or "").lower() == "success":
        return True
    auto_solve = verification.get("auto_solve_result") if isinstance(verification.get("auto_solve_result"), dict) else {}
    solution = auto_solve.get("captcha_solution") if isinstance(auto_solve.get("captcha_solution"), dict) else {}
    return bool(solution.get("solved"))


async def _finish_manual_verification(
    manager: CredentialManager,
    account_index: int,
    resolved_verification: dict[str, Any] | None = None,
) -> tuple[dict[str, Any], dict[str, Any] | None, dict[str, Any] | None, dict[str, Any] | None]:
    verification = await _manual_verification.complete(account_index)
    if isinstance(resolved_verification, dict):
        for key in (
            "auto_solve_result",
            "bdturing_render",
            "bdturing_result",
            "captcha_probe",
            "manual_success_detected",
            "manual_success_terms",
            "visual_challenge_seen",
        ):
            if key in resolved_verification and key not in verification:
                verification[key] = resolved_verification[key]

    cookie_header = normalize_doubao_cookie(verification.pop("cookie_header", None) or "")
    account = None
    browser_profile = None
    if cookie_header:
        try:
            old_cookie = await manager.get_cookie(account_index)
            account = await manager.update_account_cookie(account_index, cookie_header)
            _replace_account_store_if_present(
                old_cookie,
                cookie_header,
                int(account.get("weight") or settings.DOUBAO_ACCOUNT_DEFAULT_WEIGHT),
                int(account.get("max_concurrency") or settings.DOUBAO_ACCOUNT_MAX_CONCURRENCY),
                str(account.get("status") or "").lower() == "disabled",
            )
        except (IndexError, ValueError) as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        browser_profile = await PlaywrightManager().register_account(cookie_header)
    try:
        account = await manager.clear_cooldown(account_index)
        account = await manager.reset_health(account_index)
    except IndexError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc

    quota_refresh = None
    try:
        quota_refresh = await _quota_refresh(manager, account_index)
    except Exception as exc:
        quota_refresh = {"status": "error", "message": str(exc)}

    verification = _verification_with_account_context(manager, account_index, verification)
    if isinstance(resolved_verification, dict):
        auto_solve = (
            resolved_verification.get("auto_solve_result")
            if isinstance(resolved_verification.get("auto_solve_result"), dict)
            else {}
        )
        solution = auto_solve.get("captcha_solution") if isinstance(auto_solve.get("captcha_solution"), dict) else {}
        captcha_probe = (
            resolved_verification.get("captcha_probe")
            if isinstance(resolved_verification.get("captcha_probe"), dict)
            else {}
        )
        auto_solve_attempted = bool(solution.get("attempted"))
        auto_solve_solved = bool(solution.get("solved"))
        verification["auto_solve_attempted"] = auto_solve_attempted
        verification["auto_solve_solved"] = auto_solve_solved
        verification["visible_challenge_detected"] = bool(
            resolved_verification.get("visible_challenge_detected")
            or resolved_verification.get("visual_challenge_seen")
            or resolved_verification.get("manual_success_detected")
            or captcha_probe.get("solver_compatible")
            or auto_solve_attempted
            or auto_solve_solved
        )
    return verification, account, browser_profile, quota_refresh


def _verification_with_account_context(
    manager: CredentialManager,
    index: int,
    verification: dict[str, Any],
) -> dict[str, Any]:
    payload = dict(verification or {})
    account = _public_account_snapshot(manager, index)
    if not account:
        return payload

    payload["account"] = {
        "index": account.get("index"),
            "fingerprint": account.get("fingerprint"),
            "status": account.get("status"),
            "disabled_reason": account.get("disabled_reason"),
            "last_error": account.get("last_error"),
            "requires_verification": account.get("requires_verification"),
            "verification_required_at": account.get("verification_required_at"),
            "quota": account.get("quota"),
        }
    payload["account_status"] = account.get("status")
    payload["account_disabled_reason"] = account.get("disabled_reason")
    payload["requires_verification"] = account.get("requires_verification")
    payload["verification_required_at"] = account.get("verification_required_at")
    payload["verification_error"] = account.get("verification_error")
    if account.get("verification_context"):
        payload["verification_context"] = account["verification_context"]
    current_page_login_state_known = (
        payload.get("status") not in {None, "idle"}
        and payload.get("login_required") is not None
    )
    login_required = bool(payload.get("login_required")) or bool(
        not current_page_login_state_known
        and (
            account.get("status") == "login_required"
            or account.get("disabled_reason") == "login_expired"
        )
    )
    payload["login_required"] = login_required
    if login_required:
        payload["completion_blocked"] = True
        payload["manual_success_required"] = True
        payload["message"] = (
            "Doubao page is not logged in; click Login in the snapshot page, sign in, "
            "then click Done to save the refreshed cookie."
        )
        return payload
    detected_terms = payload.get("detected_terms") or []
    captcha_probe = payload.get("captcha_probe") if isinstance(payload.get("captcha_probe"), dict) else {}
    bdturing_render = payload.get("bdturing_render") if isinstance(payload.get("bdturing_render"), dict) else {}
    auto_solve = payload.get("auto_solve_result") if isinstance(payload.get("auto_solve_result"), dict) else {}
    auto_solution = auto_solve.get("captcha_solution") if isinstance(auto_solve.get("captcha_solution"), dict) else {}
    auto_solve_attempted = bool(auto_solution.get("attempted"))
    auto_solve_solved = bool(auto_solution.get("solved"))
    context = account.get("verification_context") if isinstance(account.get("verification_context"), dict) else {}
    trigger_visible_challenge = _context_bool(context.get("trigger_visible_challenge"))
    trigger_solver_compatible = _context_bool(context.get("trigger_solver_compatible"))
    current_solver_compatible = bool(captcha_probe.get("solver_compatible"))
    token_render_visible = bool(bdturing_render.get("container_visible"))
    token_render_called = bool(bdturing_render.get("render_called"))
    zhenxun_drag_captcha_detected = current_solver_compatible or trigger_solver_compatible
    manual_success_detected = bool(payload.get("manual_success_detected"))
    if account.get("requires_verification") and account.get("verification_context"):
        payload["zhenxun_drag_captcha_detected"] = zhenxun_drag_captcha_detected
        payload["trigger_visible_challenge"] = trigger_visible_challenge
        payload["trigger_solver_compatible"] = trigger_solver_compatible
        payload["bdturing_token_rendered"] = token_render_called
        payload["auto_solve_attempted"] = auto_solve_attempted
        payload["auto_solve_solved"] = auto_solve_solved
        payload["visible_challenge_detected"] = (
            bool(detected_terms)
            or zhenxun_drag_captcha_detected
            or trigger_visible_challenge
            or token_render_visible
            or auto_solve_attempted
            or auto_solve_solved
        )
        payload["manual_success_detected"] = manual_success_detected
        if not payload["visible_challenge_detected"]:
            payload["server_verification_only"] = True
            if manual_success_detected:
                payload["message"] = (
                    "Manual Doubao video generation success was observed in the same browser page; "
                    "finish to save the session and refresh the account."
                )
            elif payload.get("visual_challenge_seen"):
                payload["message"] = (
                    "A Doubao visual verification challenge was seen earlier in this browser page; "
                    "finish will save the session and refresh the account."
                )
            else:
                payload["manual_success_required"] = True
                if token_render_called:
                    payload["message"] = (
                        "Doubao server blocked /chat/completion; the BDTuring verify_data token render was "
                        "attempted, but no visible captcha/challenge is currently rendered in this browser page."
                    )
                else:
                    payload["message"] = (
                        "Doubao server blocked /chat/completion; no visible captcha/challenge "
                        "is currently rendered in this browser page."
                    )
        elif token_render_visible:
            payload["message"] = "Doubao token verification challenge is visible in this browser page."
        elif auto_solve_solved:
            payload["message"] = (
                "Doubao drag captcha was auto-solved in this browser page; finish to save the session "
                "and refresh the account."
            )
        elif auto_solve_attempted:
            payload["message"] = "Doubao drag captcha auto-solve was attempted; check auto_solve_result for details."
        elif current_solver_compatible:
            payload["message"] = (
                "Doubao drag captcha is visible and matches zhenxun-plugin-ai_creation selectors."
            )
        elif trigger_solver_compatible:
            payload["message"] = (
                "A Doubao drag captcha matching zhenxun-plugin-ai_creation selectors was observed during "
                "the original /chat/completion trigger, but it is not currently visible in this snapshot."
            )
        elif trigger_visible_challenge:
            payload["message"] = (
                "A Doubao visual challenge was observed during the original /chat/completion trigger, "
                "but it is not currently visible in this verification snapshot."
            )
    return payload


async def _refresh_registered_account_quota(
    manager: CredentialManager,
    index: int,
) -> Optional[dict[str, Any]]:
    video_provider = _video_provider_getter()
    refresh = getattr(video_provider, "refresh_account_video_quota", None)
    if not callable(refresh) or getattr(video_provider, "credential_manager", None) is not manager:
        return None
    return await refresh(index)


async def _attach_video_provider_manager(manager: CredentialManager) -> None:
    await _activate_runtime_manager(manager)


def _positive_int(value: Any, default: int, name: str) -> int:
    if value is None or value == "":
        return max(1, int(default))
    try:
        parsed = int(value)
    except (TypeError, ValueError) as exc:
        raise HTTPException(status_code=400, detail=f"{name} must be a positive integer.") from exc
    return max(1, parsed)


def _bool_value(value: Any, default: bool = False) -> bool:
    if value is None:
        return default
    if isinstance(value, bool):
        return value
    return str(value).strip().lower() in {"1", "true", "yes", "y", "on"}


def _new_account_payload(data: dict[str, Any]) -> dict[str, Any]:
    cookie = normalize_doubao_cookie(data.get("cookie") or data.get("credential"))
    if not cookie:
        raise HTTPException(status_code=400, detail="Credential cookie cannot be empty.")
    if any(separator in cookie for separator in ("\r", "\n")):
        raise HTTPException(status_code=400, detail="Credential cookie cannot contain line breaks.")

    return {
        "cookie": cookie,
        "weight": _positive_int(data.get("weight"), settings.DOUBAO_ACCOUNT_DEFAULT_WEIGHT, "weight"),
        "max_concurrency": _positive_int(
            data.get("max_concurrency"),
            settings.DOUBAO_ACCOUNT_MAX_CONCURRENCY,
            "max_concurrency",
        ),
        "disabled": _bool_value(data.get("disabled"), False),
        "persist": _bool_value(data.get("persist"), True),
    }


def _bulk_account_payload(data: dict[str, Any]) -> dict[str, Any]:
    raw = data.get("cookies")
    if raw is None:
        raw = data.get("tokens")
    if raw is None:
        raw = data.get("credentials")
    if isinstance(raw, str):
        cookies = [
            normalized
            for line in raw.splitlines()
            if (normalized := normalize_doubao_cookie(line))
        ]
    elif isinstance(raw, list):
        cookies = [
            normalized
            for item in raw
            if (normalized := normalize_doubao_cookie(item))
        ]
    else:
        cookies = []
    if not cookies:
        raise HTTPException(status_code=400, detail="At least one credential cookie is required.")

    for cookie in cookies:
        if any(separator in cookie for separator in ("\r", "\n")):
            raise HTTPException(status_code=400, detail="Credential cookie cannot contain line breaks.")

    return {
        "cookies": cookies,
        "weight": _positive_int(data.get("weight"), settings.DOUBAO_ACCOUNT_DEFAULT_WEIGHT, "weight"),
        "max_concurrency": _positive_int(
            data.get("max_concurrency"),
            settings.DOUBAO_ACCOUNT_MAX_CONCURRENCY,
            "max_concurrency",
        ),
        "disabled": _bool_value(data.get("disabled"), False),
        "persist": _bool_value(data.get("persist"), True),
    }


def _env_quote(value: str) -> str:
    return '"' + value.replace("\\", "\\\\").replace('"', '\\"') + '"'


def _env_unquote(value: str) -> str:
    text = value.strip()
    if len(text) >= 2 and text[0] == text[-1] == '"':
        text = text[1:-1]
        return text.replace('\\"', '"').replace("\\\\", "\\")
    return text


def _persist_account_to_env(cookie: str, weight: int, max_concurrency: int, disabled: bool) -> int:
    env_path = Path(".env")
    text = env_path.read_text(encoding="utf-8") if env_path.exists() else ""
    used_indexes = {
        int(match.group(1))
        for match in re.finditer(r"(?m)^\s*DOUBAO_COOKIE_(\d+)\s*=", text)
    }

    index = 1
    while index in used_indexes or os.getenv(f"DOUBAO_COOKIE_{index}"):
        index += 1

    prefix = "" if not text or text.endswith(("\n", "\r")) else "\n"
    block = "\n".join(
        [
            f"DOUBAO_COOKIE_{index}={_env_quote(cookie)}",
            f"DOUBAO_COOKIE_WEIGHT_{index}={weight}",
            f"DOUBAO_COOKIE_MAX_CONCURRENCY_{index}={max_concurrency}",
            f"DOUBAO_COOKIE_DISABLED_{index}={'true' if disabled else 'false'}",
            "",
        ]
    )
    env_path.write_text(f"{text}{prefix}{block}", encoding="utf-8")
    return index


def _remove_account_from_env(cookie: str) -> Optional[int]:
    env_path = Path(".env")
    if not env_path.exists():
        return None

    text = env_path.read_text(encoding="utf-8")
    target_identity = credential_identity(cookie)
    found_index = None
    for match in re.finditer(r"(?m)^\s*DOUBAO_COOKIE_(\d+)\s*=\s*(.*)$", text):
        if credential_identity(_env_unquote(match.group(2))) == target_identity:
            found_index = int(match.group(1))
            break
    if found_index is None:
        return None

    pattern = re.compile(
        rf"(?m)^\s*DOUBAO_COOKIE(?:_WEIGHT|_MAX_CONCURRENCY|_DISABLED)?_{found_index}\s*=.*(?:\r?\n)?"
    )
    updated = pattern.sub("", text)
    env_path.write_text(updated, encoding="utf-8")
    return found_index


def _account_store_path() -> Path:
    return Path(settings.DOUBAO_ACCOUNT_STORE_PATH)


def _load_persisted_account_records() -> list[dict[str, Any]]:
    path = _account_store_path()
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return []
    except (json.JSONDecodeError, OSError):
        return []

    records = payload.get("accounts") if isinstance(payload, dict) else payload
    if not isinstance(records, list):
        return []
    return [dict(record) for record in records if isinstance(record, dict)]


def _save_persisted_account_records(records: list[dict[str, Any]]) -> None:
    path = _account_store_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps({"version": 1, "accounts": records}, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )


def _persisted_record_identity(record: dict[str, Any]) -> str:
    identity = str(record.get("identity") or "").strip()
    if identity:
        return identity
    return credential_identity(normalize_doubao_cookie(record.get("cookie") or record.get("credential")))


def _persisted_account_record(cookie: str, weight: int, max_concurrency: int, disabled: bool) -> dict[str, Any]:
    identity = credential_identity(cookie)
    now = time.time()
    return {
        "identity": identity,
        "cookie": cookie,
        "weight": max(1, int(weight or 1)),
        "max_concurrency": max(1, int(max_concurrency or 1)),
        "disabled": bool(disabled),
        "updated_at": now,
    }


def _persist_account_to_store(cookie: str, weight: int, max_concurrency: int, disabled: bool) -> int:
    cookie = normalize_doubao_cookie(cookie)
    if not cookie:
        raise ValueError("Credential cookie cannot be empty.")
    records = _load_persisted_account_records()
    record = _persisted_account_record(cookie, weight, max_concurrency, disabled)
    target_identity = record["identity"]
    for index, existing in enumerate(records):
        if _persisted_record_identity(existing) != target_identity:
            continue
        records[index] = {
            **existing,
            **record,
            "created_at": existing.get("created_at") or record["updated_at"],
        }
        _save_persisted_account_records(records)
        return index + 1

    records.append({**record, "created_at": record["updated_at"]})
    _save_persisted_account_records(records)
    return len(records)


def _remove_account_from_store(cookie: str) -> Optional[int]:
    target_identity = credential_identity(cookie)
    if not target_identity:
        return None
    records = _load_persisted_account_records()
    for index, existing in enumerate(records):
        if _persisted_record_identity(existing) != target_identity:
            continue
        records.pop(index)
        _save_persisted_account_records(records)
        return index + 1
    return None


def _replace_or_append_account_store(
    old_cookie: str,
    new_cookie: str,
    weight: int,
    max_concurrency: int,
    disabled: bool,
) -> int:
    new_cookie = normalize_doubao_cookie(new_cookie)
    if not new_cookie:
        raise ValueError("Credential cookie cannot be empty.")
    old_identity = credential_identity(old_cookie)
    new_record = _persisted_account_record(new_cookie, weight, max_concurrency, disabled)
    records = _load_persisted_account_records()
    for index, existing in enumerate(records):
        identity = _persisted_record_identity(existing)
        if identity not in {old_identity, new_record["identity"]}:
            continue
        records[index] = {
            **existing,
            **new_record,
            "created_at": existing.get("created_at") or new_record["updated_at"],
        }
        _save_persisted_account_records(records)
        return index + 1
    records.append({**new_record, "created_at": new_record["updated_at"]})
    _save_persisted_account_records(records)
    return len(records)


def _replace_account_store_if_present(
    old_cookie: str,
    new_cookie: str,
    weight: int,
    max_concurrency: int,
    disabled: bool,
) -> Optional[int]:
    old_identity = credential_identity(old_cookie)
    new_record = _persisted_account_record(normalize_doubao_cookie(new_cookie), weight, max_concurrency, disabled)
    records = _load_persisted_account_records()
    for index, existing in enumerate(records):
        identity = _persisted_record_identity(existing)
        if identity not in {old_identity, new_record["identity"]}:
            continue
        records[index] = {
            **existing,
            **new_record,
            "created_at": existing.get("created_at") or new_record["updated_at"],
        }
        _save_persisted_account_records(records)
        return index + 1
    return None


def _update_account_store_record(cookie: str, account: dict[str, Any]) -> Optional[int]:
    target_identity = credential_identity(cookie)
    if not target_identity:
        return None
    records = _load_persisted_account_records()
    for index, existing in enumerate(records):
        if _persisted_record_identity(existing) != target_identity:
            continue
        records[index] = {
            **existing,
            "weight": max(1, int(account.get("weight") or existing.get("weight") or 1)),
            "max_concurrency": max(
                1,
                int(account.get("max_concurrency") or existing.get("max_concurrency") or 1),
            ),
            "disabled": str(account.get("status") or "").lower() == "disabled",
            "updated_at": time.time(),
        }
        _save_persisted_account_records(records)
        return index + 1
    return None


def _account_index(index: int) -> int:
    if index < 0:
        raise HTTPException(status_code=400, detail="Account index must be non-negative.")
    return index


def _verification_snapshot_path(filename: str) -> Path:
    if Path(filename).name != filename or not filename.lower().endswith(".png"):
        raise HTTPException(status_code=404, detail="Verification snapshot not found.")
    path = (Path(settings.DOUBAO_VERIFICATION_SNAPSHOT_DIR) / filename).resolve()
    root = Path(settings.DOUBAO_VERIFICATION_SNAPSHOT_DIR).resolve()
    if root not in path.parents:
        raise HTTPException(status_code=404, detail="Verification snapshot not found.")
    if not path.is_file():
        raise HTTPException(status_code=404, detail="Verification snapshot not found.")
    return path


@router.get("/account-pool", response_class=JSONResponse)
async def account_pool_status():
    try:
        manager = _account_pool_manager()
    except HTTPException:
        return JSONResponse(
            content={
                "object": "account_pool",
                "enabled": False,
                "accounts": [],
                "browser_pool": PlaywrightManager().pool_snapshot(),
                "quota_refresh": _quota_refresh_status(),
            }
        )
    return JSONResponse(content=_account_pool_payload(manager))


@router.get("/account-pool/cookie-refresh", response_class=JSONResponse)
async def cookie_refresh_status():
    refresher = _cookie_refresher_getter()
    if not refresher:
        return JSONResponse(
            content={
                "object": "doubao_cookie_refresh_status",
                "enabled": False,
                "running": False,
                "last_error": "Cookie refresher is not initialized.",
            }
        )
    return JSONResponse(
        content={
            "object": "doubao_cookie_refresh_status",
            **refresher.status(),
        }
    )


@router.post("/account-pool/cookie-refresh", response_class=JSONResponse)
async def refresh_account_cookies(request: Request):
    refresher = _cookie_refresher_getter()
    if not refresher:
        raise HTTPException(status_code=503, detail="Cookie refresher is not initialized.")
    try:
        data = await request.json()
    except Exception:
        data = {}
    result = await refresher.refresh_all(
        reason=str(data.get("reason") or "manual"),
        force=_bool_value(data.get("force"), True),
    )
    return JSONResponse(content=result)


@router.patch("/account-pool", response_class=JSONResponse)
async def update_account_pool(request: Request):
    manager = _account_pool_manager()
    data = await request.json()
    snapshot = await manager.update_pool_config(
        global_concurrency=data.get("global_concurrency"),
        failure_threshold=data.get("failure_threshold"),
        cooldown_seconds=data.get("cooldown_seconds"),
        acquire_timeout=data.get("acquire_timeout"),
    )
    return JSONResponse(
        content={
            "object": "account_pool",
            "enabled": True,
            "browser_pool": PlaywrightManager().pool_snapshot(),
            "quota_refresh": _quota_refresh_status(),
            **snapshot,
        }
    )


@router.post("/account-pool/accounts", response_class=JSONResponse)
async def create_account(request: Request):
    data = _new_account_payload(await request.json())
    try:
        manager = _account_pool_manager()
    except HTTPException:
        manager = None

    if manager and manager.contains_credential(data["cookie"]):
        raise HTTPException(status_code=400, detail="Credential cookie already exists.")

    store_index = None
    if data["persist"]:
        try:
            store_index = _persist_account_to_store(
                data["cookie"],
                data["weight"],
                data["max_concurrency"],
                data["disabled"],
            )
        except (OSError, ValueError) as exc:
            raise HTTPException(status_code=500, detail=f"Unable to write account store: {exc}") from exc

    if manager is None:
        manager = CredentialManager(
            [data["cookie"]],
            weights=[data["weight"]],
            max_concurrency=[data["max_concurrency"]],
            disabled=[data["disabled"]],
            global_concurrency=settings.DOUBAO_ACCOUNT_GLOBAL_CONCURRENCY,
            failure_threshold=settings.DOUBAO_ACCOUNT_FAILURE_THRESHOLD,
            cooldown_seconds=settings.DOUBAO_ACCOUNT_COOLDOWN_SECONDS,
            acquire_timeout=settings.DOUBAO_ACCOUNT_ACQUIRE_TIMEOUT,
        )
        account = manager.snapshot()["accounts"][0]
    else:
        try:
            account = await manager.add_account(
                data["cookie"],
                weight=data["weight"],
                max_concurrency=data["max_concurrency"],
                disabled=data["disabled"],
            )
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

    browser_profile = await PlaywrightManager().register_account(data["cookie"])
    await _attach_video_provider_manager(manager)
    quota_refresh = None
    if not data["disabled"]:
        quota_refresh = await _refresh_registered_account_quota(manager, int(account["index"]))
    return JSONResponse(
        content=_account_pool_payload(
            manager,
            account=account,
            persisted=data["persist"],
            store_index=store_index,
            persist_path=str(_account_store_path()) if data["persist"] else None,
            env_index=None,
            browser_profile=browser_profile,
            quota_refresh_result=quota_refresh,
        )
    )


@router.post("/account-pool/accounts/bulk", response_class=JSONResponse)
async def create_accounts_bulk(request: Request):
    data = _bulk_account_payload(await request.json())
    try:
        manager = _account_pool_manager()
    except HTTPException:
        manager = None

    if manager is None:
        first = data["cookies"][0]
        manager = CredentialManager(
            [first],
            weights=[data["weight"]],
            max_concurrency=[data["max_concurrency"]],
            disabled=[data["disabled"]],
            global_concurrency=settings.DOUBAO_ACCOUNT_GLOBAL_CONCURRENCY,
            failure_threshold=settings.DOUBAO_ACCOUNT_FAILURE_THRESHOLD,
            cooldown_seconds=settings.DOUBAO_ACCOUNT_COOLDOWN_SECONDS,
            acquire_timeout=settings.DOUBAO_ACCOUNT_ACQUIRE_TIMEOUT,
        )
        pending = data["cookies"][1:]
        start_index = 1
        first_account = manager.snapshot()["accounts"][0]
        added = [{"account": first_account, "persisted": False, "store_index": None, "env_index": None}]
        skipped = []
        failed = []
        if data["persist"]:
            try:
                store_index = _persist_account_to_store(
                    first,
                    data["weight"],
                    data["max_concurrency"],
                    data["disabled"],
                )
                added[0]["persisted"] = True
                added[0]["store_index"] = store_index
                added[0]["persist_path"] = str(_account_store_path())
            except (OSError, ValueError) as exc:
                failed.append({"index": 0, "message": f"Unable to write account store: {exc}"})
        added[0]["browser_profile"] = await PlaywrightManager().register_account(first)
    else:
        pending = data["cookies"]
        start_index = 0
        added = []
        skipped = []
        failed = []

    for offset, cookie in enumerate(pending, start=start_index):
        if manager.contains_credential(cookie):
            skipped.append({"index": offset, "reason": "duplicate"})
            continue

        store_index = None
        persisted = False
        if data["persist"]:
            try:
                store_index = _persist_account_to_store(
                    cookie,
                    data["weight"],
                    data["max_concurrency"],
                    data["disabled"],
                )
                persisted = True
            except (OSError, ValueError) as exc:
                failed.append({"index": offset, "message": f"Unable to write account store: {exc}"})
                continue

        try:
            account = await manager.add_account(
                cookie,
                weight=data["weight"],
                max_concurrency=data["max_concurrency"],
                disabled=data["disabled"],
            )
            browser_profile = await PlaywrightManager().register_account(cookie)
            added.append(
                {
                    "account": account,
                    "persisted": persisted,
                    "store_index": store_index,
                    "persist_path": str(_account_store_path()) if persisted else None,
                    "env_index": None,
                    "browser_profile": browser_profile,
                }
            )
        except ValueError as exc:
            skipped.append({"index": offset, "reason": str(exc)})

    await _attach_video_provider_manager(manager)
    refreshable = [
        item
        for item in added
        if (item.get("account") or {}).get("status") not in {"disabled", "login_required"}
    ]
    refresh_results = await asyncio.gather(
        *(
            _refresh_registered_account_quota(manager, int(item["account"]["index"]))
            for item in refreshable
        )
    ) if refreshable else []
    for item, refresh_result in zip(refreshable, refresh_results):
        item["quota_refresh"] = refresh_result

    return JSONResponse(
        content=_account_pool_payload(
            manager,
            object_name="account_pool_bulk",
            added_count=len(added),
            skipped_count=len(skipped),
            failed_count=len(failed),
            added=added,
            skipped=skipped,
            failed=failed,
        )
    )


@router.patch("/account-pool/accounts/{index}", response_class=JSONResponse)
async def update_account(index: int, request: Request):
    manager = _account_pool_manager()
    data = await request.json()
    account_index = _account_index(index)
    try:
        cookie = await manager.get_cookie(account_index)
        account = await manager.update_account(
            account_index,
            weight=data.get("weight"),
            max_concurrency=data.get("max_concurrency"),
            disabled=data.get("disabled"),
        )
        store_index = _update_account_store_record(cookie, account)
    except IndexError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except OSError as exc:
        raise HTTPException(status_code=500, detail=f"Unable to write account store: {exc}") from exc
    return JSONResponse(content={"object": "account", "data": account, "store_index": store_index})


@router.delete("/account-pool/accounts/{index}", response_class=JSONResponse)
async def delete_account(index: int):
    manager = _account_pool_manager()
    try:
        cookie = await manager.get_cookie(_account_index(index))
        account = await manager.remove_account(_account_index(index))
        store_index = _remove_account_from_store(cookie)
        env_index = _remove_account_from_env(cookie)
        browser_profile_deleted = await PlaywrightManager().remove_account_profile(cookie)
    except IndexError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except RuntimeError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    except OSError as exc:
        raise HTTPException(status_code=500, detail=f"Unable to write account store: {exc}") from exc
    return JSONResponse(
        content=_account_pool_payload(
            manager,
            object_name="account_deleted",
            data=account,
            store_index=store_index,
            env_index=env_index,
            browser_profile_deleted=browser_profile_deleted,
        )
    )


@router.post("/account-pool/accounts/{index}/enable", response_class=JSONResponse)
async def enable_account(index: int):
    manager = _account_pool_manager()
    try:
        account = await manager.update_account(_account_index(index), disabled=False)
    except IndexError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    return JSONResponse(content={"object": "account", "data": account})


@router.post("/account-pool/accounts/{index}/disable", response_class=JSONResponse)
async def disable_account(index: int):
    manager = _account_pool_manager()
    try:
        account = await manager.update_account(_account_index(index), disabled=True)
    except IndexError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    return JSONResponse(content={"object": "account", "data": account})


@router.post("/account-pool/accounts/{index}/clear-cooldown", response_class=JSONResponse)
async def clear_account_cooldown(index: int):
    manager = _account_pool_manager()
    try:
        account = await manager.clear_cooldown(_account_index(index))
    except IndexError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    return JSONResponse(content={"object": "account", "data": account})


@router.post("/account-pool/accounts/{index}/reset-health", response_class=JSONResponse)
async def reset_account_health(index: int):
    manager = _account_pool_manager()
    try:
        account = await manager.reset_health(_account_index(index))
    except IndexError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    return JSONResponse(content={"object": "account", "data": account})


@router.post("/account-pool/accounts/{index}/health-check", response_class=JSONResponse)
async def check_account_health(index: int):
    manager = _account_pool_manager()
    try:
        result = await manager.health_check(_account_index(index))
    except IndexError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    return JSONResponse(content={"object": "account_health_check", "data": result})


@router.get("/account-pool/verification-snapshots/{filename}")
async def get_verification_snapshot(filename: str):
    return FileResponse(_verification_snapshot_path(filename), media_type="image/png")


@router.post("/account-pool/accounts/{index}/verification/start", response_class=JSONResponse)
async def start_account_verification(index: int, request: Request):
    manager = _account_pool_manager()
    account_index = _account_index(index)
    try:
        cookie = await manager.get_cookie(account_index)
    except IndexError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc

    try:
        data = await request.json()
    except Exception:
        data = {}
    verification = await _manual_verification.start(
        account_index,
        cookie,
        timeout_seconds=_positive_int(data.get("timeout_seconds"), 600, "timeout_seconds"),
        snapshot_interval_seconds=_positive_int(
            data.get("snapshot_interval_seconds"),
            3,
            "snapshot_interval_seconds",
        ),
        verification_context=(
            _public_account_snapshot(manager, account_index) or {}
        ).get("verification_context"),
    )
    verification = await _sync_manual_verification_account_state(manager, account_index, verification)
    verification = _verification_with_account_context(manager, account_index, verification)
    return JSONResponse(
        content=_account_pool_payload(
            manager,
            object_name="manual_verification_started",
            verification=verification,
        )
    )


@router.get("/account-pool/accounts/{index}/verification", response_class=JSONResponse)
async def account_verification_status(index: int):
    manager = _account_pool_manager()
    account_index = _account_index(index)
    try:
        await manager.get_cookie(account_index)
    except IndexError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    verification = await _manual_verification.status(account_index)
    verification = await _sync_manual_verification_account_state(manager, account_index, verification)
    return JSONResponse(content=_verification_with_account_context(manager, account_index, verification))


@router.get("/account-pool/accounts/{index}/context-template", response_class=JSONResponse)
async def account_context_template(index: int):
    manager = _account_pool_manager()
    account_index = _account_index(index)
    try:
        await manager.get_cookie(account_index)
    except IndexError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    template = load_latest_context_template(account_index)
    return JSONResponse(
        content={
            "object": "doubao_context_template",
            "account_index": account_index,
            "found": bool(template),
            "summary": context_summary_for_public(template),
            "template": template,
        }
    )


@router.post("/account-pool/accounts/{index}/verification/snapshot", response_class=JSONResponse)
async def capture_account_verification(index: int):
    manager = _account_pool_manager()
    account_index = _account_index(index)
    try:
        await manager.get_cookie(account_index)
    except IndexError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    verification = await _manual_verification.capture(account_index)
    verification = await _sync_manual_verification_account_state(manager, account_index, verification)
    return JSONResponse(content=_verification_with_account_context(manager, account_index, verification))


@router.post("/account-pool/accounts/{index}/verification/trigger", response_class=JSONResponse)
async def trigger_account_verification(index: int, request: Request):
    manager = _account_pool_manager()
    account_index = _account_index(index)
    try:
        await manager.get_cookie(account_index)
    except IndexError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    try:
        data = await request.json()
    except Exception:
        data = {}
    prompt = str(data.get("prompt") or "生成一个简单的产品展示短视频")
    mode = str(data.get("mode") or "video")
    image_path = data.get("image_path") or data.get("path")
    if image_path:
        verification = await _manual_verification.trigger(
            account_index,
            prompt,
            mode=mode,
            image_path=str(image_path),
        )
    else:
        verification = await _manual_verification.trigger(account_index, prompt, mode=mode)
    verification = await _sync_manual_verification_account_state(manager, account_index, verification)
    return JSONResponse(content=_verification_with_account_context(manager, account_index, verification))


@router.post("/account-pool/accounts/{index}/verification/render-challenge", response_class=JSONResponse)
async def render_account_verification_challenge(index: int, request: Request):
    manager = _account_pool_manager()
    account_index = _account_index(index)
    try:
        await manager.get_cookie(account_index)
    except IndexError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    try:
        data = await request.json()
    except Exception:
        data = {}
    account = _public_account_snapshot(manager, account_index) or {}
    context = data if isinstance(data, dict) and data else {}
    if not context:
        context = account.get("verification_context") if isinstance(account.get("verification_context"), dict) else {}
    verification = await _manual_verification.render_bdturing_challenge(account_index, context)
    verification = await _sync_manual_verification_account_state(manager, account_index, verification)
    return JSONResponse(content=_verification_with_account_context(manager, account_index, verification))


@router.post("/account-pool/accounts/{index}/verification/auto-verify", response_class=JSONResponse)
async def auto_account_verification(index: int, request: Request):
    manager = _account_pool_manager()
    account_index = _account_index(index)
    try:
        await manager.get_cookie(account_index)
    except IndexError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    try:
        data = await request.json()
    except Exception:
        data = {}
    account = _public_account_snapshot(manager, account_index) or {}
    context = account.get("verification_context") if isinstance(account.get("verification_context"), dict) else {}
    prompt = str(data.get("prompt") or "Generate a simple product showcase video.")
    mode = str(data.get("mode") or "video")
    image_path = data.get("image_path") or data.get("path")
    verification = await _manual_verification.auto_verify(
        account_index,
        context,
        prompt=prompt,
        mode=mode,
        image_path=str(image_path) if image_path else None,
        solve=_bool_value(data.get("solve"), True),
    )
    verification = await _sync_manual_verification_account_state(manager, account_index, verification)
    if _verification_completion_ready(verification):
        finished, _account, browser_profile, quota_refresh = await _finish_manual_verification(
            manager,
            account_index,
            verification,
        )
        finished["auto_completed"] = True
        if browser_profile is not None:
            finished["browser_profile"] = browser_profile
        if quota_refresh is not None:
            finished["quota_refresh_result"] = quota_refresh
        return JSONResponse(content=finished)
    verification = _verification_with_account_context(manager, account_index, verification)
    return JSONResponse(content=verification)


@router.post("/account-pool/accounts/{index}/verification/input", response_class=JSONResponse)
async def input_account_verification(index: int, request: Request):
    manager = _account_pool_manager()
    account_index = _account_index(index)
    try:
        await manager.get_cookie(account_index)
    except IndexError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    try:
        data = await request.json()
        verification = await _manual_verification.send_input(account_index, data)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    verification = await _sync_manual_verification_account_state(manager, account_index, verification)
    verification = _verification_with_account_context(manager, account_index, verification)
    return JSONResponse(content=verification)


@router.post("/account-pool/accounts/{index}/verification/solve-drag-captcha", response_class=JSONResponse)
async def solve_account_drag_captcha(index: int, request: Request):
    manager = _account_pool_manager()
    account_index = _account_index(index)
    try:
        await manager.get_cookie(account_index)
    except IndexError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    try:
        data = await request.json()
    except Exception:
        data = {}
    indices = data.get("indices")
    if not isinstance(indices, list):
        raise HTTPException(status_code=400, detail="indices must be a list of 1-based captcha image indexes.")
    cleaned: list[int] = []
    for item in indices:
        try:
            cleaned.append(int(item))
        except (TypeError, ValueError):
            continue
    verification = await _manual_verification.solve_drag_captcha(account_index, cleaned)
    verification = await _sync_manual_verification_account_state(manager, account_index, verification)
    verification = _verification_with_account_context(manager, account_index, verification)
    return JSONResponse(content=verification)


@router.post("/account-pool/accounts/{index}/verification/cancel", response_class=JSONResponse)
async def cancel_account_verification(index: int):
    manager = _account_pool_manager()
    account_index = _account_index(index)
    try:
        await manager.get_cookie(account_index)
    except IndexError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    verification = await _manual_verification.cancel(account_index)
    verification = _verification_with_account_context(manager, account_index, verification)
    return JSONResponse(
        content=_account_pool_payload(
            manager,
            object_name="manual_verification_cancelled",
            verification=verification,
        )
    )


@router.post("/account-pool/accounts/{index}/verification/complete", response_class=JSONResponse)
async def complete_account_verification(index: int):
    manager = _account_pool_manager()
    account_index = _account_index(index)
    try:
        await manager.get_cookie(account_index)
    except IndexError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc

    precheck = await _manual_verification.capture(account_index)
    precheck = await _sync_manual_verification_account_state(manager, account_index, precheck)
    precheck = _verification_with_account_context(manager, account_index, precheck)
    if precheck.get("login_required"):
        precheck["completion_blocked"] = True
        precheck["message"] = (
            "Manual verification is not complete: this Doubao page is not logged in. "
            "Click Login in the page, sign in, then click Done again."
        )
        return JSONResponse(
            content=_account_pool_payload(
                manager,
                object_name="manual_verification_pending",
                verification=precheck,
            )
        )
    if precheck.get("manual_success_required"):
        precheck["completion_blocked"] = True
        precheck["message"] = (
            "Manual verification is not complete: no visible challenge is rendered and no "
            "manual Doubao video generation success was observed in this browser page."
        )
        return JSONResponse(
            content=_account_pool_payload(
                manager,
                object_name="manual_verification_pending",
                verification=precheck,
            )
        )

    verification, account, browser_profile, quota_refresh = await _finish_manual_verification(
        manager,
        account_index,
        precheck,
    )
    return JSONResponse(
        content=_account_pool_payload(
            manager,
            object_name="manual_verification_completed",
            verification=verification,
            account=account,
            browser_profile=browser_profile,
            quota_refresh_result=quota_refresh,
        )
    )


@router.post("/account-pool/accounts/{index}/quota-refresh", response_class=JSONResponse)
async def refresh_account_quota(index: int):
    manager = _account_pool_manager()
    try:
        result = await _quota_refresh(manager, _account_index(index))
    except IndexError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    return JSONResponse(
        content=_account_pool_payload(
            manager,
            object_name="account_quota",
            data=result,
        )
    )


@router.post("/account-pool/quotas/refresh", response_class=JSONResponse)
async def refresh_all_account_quotas():
    manager = _account_pool_manager()
    video_provider = _video_provider_getter()
    refresh = getattr(video_provider, "refresh_video_quotas", None)
    if not callable(refresh) or getattr(video_provider, "credential_manager", None) is not manager:
        raise HTTPException(status_code=503, detail="Video quota history refresh is unavailable.")
    result = await refresh()
    return JSONResponse(
        content=_account_pool_payload(
            manager,
            object_name="account_quotas",
            data=result,
        )
    )
